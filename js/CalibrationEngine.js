/**
 * Self-calibration via near-ultrasonic log-sweep.
 *
 * Uses 16 kHz – 18 kHz — above most adults' audible range and barely
 * perceptible even in a quiet room.  iPhone speaker and microphone both
 * handle this range, so the echo-path timing and high-frequency response
 * are measured accurately.
 *
 * Trade-off: reliable correction is above ~14 kHz; low/mid-frequency
 * (80 Hz – 8 kHz) uses extrapolated shape, which is approximate but good
 * enough — the echo-path delay (most critical parameter) is
 * frequency-independent at typical car/room distances.
 *
 * NOTE: echoCancellation must be OFF during calibration (caller's responsibility)
 * so the sweep is not cancelled before we can measure it.
 */
export class CalibrationEngine {
  static F_LOW       = 16000; // Hz — near top of audible range for most adults
  static F_HIGH      = 18000; // Hz — within iPhone speaker/mic response
  static DURATION    = 2.0;   // seconds — shorter since narrow band needs less time
  static PLAY_GAIN   = 0.04;  // very quiet: –28 dBFS, barely audible even up close
  static SMOOTH_BINS = 11;    // moving-average half-window (bins)
  static CLIP_DB     = 15;    // max correction magnitude

  constructor(audioCtx, fftSize = 4096) {
    this.audioCtx  = audioCtx;
    this.fftSize   = fftSize;
    this.binCount  = fftSize / 2;
    this.correctionDB = new Float32Array(this.binCount); // zero = no correction
    this.isCalibrated = false;
  }

  // ── Sweep generation ───────────────────────────────────────────────────────

  _buildSweepBuffer() {
    const { F_LOW: f1, F_HIGH: f2, DURATION: T } = CalibrationEngine;
    const sr = this.audioCtx.sampleRate;
    const N  = Math.round(T * sr);
    const buf = this.audioCtx.createBuffer(1, N, sr);
    const d   = buf.getChannelData(0);

    // Log chirp: φ(t) = 2π·f1·(T/ln(f2/f1))·(e^(t·ln(f2/f1)/T) - 1)
    const lnRatio = Math.log(f2 / f1);
    const K = T / lnRatio;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * f1 * K * (Math.exp(t * lnRatio / T) - 1));
    }

    // 50 ms cosine fade-in / fade-out to avoid clicks
    const fade = Math.round(0.05 * sr);
    for (let i = 0; i < fade; i++) {
      const w = 0.5 * (1 - Math.cos(Math.PI * i / fade));
      d[i]         *= w;
      d[N - 1 - i] *= w;
    }
    return buf;
  }

  /** Ideal dB spectrum for the sweep (flat between F_LOW and F_HIGH). */
  _idealSpectrum() {
    const ref   = new Float32Array(this.binCount).fill(-80);
    const sr    = this.audioCtx.sampleRate;
    const loBin = Math.round((CalibrationEngine.F_LOW  / sr) * this.fftSize);
    const hiBin = Math.round((CalibrationEngine.F_HIGH / sr) * this.fftSize);
    for (let b = loBin; b <= hiBin && b < this.binCount; b++) ref[b] = -15;
    return ref;
  }

  // ── Main calibration routine ───────────────────────────────────────────────

  /**
   * @param {AnalyserNode} analyserNode  – mic analyser (echoCancellation must be OFF)
   * @param {AudioNode}    outputDest    – where to connect the sweep playback
   * @param {function}     onProgress    – called with 0..1 during measurement
   */
  async run(analyserNode, outputDest, onProgress) {
    const sweepBuf = this._buildSweepBuffer();

    // Disable smoothing during measurement for crisp snapshots
    const prevSmoothing = analyserNode.smoothingTimeConstant;
    analyserNode.smoothingTimeConstant = 0;

    // Snapshot baseline (background noise before sweep starts)
    this.baselineSpectrum = new Float32Array(this.binCount);
    analyserNode.getFloatFrequencyData(this.baselineSpectrum);

    // Collect mic FFT frames at 80 ms intervals while the sweep plays
    const frames = [];
    const collectId = setInterval(() => {
      const frame = new Float32Array(this.binCount);
      analyserNode.getFloatFrequencyData(frame);
      frames.push(frame);
      onProgress?.(Math.min(frames.length / (CalibrationEngine.DURATION * 12.5), 0.95));
    }, 80);

    // Play the sweep
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = CalibrationEngine.PLAY_GAIN;
    gainNode.connect(outputDest);
    const src = this.audioCtx.createBufferSource();
    src.buffer = sweepBuf;
    src.connect(gainNode);

    await new Promise(resolve => { src.onended = resolve; src.start(); });

    clearInterval(collectId);
    gainNode.disconnect();
    analyserNode.smoothingTimeConstant = prevSmoothing;

    if (frames.length < 4) throw new Error('錄音太短，請確認麥克風正常後再試');

    // Average the middle 70 % of frames (skip transients at start/end)
    const skip = Math.floor(frames.length * 0.15);
    const usable = frames.slice(skip, frames.length - skip);

    const avgMic = new Float32Array(this.binCount);
    for (const f of usable)
      for (let b = 0; b < this.binCount; b++) avgMic[b] += f[b];
    for (let b = 0; b < this.binCount; b++) avgMic[b] /= usable.length;

    // raw correction = ideal - measured
    const ideal = this._idealSpectrum();
    const raw   = ideal.map((v, b) => v - avgMic[b]);

    // Moving-average smooth then clip
    const W = CalibrationEngine.SMOOTH_BINS;
    for (let b = 0; b < this.binCount; b++) {
      let sum = 0, cnt = 0;
      for (let k = Math.max(0, b - W); k <= Math.min(this.binCount - 1, b + W); k++) {
        sum += raw[k]; cnt++;
      }
      const c = sum / cnt;
      this.correctionDB[b] = Math.max(-CalibrationEngine.CLIP_DB,
                                       Math.min( CalibrationEngine.CLIP_DB, c));
    }

    // Only keep correction inside the actual sweep band.
    // Outside the band the "ideal" is silence (-80 dBFS), so the correction
    // formula would compute a large NEGATIVE offset that unfairly penalises
    // mid-frequency noise measurements used by the adaptive EQ.
    const sr     = this.audioCtx.sampleRate;
    const loBand = Math.round((CalibrationEngine.F_LOW  / sr) * this.fftSize);
    const hiBand = Math.round((CalibrationEngine.F_HIGH / sr) * this.fftSize);
    for (let b = 0; b < this.binCount; b++) {
      if (b < loBand || b > hiBand) this.correctionDB[b] = 0;
    }

    this.isCalibrated = true;
    onProgress?.(1);
  }

  /** Apply stored correction to a Float32Array of dB values (in place copy). */
  apply(spectrumDB) {
    if (!this.isCalibrated) return spectrumDB;
    const out = new Float32Array(spectrumDB.length);
    for (let b = 0; b < out.length; b++) out[b] = spectrumDB[b] + this.correctionDB[b];
    return out;
  }
}
