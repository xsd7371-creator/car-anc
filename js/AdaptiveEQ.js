/**
 * 10-band parametric EQ built from BiquadFilterNodes.
 * Bands are updated every ~100ms based on the noise profile from FFTAnalyzer.
 * Strategy: boost bands masked by noise so music emerges above the noise floor.
 */
export class AdaptiveEQ {
  // Log-spaced frequencies covering car noise range (80Hz – 5kHz)
  static BANDS = [80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000];
  static MAX_BOOST_DB = 8;
  static NOISE_THRESHOLD_DB = -50; // below this, band is considered quiet → no boost

  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.filters = AdaptiveEQ.BANDS.map(freq => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.41; // ~1 octave
      f.gain.value = 0;
      return f;
    });

    // Chain filters in series
    for (let i = 0; i < this.filters.length - 1; i++) {
      this.filters[i].connect(this.filters[i + 1]);
    }

    this.currentGains = new Array(AdaptiveEQ.BANDS.length).fill(0);
    this.smoothing = 0.12; // per-update smoothing coefficient
  }

  get input() { return this.filters[0]; }
  get output() { return this.filters[this.filters.length - 1]; }

  /**
   * Update EQ gains based on current FFT noise spectrum.
   * @param {FFTAnalyzer} analyzer
   */
  update(analyzer) {
    const sampleRate = this.audioCtx.sampleRate;
    const fftSize = analyzer.fftSize;

    AdaptiveEQ.BANDS.forEach((centerHz, i) => {
      // Sample noise power in ±0.7 octave around band center
      const loBin = Math.max(0, Math.round(((centerHz / 1.63) / sampleRate) * fftSize));
      const hiBin = Math.min(analyzer.binCount - 1, Math.round(((centerHz * 1.63) / sampleRate) * fftSize));

      let bandNoiseDB = -120;
      const slice = analyzer.noiseFloor.slice(loBin, hiBin);
      if (slice.length > 0) {
        bandNoiseDB = slice.reduce((a, b) => a + b, 0) / slice.length;
      }

      let targetGain = 0;
      if (bandNoiseDB > AdaptiveEQ.NOISE_THRESHOLD_DB) {
        const excess = bandNoiseDB - AdaptiveEQ.NOISE_THRESHOLD_DB;
        // Psychoacoustic boost: ~0.35 dB per 1 dB excess noise
        targetGain = Math.min(excess * 0.35, AdaptiveEQ.MAX_BOOST_DB);
      }

      // Exponential smoothing to prevent audible zipper noise
      this.currentGains[i] = this.smoothing * targetGain + (1 - this.smoothing) * this.currentGains[i];
      this.filters[i].gain.value = this.currentGains[i];
    });
  }

  reset() {
    this.currentGains.fill(0);
    this.filters.forEach(f => { f.gain.value = 0; });
  }

  getGains() {
    return AdaptiveEQ.BANDS.map((hz, i) => ({ hz, gain: this.currentGains[i] }));
  }
}
