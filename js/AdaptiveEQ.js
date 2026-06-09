/**
 * 10-band parametric EQ built from BiquadFilterNodes.
 * Bands are updated every ~100ms based on the noise profile from FFTAnalyzer.
 * Strategy: boost bands masked by noise so music emerges above the noise floor.
 */
export class AdaptiveEQ {
  static BANDS = [80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000];
  static MAX_BOOST_DB = 8;
  // Noise level above which boosting starts.
  // From debug display: band levels in quiet room are around -70 to -92 dBFS,
  // so threshold must be below -70 to trigger. Set to -80 for comfortable margin.
  static NOISE_THRESHOLD_DB = -80;

  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.filters = AdaptiveEQ.BANDS.map(freq => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.41;
      f.gain.value = 0;
      return f;
    });

    for (let i = 0; i < this.filters.length - 1; i++) {
      this.filters[i].connect(this.filters[i + 1]);
    }

    this.currentGains = new Array(AdaptiveEQ.BANDS.length).fill(0);
    this.smoothing = 0.15;

    // Fast-tracking smoothed spectrum used for EQ decisions.
    // Separate from noiseFloor (which is the long-term minimum used for
    // spectral subtraction and takes ~30s to rise — too slow for EQ control).
    this._smoothed = null;
    this._fastAlpha = 0.7; // 0.7 → reacts in ~3–4 frames (300–400 ms)
  }

  get input()  { return this.filters[0]; }
  get output() { return this.filters[this.filters.length - 1]; }

  /** Called from AudioEngine with the echo-cancelled clean spectrum. */
  updateFromSpectrum(cleanSpectrum, analyzer) {
    this._ingestFrame(cleanSpectrum, cleanSpectrum.length, analyzer.fftSize);
  }

  /** Legacy path: read directly from analyzer.dataBuffer. */
  update(analyzer) {
    this._ingestFrame(analyzer.dataBuffer, analyzer.binCount, analyzer.fftSize);
  }

  _ingestFrame(frame, binCount, fftSize) {
    // Initialise or update the fast-smoothed noise estimate
    if (!this._smoothed || this._smoothed.length !== binCount) {
      this._smoothed = new Float32Array(frame);
    } else {
      for (let b = 0; b < binCount; b++) {
        this._smoothed[b] = this._fastAlpha * this._smoothed[b]
                          + (1 - this._fastAlpha) * frame[b];
      }
    }

    const sampleRate = this.audioCtx.sampleRate;

    if (!this._bandLevels) this._bandLevels = new Array(AdaptiveEQ.BANDS.length).fill(-120);

    AdaptiveEQ.BANDS.forEach((centerHz, i) => {
      const loBin = Math.max(0, Math.round(((centerHz / 1.63) / sampleRate) * fftSize));
      const hiBin = Math.min(binCount - 1,  Math.round(((centerHz * 1.63) / sampleRate) * fftSize));

      let bandDB = -120;
      const len  = hiBin - loBin;
      if (len > 0) {
        let sum = 0;
        for (let b = loBin; b < hiBin; b++) sum += this._smoothed[b];
        bandDB = sum / len;
      }
      this._bandLevels[i] = bandDB;

      let targetGain = 0;
      if (bandDB > AdaptiveEQ.NOISE_THRESHOLD_DB) {
        const excess = bandDB - AdaptiveEQ.NOISE_THRESHOLD_DB;
        targetGain = Math.min(excess * 0.5, AdaptiveEQ.MAX_BOOST_DB);
      }

      this.currentGains[i] = this.smoothing * targetGain + (1 - this.smoothing) * this.currentGains[i];
      this.filters[i].gain.value = this.currentGains[i];
    });
  }

  reset() {
    this.currentGains.fill(0);
    this._smoothed   = null;
    this._bandLevels = null;
    this.filters.forEach(f => { f.gain.value = 0; });
  }

  getGains() {
    return AdaptiveEQ.BANDS.map((hz, i) => ({
      hz,
      gain:    this.currentGains[i],
      noiseDB: this._bandLevels?.[i] ?? -120,
    }));
  }
}
