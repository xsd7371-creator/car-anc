/**
 * Verification utilities — lets the user confirm each feature is working.
 *
 *  1. calibrationQuality(analyzer, beforeSpectrum)
 *     After calibration, compare the mic spectrum during the sweep against
 *     a baseline taken before.  Returns a 0–100 quality score and a verdict.
 *
 *  2. playTestTone(audioCtx, destination, hz, durationSec)
 *     Plays an audible tone through the audio graph so the user can confirm
 *     the output path (HomePod / BT speaker) is active.
 *
 *  3. abCompare(engine, durationSec, onToggle)
 *     Disables all processing for `durationSec` then re-enables it, calling
 *     onToggle(active) each time so the UI can show the state.
 */
export class Verification {

  // ── 1. Calibration quality ──────────────────────────────────────────────────

  /**
   * Measure how much signal the mic received in the calibration band.
   * @param {FFTAnalyzer} analyzer
   * @param {Float32Array} baselineSpectrum  – dB spectrum captured before the sweep
   * @returns {{ score: number, verdict: string, detail: string }}
   */
  static calibrationQuality(analyzer, baselineSpectrum) {
    const sampleRate = analyzer.audioCtx.sampleRate;
    const fftSize    = analyzer.fftSize;

    // Bins corresponding to 16–18 kHz
    const loBin = Math.round((16000 / sampleRate) * fftSize);
    const hiBin = Math.round((18000 / sampleRate) * fftSize);

    const currentSpectrum = new Float32Array(analyzer.binCount);
    analyzer.node.getFloatFrequencyData(currentSpectrum);

    let baselineAvg = 0, currentAvg = 0, count = 0;
    for (let b = loBin; b < hiBin && b < analyzer.binCount; b++) {
      baselineAvg += baselineSpectrum[b];
      currentAvg  += currentSpectrum[b];
      count++;
    }
    if (count === 0) return { score: 0, verdict: '❌ 無法量測', detail: 'FFT bin 範圍無效' };

    baselineAvg /= count;
    currentAvg  /= count;

    const snrDB = currentAvg - baselineAvg; // how much louder the sweep was vs background

    let score, verdict, detail;
    if (snrDB >= 15) {
      score   = 100;
      verdict = '✅ 校正優良';
      detail  = `麥克風在 16–18 kHz 收到比背景音高 ${snrDB.toFixed(1)} dB 的掃頻訊號`;
    } else if (snrDB >= 8) {
      score   = Math.round((snrDB / 15) * 100);
      verdict = '⚠️ 校正尚可';
      detail  = `訊雜比 ${snrDB.toFixed(1)} dB，可用但建議靠近喇叭再校一次`;
    } else if (snrDB >= 3) {
      score   = Math.round((snrDB / 15) * 100);
      verdict = '⚠️ 訊號微弱';
      detail  = `僅 ${snrDB.toFixed(1)} dB，請靠近喇叭或提高系統音量後重新校正`;
    } else {
      score   = 0;
      verdict = '❌ 校正無效';
      detail  = `麥克風幾乎未收到掃頻音（${snrDB.toFixed(1)} dB），請確認喇叭有聲音`;
    }

    return { score, verdict, detail, snrDB };
  }

  // ── 2. Test tone ────────────────────────────────────────────────────────────

  /**
   * Play an audible test tone through the given destination node.
   * The user should hear this from the car/HomePod speakers.
   * @param {AudioContext} ctx
   * @param {AudioNode}    destination
   * @param {number}       hz        – default 440 (A4)
   * @param {number}       duration  – seconds
   */
  static playTestTone(ctx, destination, hz = 440, duration = 1.5) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type            = 'sine';
    osc.frequency.value = hz;
    gain.gain.value     = 0;

    osc.connect(gain);
    gain.connect(destination);
    osc.start();

    // Fade in → sustain → fade out
    const now = ctx.currentTime;
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gain.gain.setValueAtTime(0.18, now + duration - 0.1);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    return new Promise(resolve => {
      setTimeout(() => {
        try { osc.stop(); } catch (_) {}
        resolve();
      }, duration * 1000 + 50);
    });
  }

  // ── 3. A/B compare ─────────────────────────────────────────────────────────

  /**
   * Temporarily disable processing → wait → re-enable.
   * Lets the user hear the audible difference.
   * @param {AudioEngine}   engine
   * @param {number}        duration   – seconds per phase (default 2)
   * @param {function}      onToggle   – called with (processingActive: boolean)
   */
  static async abCompare(engine, duration = 2, onToggle) {
    // Phase A: processing OFF
    engine.setAdaptiveEQ(false);
    engine.setMasking(false);
    onToggle?.(false);

    await new Promise(r => setTimeout(r, duration * 1000));

    // Phase B: processing ON
    engine.setAdaptiveEQ(true);
    engine.setMasking(true);
    onToggle?.(true);
  }
}
