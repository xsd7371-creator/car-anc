/**
 * Wraps AnalyserNode to provide:
 *  - Smoothed power spectrum (dB)
 *  - Dominant peak detection
 *  - Noise floor estimation via running minimum
 */
export class FFTAnalyzer {
  constructor(audioCtx, fftSize = 4096) {
    this.audioCtx = audioCtx;
    this.fftSize = fftSize;

    this.node = audioCtx.createAnalyser();
    this.node.fftSize = fftSize;
    this.node.smoothingTimeConstant = 0.75;

    this.binCount = this.node.frequencyBinCount; // fftSize / 2
    this.dataBuffer = new Float32Array(this.binCount);

    // Running noise floor: min over last N frames per bin
    this.noiseFloor = new Float32Array(this.binCount).fill(-120);
    this.floorAlpha = 0.995; // slow decay → conservative noise floor
  }

  /** Returns dBFS spectrum (Float32Array, length = fftSize/2). */
  getSpectrum() {
    this.node.getFloatFrequencyData(this.dataBuffer);
    return this.dataBuffer;
  }

  /** Update and return smoothed noise floor estimate. */
  updateNoiseFloor() {
    const spec = this.getSpectrum();
    for (let i = 0; i < this.binCount; i++) {
      const db = spec[i];
      if (db < this.noiseFloor[i]) {
        this.noiseFloor[i] = db; // instant track-down
      } else {
        this.noiseFloor[i] = this.floorAlpha * this.noiseFloor[i] + (1 - this.floorAlpha) * db;
      }
    }
    return this.noiseFloor;
  }

  /** Convert bin index → Hz. */
  binToHz(bin) {
    return (bin * this.audioCtx.sampleRate) / this.fftSize;
  }

  /**
   * Find peaks above noiseFloor + minProminenceDB within freqRange.
   * Returns array of { hz, db, prominence }.
   */
  findPeaks(freqRange = [50, 4000], minProminenceDB = 8) {
    const spec = this.dataBuffer;
    const floor = this.noiseFloor;
    const sampleRate = this.audioCtx.sampleRate;

    const loBin = Math.floor((freqRange[0] / sampleRate) * this.fftSize);
    const hiBin = Math.ceil((freqRange[1] / sampleRate) * this.fftSize);

    const peaks = [];
    for (let i = loBin + 1; i < hiBin - 1; i++) {
      if (spec[i] > spec[i - 1] && spec[i] > spec[i + 1]) {
        const prominence = spec[i] - floor[i];
        if (prominence >= minProminenceDB) {
          peaks.push({ hz: this.binToHz(i), db: spec[i], prominence });
        }
      }
    }
    return peaks.sort((a, b) => b.prominence - a.prominence);
  }

  /** Average dB power in a frequency band. */
  bandPower(loHz, hiHz) {
    const sampleRate = this.audioCtx.sampleRate;
    const loBin = Math.floor((loHz / sampleRate) * this.fftSize);
    const hiBin = Math.ceil((hiHz / sampleRate) * this.fftSize);
    let sum = 0;
    const count = hiBin - loBin;
    if (count <= 0) return -120;
    for (let i = loBin; i < hiBin; i++) sum += this.dataBuffer[i];
    return sum / count;
  }
}
