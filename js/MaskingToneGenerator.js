/**
 * Generates low-level masking tones at detected engine/HVAC frequencies.
 * These tones blend into the audio output and reduce the subjective prominence
 * of tonal noise components (engine harmonics, HVAC hum) via auditory masking.
 *
 * Each active tone is a sine wave slightly detuned from the noise peak,
 * which causes the brain to group them perceptually with the noise and
 * reduces its annoyance factor without outright destructive interference
 * (which BT latency makes impossible for true ANC).
 */
export class MaskingToneGenerator {
  static MAX_TONES = 3;
  static MASKING_LEVEL_DB = -42; // kept very low; only meaningful in loud car environment
  // Only activate when overall noise is loud enough (car-level noise ~= above -38 dBFS average)
  static ACTIVATION_THRESHOLD_DB = -38;
  // Only track peaks with high prominence — avoids reacting to broadband rain/ambient noise
  static MIN_PROMINENCE_DB = 18;

  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.tones = []; // { osc, gain, hz }
    this.masterGain = audioCtx.createGain();
    this.masterGain.gain.value = this._dbToLinear(MaskingToneGenerator.MASKING_LEVEL_DB);
  }

  get output() { return this.masterGain; }

  /**
   * Update active tones to match detected noise peaks.
   * @param {Array<{hz, db, prominence}>} peaks - from FFTAnalyzer.findPeaks()
   * @param {number} overallDB - average spectrum level; tones suppressed in quiet environments
   */
  update(peaks, overallDB = -120) {
    // Silence all tones when environment is too quiet (not a car)
    if (overallDB < MaskingToneGenerator.ACTIVATION_THRESHOLD_DB) {
      this._silenceAll();
      return;
    }

    // Only use peaks prominent enough to be true tonal noise (not rain/ambient)
    const qualifiedPeaks = peaks.filter(p => p.prominence >= MaskingToneGenerator.MIN_PROMINENCE_DB);

    const targetFreqs = qualifiedPeaks
      .slice(0, MaskingToneGenerator.MAX_TONES)
      .map(p => p.hz);

    // Remove tones that are no longer needed
    this.tones = this.tones.filter(t => {
      const stillNeeded = targetFreqs.some(hz => Math.abs(hz - t.hz) < 20);
      if (!stillNeeded) {
        t.gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.1);
        setTimeout(() => { try { t.osc.stop(); } catch (_) {} }, 300);
      }
      return stillNeeded;
    });

    // Add new tones for newly detected peaks
    const existingFreqs = this.tones.map(t => t.hz);
    for (const hz of targetFreqs) {
      if (existingFreqs.some(f => Math.abs(f - hz) < 20)) continue;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.value = 0;

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start();

      // Fade in
      gain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.2);
      this.tones.push({ osc, gain, hz });
    }
  }

  _silenceAll() {
    this.tones = this.tones.filter(t => {
      t.gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.15);
      setTimeout(() => { try { t.osc.stop(); } catch (_) {} }, 500);
      return false;
    });
  }

  setEnabled(enabled) {
    this.masterGain.gain.setTargetAtTime(
      enabled ? this._dbToLinear(MaskingToneGenerator.MASKING_LEVEL_DB) : 0,
      this.audioCtx.currentTime, 0.1
    );
  }

  stopAll() {
    this.tones.forEach(t => {
      t.gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.05);
      setTimeout(() => { try { t.osc.stop(); } catch (_) {} }, 200);
    });
    this.tones = [];
  }

  _dbToLinear(db) {
    return Math.pow(10, db / 20);
  }
}
