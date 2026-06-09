import { FFTAnalyzer }          from './FFTAnalyzer.js';
import { AdaptiveEQ }           from './AdaptiveEQ.js';
import { MaskingToneGenerator } from './MaskingToneGenerator.js';
import { CalibrationEngine }    from './CalibrationEngine.js';
import { Verification }         from './Verification.js';

/**
 * Signal graph
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  Microphone ──► micAnalyser (noise analysis tap — NOT routed to output)
 *
 *  OscillatorBank (masking tones) ─────────────────────────────┐
 *  AudioFileSource ──► AdaptiveEQ ──► outputAnalyser (ref tap) ─┤
 *                                                               ▼
 *                                                        MasterGain ──► destination (BT/AirPlay)
 *
 * Echo-cancellation strategy
 * ──────────────────────────
 *  • During calibration : echoCancellation = OFF  (need raw mic to measure sweep)
 *  • Normal / music mode: echoCancellation = ON   (iOS/browser AEC removes speaker bleed)
 *  • Our own output (masking tones + loaded audio) is also monitored via outputAnalyser.
 *    The update loop subtracts its power from the mic spectrum before noise estimation,
 *    catching any residual echo the AEC might miss at low frequencies.
 */
export class AudioEngine {
  constructor() {
    this.ctx           = null;
    this.micStream     = null;
    this.analyzer      = null;   // FFTAnalyzer — mic
    this.outputAnalyser = null;  // AnalyserNode — our own output (reference for echo subtraction)
    this.eq            = null;
    this.masking       = null;
    this.masterGain    = null;
    this.audioSource   = null;
    this.calibration   = null;

    this.isRunning          = false;
    this.adaptiveEQEnabled  = true;
    this.maskingEnabled     = true;
    this.musicPlaying       = false;   // true when audio file is loaded & playing

    this._updateInterval = null;
    this.onMetricsUpdate = null;  // callback(metrics)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the engine.
   * @param {'normal'|'calibration'} mode
   *   normal       – AEC ON, ready for regular use
   *   calibration  – AEC OFF, used during the sweep measurement
   */
  async start(mode = 'normal') {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    await this._startMic(mode === 'calibration');
    this._buildGraph();
    this.calibration = new CalibrationEngine(this.ctx, 4096);
    this.isRunning   = true;
    if (mode === 'normal') this._startUpdateLoop();
  }

  stop() {
    clearInterval(this._updateInterval);
    this.masking?.stopAll();
    this.audioSource?.stop();
    this.micStream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.isRunning = false;
  }

  // ── Calibration ────────────────────────────────────────────────────────────

  /**
   * Run self-calibration:
   *   1. Restart mic with AEC OFF
   *   2. Play sweep + measure
   *   3. Restart mic with AEC ON
   *   4. Resume normal update loop
   */
  async calibrate(onProgress) {
    clearInterval(this._updateInterval);

    // Step 1: restart mic without AEC so we can hear the sweep
    this.micStream?.getTracks().forEach(t => t.stop());
    await this._startMic(/* aecOff= */ true);
    this._reconnectMic();

    onProgress?.({ phase: 'measuring', value: 0 });

    // Step 2: run sweep
    await this.calibration.run(
      this.analyzer.node,
      this.ctx.destination,
      v => onProgress?.({ phase: 'measuring', value: v })
    );

    onProgress?.({ phase: 'switching', value: 1 });

    // Step 3: restart mic with AEC ON for normal operation
    this.micStream?.getTracks().forEach(t => t.stop());
    await this._startMic(/* aecOff= */ false);
    this._reconnectMic();

    // Step 4: evaluate calibration quality using baseline captured before sweep
    const quality = Verification.calibrationQuality(
      this.analyzer,
      this.calibration.baselineSpectrum
    );

    // Step 5: resume
    this._startUpdateLoop();
    onProgress?.({ phase: 'done', value: 1, quality });
  }

  /** Play an audible test tone through the audio output (HomePod / BT). */
  async playTestTone(hz = 440) {
    if (!this.ctx) throw new Error('請先開始降噪');
    await Verification.playTestTone(this.ctx, this.masterGain, hz, 1.5);
  }

  /** A/B compare: disable processing for `duration` seconds then restore. */
  async abCompare(duration = 2, onToggle) {
    await Verification.abCompare(this, duration, onToggle);
  }

  // ── Pink noise generator ────────────────────────────────────────────────────

  /**
   * Toggle built-in pink noise through the adaptive EQ chain.
   * Pink noise has equal energy per octave — ideal for hearing EQ changes.
   */
  togglePinkNoise(enable) {
    if (!this.ctx) return;

    if (!enable) {
      this._pinkSource?.stop();
      this._pinkSource = null;
      this.musicPlaying = false;
      return;
    }

    // Generate 2-second looping pink noise buffer via Voss-McCartney algorithm
    const sr     = this.ctx.sampleRate;
    const frames = sr * 2;
    const buf    = this.ctx.createBuffer(1, frames, sr);
    const data   = buf.getChannelData(0);

    // 8-row Voss-McCartney pink noise
    const rows = new Float32Array(8);
    let runningSum = 0;
    for (let i = 0; i < frames; i++) {
      const rnd = Math.random() * 2 - 1;
      const bit = i & -i; // lowest set bit — which row to update
      const row = Math.min(Math.log2(bit), 7);
      runningSum -= rows[row];
      rows[row]   = rnd;
      runningSum += rnd;
      data[i]     = runningSum / 8;
    }

    // Normalise to -18 dBFS
    let peak = 0;
    for (let i = 0; i < frames; i++) if (Math.abs(data[i]) > peak) peak = Math.abs(data[i]);
    const target = 0.126; // -18 dBFS
    for (let i = 0; i < frames; i++) data[i] *= target / (peak || 1);

    this._pinkSource = this.ctx.createBufferSource();
    this._pinkSource.buffer = buf;
    this._pinkSource.loop   = true;
    this._pinkSource.connect(this.eq.input);
    this._pinkSource.start();
    this.musicPlaying = true;
  }

  // ── Audio file ──────────────────────────────────────────────────────────────

  async loadAudioFile(file) {
    if (!this.ctx) return;
    const ab  = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);

    this.audioSource?.stop();
    this.audioSource = this.ctx.createBufferSource();
    this.audioSource.buffer = buf;
    this.audioSource.loop   = true;
    this.audioSource.connect(this.eq.input);
    this.audioSource.start();
    this.musicPlaying = true;
  }

  stopAudio() {
    this.audioSource?.stop();
    this.audioSource  = null;
    this.musicPlaying = false;
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  setAdaptiveEQ(enabled) {
    this.adaptiveEQEnabled = enabled;
    if (!enabled) this.eq?.reset();
  }

  setMasking(enabled) {
    this.maskingEnabled = enabled;
    this.masking?.setEnabled(enabled);
  }

  setMasterVolume(linear) {
    if (this.masterGain) this.masterGain.gain.value = linear;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  async _startMic(aecOff) {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  !aecOff,  // OFF during calibration, ON otherwise
        noiseSuppression:  false,    // we handle noise ourselves
        autoGainControl:   false,
      }
    });
  }

  _buildGraph() {
    this.eq          = new AdaptiveEQ(this.ctx);
    this.masking     = new MaskingToneGenerator(this.ctx);
    this.masterGain  = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;

    // Output reference tap — monitors what we're actually sending to the speakers
    this.outputAnalyser = this.ctx.createAnalyser();
    this.outputAnalyser.fftSize = 4096;
    this.outputAnalyser.smoothingTimeConstant = 0.6;

    this.masking.output.connect(this.masterGain);
    this.eq.output.connect(this.masterGain);
    this.masterGain.connect(this.outputAnalyser);
    this.masterGain.connect(this.ctx.destination);

    // Mic analyser (analysis only — not routed to output)
    this.analyzer = new FFTAnalyzer(this.ctx, 4096);
    this._reconnectMic();
  }

  _reconnectMic() {
    // Disconnect previous mic source if any
    try { this._micSource?.disconnect(); } catch (_) {}
    this._micSource = this.ctx.createMediaStreamSource(this.micStream);
    this._micSource.connect(this.analyzer.node);
  }

  _startUpdateLoop() {
    clearInterval(this._updateInterval);
    this._updateInterval = setInterval(() => {
      if (!this.isRunning) return;

      this.analyzer.updateNoiseFloor();

      // Raw mic spectrum (dB) — calibration-corrected if available
      let rawSpectrum = Array.from(this.analyzer.getSpectrum());
      if (this.calibration?.isCalibrated) {
        rawSpectrum = Array.from(this.calibration.apply(new Float32Array(rawSpectrum)));
      }

      // Frequency-domain echo subtraction for our own output
      // Subtracts any energy our app is playing back from the noise estimate
      const echoSpectrum = new Float32Array(this.outputAnalyser.frequencyBinCount);
      this.outputAnalyser.getFloatFrequencyData(echoSpectrum);
      const cleanSpectrum = rawSpectrum.map((db, b) => {
        const echo = echoSpectrum[b];
        // Only subtract if our output is meaningful at this bin (> -55 dBFS)
        // and we're not in music mode (AEC already handles most of that)
        if (!this.musicPlaying && echo > -55) {
          // Conservative: reduce by the amount our output exceeds the noise
          const excess = echo - db;
          return excess > 0 ? db : db + excess * 0.5;
        }
        return db;
      });

      // Update noise floor with the echo-cancelled spectrum
      // (temporarily swap the buffer so updateNoiseFloor uses clean data)
      const tempBuf = this.analyzer.dataBuffer;
      this.analyzer.dataBuffer = new Float32Array(cleanSpectrum);
      const peaks = this.analyzer.findPeaks([50, 3000], 8);
      const bands = this._classifyNoise(peaks, cleanSpectrum);
      this.analyzer.dataBuffer = tempBuf;

      // Compute overall level only across the audible noise range (50–8000 Hz).
      // Averaging all 2048 bins drags the result toward -120 dBFS because most
      // high-frequency bins are silent, making the masking threshold unreachable.
      const sr       = this.ctx.sampleRate;
      const fftSize  = this.analyzer.fftSize;
      const loNoise  = Math.round((50   / sr) * fftSize);
      const hiNoise  = Math.round((8000 / sr) * fftSize);
      let noiseSum = 0, noiseCount = 0;
      for (let b = loNoise; b <= hiNoise && b < cleanSpectrum.length; b++) {
        noiseSum += cleanSpectrum[b]; noiseCount++;
      }
      const overall = noiseCount > 0 ? noiseSum / noiseCount : -120;

      // Pass cleanSpectrum directly so EQ reads echo-cancelled current levels,
      // not the raw dataBuffer (which is swapped back to pre-echo-cancel state above).
      if (this.adaptiveEQEnabled) this.eq.updateFromSpectrum(new Float32Array(cleanSpectrum), this.analyzer);
      if (this.maskingEnabled)    this.masking.update(peaks.slice(0, 4), overall);

      this.onMetricsUpdate?.({
        spectrum:  cleanSpectrum,
        peaks,
        bands,
        overallDB: overall,
        eqGains:   this.eq.getGains(),
        calibrated: !!this.calibration?.isCalibrated,
        musicMode:  this.musicPlaying,
      });
    }, 100);
  }

  _classifyNoise(peaks, spectrum) {
    const bands = [];

    const enginePeaks = peaks.filter(p => p.hz < 300);
    if (enginePeaks.length) bands.push({ label: '引擎', icon: '🚗', peaks: enginePeaks });

    const roadDB = this.analyzer.bandPower(200, 1000);
    if (roadDB > -55) bands.push({ label: '路面/輪胎', icon: '🛞', db: roadDB, type: 'broadband' });

    const windDB = this.analyzer.bandPower(500, 2000);
    if (windDB > -50) bands.push({ label: '風噪', icon: '💨', db: windDB, type: 'broadband' });

    const hvacPeaks = peaks.filter(p => p.hz >= 300 && p.hz < 2000 && p.prominence > 12);
    if (hvacPeaks.length) bands.push({ label: 'HVAC / 其他', icon: '🌀', peaks: hvacPeaks });

    return bands;
  }
}
