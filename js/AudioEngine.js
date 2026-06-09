import { FFTAnalyzer } from './FFTAnalyzer.js';
import { AdaptiveEQ } from './AdaptiveEQ.js';
import { MaskingToneGenerator } from './MaskingToneGenerator.js';

/**
 * Central audio engine.
 *
 * Signal graph:
 *
 *   Microphone ──► AnalyserNode (noise analysis tap, silent – not routed to output)
 *
 *   OscillatorBank (masking tones) ──┐
 *   AudioFileSource ─► AdaptiveEQ ──►┼──► MasterGain ──► AudioContext.destination
 *                                    │                      (→ Bluetooth)
 *   MaskingToneGenerator.output ─────┘
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.analyzer = null;
    this.eq = null;
    this.masking = null;
    this.masterGain = null;
    this.audioSource = null; // for file playback

    this.isRunning = false;
    this.adaptiveEQEnabled = true;
    this.maskingEnabled = true;

    this._updateInterval = null;
    this.onMetricsUpdate = null; // callback(metrics)
  }

  async start() {
    // AudioContext must be created inside a user gesture on iOS Safari
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });

    // Request microphone (noise analysis only — not routed to output)
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // keep raw mic for accurate noise measurement
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    const micSource = this.ctx.createMediaStreamSource(this.micStream);

    this.analyzer = new FFTAnalyzer(this.ctx, 4096);
    micSource.connect(this.analyzer.node);
    // Mic is NOT connected to destination — analysis only

    this.eq = new AdaptiveEQ(this.ctx);
    this.masking = new MaskingToneGenerator(this.ctx);
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;

    this.masking.output.connect(this.masterGain);
    this.eq.output.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.isRunning = true;
    this._startUpdateLoop();
  }

  stop() {
    clearInterval(this._updateInterval);
    this.masking?.stopAll();
    this.micStream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.isRunning = false;
  }

  /** Load and play an audio file through the adaptive EQ chain. */
  async loadAudioFile(file) {
    if (!this.ctx) return;
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

    this.audioSource?.stop();
    this.audioSource = this.ctx.createBufferSource();
    this.audioSource.buffer = audioBuffer;
    this.audioSource.loop = true;
    this.audioSource.connect(this.eq.input);
    this.audioSource.start();
  }

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

  _startUpdateLoop() {
    this._updateInterval = setInterval(() => {
      if (!this.isRunning) return;

      this.analyzer.updateNoiseFloor();
      const spectrum = Array.from(this.analyzer.getSpectrum());
      const peaks = this.analyzer.findPeaks([50, 3000], 8);
      const bands = this._classifyNoise(peaks);

      const overall = spectrum.length
        ? spectrum.reduce((a, b) => a + b, 0) / spectrum.length
        : -120;

      if (this.adaptiveEQEnabled) this.eq.update(this.analyzer);
      if (this.maskingEnabled) this.masking.update(peaks.slice(0, 4), overall);

      this.onMetricsUpdate?.({
        spectrum,
        peaks,
        bands,
        overallDB: overall,
        eqGains: this.eq.getGains(),
      });
    }, 100);
  }

  _classifyNoise(peaks) {
    const bands = [];

    // Engine harmonics: peaks below 300 Hz with harmonic spacing
    const enginePeaks = peaks.filter(p => p.hz < 300);
    if (enginePeaks.length > 0) {
      bands.push({ label: '引擎', icon: '🚗', peaks: enginePeaks });
    }

    // Broadband road noise 200–1000 Hz
    const roadDB = this.analyzer.bandPower(200, 1000);
    if (roadDB > -55) {
      bands.push({ label: '路面/輪胎', icon: '🛞', db: roadDB, type: 'broadband' });
    }

    // Wind noise 500–2000 Hz
    const windDB = this.analyzer.bandPower(500, 2000);
    if (windDB > -50) {
      bands.push({ label: '風噪', icon: '💨', db: windDB, type: 'broadband' });
    }

    // Tonal HVAC/other
    const hvacPeaks = peaks.filter(p => p.hz >= 300 && p.hz < 2000 && p.prominence > 12);
    if (hvacPeaks.length > 0) {
      bands.push({ label: 'HVAC / 其他', icon: '🌀', peaks: hvacPeaks });
    }

    return bands;
  }
}
