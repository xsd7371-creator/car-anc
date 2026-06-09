import { AudioEngine } from './AudioEngine.js';

const engine = new AudioEngine();
let appState = 'idle'; // idle | calibrating | running

// DOM refs
const startBtn        = document.getElementById('startBtn');
const calibrateBtn    = document.getElementById('calibrateBtn');
const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const overallLevel    = document.getElementById('overallLevel');
const spectrumCanvas  = document.getElementById('spectrumCanvas');
const bandsContainer  = document.getElementById('bandsContainer');
const eqContainer     = document.getElementById('eqContainer');
const audioFileInput  = document.getElementById('audioFileInput');
const toggleEQ        = document.getElementById('toggleEQ');
const toggleMasking   = document.getElementById('toggleMasking');
const calibBadge      = document.getElementById('calibBadge');
const calibProgress   = document.getElementById('calibProgress');
const calibBar        = document.getElementById('calibBar');
const calibStatus     = document.getElementById('calibStatus');
const musicBadge      = document.getElementById('musicBadge');
const testToneBtn     = document.getElementById('testToneBtn');
const abBtn           = document.getElementById('abBtn');
const abStatus        = document.getElementById('abStatus');
const calibQualityRow = document.getElementById('calibQualityRow');
const calibQualityVerdict = document.getElementById('calibQualityVerdict');
const calibQualityDetail  = document.getElementById('calibQualityDetail');
const calibQualityBar     = document.getElementById('calibQualityBar');

const ctx2d = spectrumCanvas.getContext('2d');

// ── Start / Stop ──────────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  if (appState === 'running') {
    engine.stop();
    appState = 'idle';
    setStatus('idle');
    startBtn.textContent = '開始降噪';
    startBtn.className   = 'btn-start';
    calibrateBtn.disabled = false;
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = '啟動中…';

  try {
    await engine.start('normal');
    engine.onMetricsUpdate = renderMetrics;
    appState = 'running';
    setStatus('running');
    startBtn.textContent  = '停止降噪';
    startBtn.className    = 'btn-stop';
    calibrateBtn.disabled = false;
    testToneBtn.disabled  = false;
    abBtn.disabled        = false;
  } catch (e) {
    alert('無法啟動麥克風：' + e.message);
    startBtn.textContent = '開始降噪';
  } finally {
    startBtn.disabled = false;
  }
});

// ── Calibration ───────────────────────────────────────────────────────────────

calibrateBtn.addEventListener('click', async () => {
  if (appState === 'idle') {
    // Need to start engine first (without update loop)
    await engine.start('calibration').catch(e => { alert(e.message); return; });
  }

  appState = 'calibrating';
  calibrateBtn.disabled = true;
  startBtn.disabled     = true;
  calibProgress.style.display = 'block';
  setStatus('calibrating');

  try {
    let qualityResult = null;
    await engine.calibrate(({ phase, value, quality }) => {
      calibBar.style.width = Math.round(value * 100) + '%';
      calibStatus.textContent = phase === 'measuring'
        ? `量測中… ${Math.round(value * 100)}%`
        : phase === 'switching'
        ? '切換至正常模式…'
        : '校正完成';
      if (quality) qualityResult = quality;
    });

    calibBadge.textContent = '已校正';
    calibBadge.className   = 'badge badge-green';

    // Show calibration quality report
    if (qualityResult) {
      calibQualityVerdict.textContent = qualityResult.verdict;
      calibQualityDetail.textContent  = qualityResult.detail;
      calibQualityBar.style.width     = qualityResult.score + '%';
      calibQualityBar.style.background = qualityResult.score >= 80
        ? 'var(--green)' : qualityResult.score >= 40 ? 'var(--amber)' : 'var(--red)';
      calibQualityRow.style.display = 'block';
    }

    appState = 'running';
    engine.onMetricsUpdate = renderMetrics;
    setStatus('running');
    startBtn.textContent  = '停止降噪';
    startBtn.className    = 'btn-stop';
    testToneBtn.disabled  = false;
    abBtn.disabled        = false;
  } catch (e) {
    alert('校正失敗：' + e.message);
    appState = 'idle';
    setStatus('idle');
  } finally {
    calibrateBtn.disabled = false;
    startBtn.disabled     = false;
    calibProgress.style.display = 'none';
  }
});

// ── Test tone ──────────────────────────────────────────────────────────────────

testToneBtn.addEventListener('click', async () => {
  testToneBtn.disabled = true;
  testToneBtn.textContent = '播放中…';
  try {
    await engine.playTestTone(440);
  } catch (e) {
    alert(e.message);
  } finally {
    testToneBtn.disabled = false;
    testToneBtn.textContent = '播放 440 Hz';
  }
});

// ── A/B compare ────────────────────────────────────────────────────────────────

abBtn.addEventListener('click', async () => {
  abBtn.disabled = true;
  abStatus.style.display = 'block';

  await engine.abCompare(2, (active) => {
    if (!active) {
      abStatus.textContent = '⏸ 處理已暫停（聆聽原始聲音）';
      abStatus.className   = 'ab-status ab-off';
    } else {
      abStatus.textContent = '▶ 處理已恢復（聆聽處理後聲音）';
      abStatus.className   = 'ab-status ab-on';
    }
  });

  setTimeout(() => {
    abStatus.style.display = 'none';
    abBtn.disabled = false;
  }, 2000);
});

// ── Pink noise ─────────────────────────────────────────────────────────────────

const togglePink = document.getElementById('togglePink');
togglePink.addEventListener('change', () => {
  if (appState !== 'running') {
    togglePink.checked = false;
    alert('請先開始降噪');
    return;
  }
  engine.togglePinkNoise(togglePink.checked);
  musicBadge.style.display = togglePink.checked ? 'inline' : 'none';
});

// ── Audio file ─────────────────────────────────────────────────────────────────

audioFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (appState !== 'running') { alert('請先開始降噪再載入音樂'); return; }
  await engine.loadAudioFile(file);
  musicBadge.style.display = 'inline';
});

// ── Toggles ────────────────────────────────────────────────────────────────────

toggleEQ.addEventListener('change',      () => engine.setAdaptiveEQ(toggleEQ.checked));
toggleMasking.addEventListener('change', () => engine.setMasking(toggleMasking.checked));

// ── Render ─────────────────────────────────────────────────────────────────────

function setStatus(state) {
  const map = {
    idle:        { dot: 'dot-gray',   text: '待機' },
    calibrating: { dot: 'dot-amber',  text: '校正中，請保持安靜…' },
    running:     { dot: 'dot-green',  text: '降噪運行中' },
  };
  const s = map[state] || map.idle;
  statusDot.className  = 'dot ' + s.dot;
  statusText.textContent = s.text;
}

function renderMetrics({ spectrum, peaks, bands, overallDB, eqGains, calibrated, musicMode }) {
  overallLevel.textContent = overallDB.toFixed(1) + ' dBFS';
  overallLevel.style.color = overallDB > -30 ? '#ef4444' : overallDB > -50 ? '#f59e0b' : '#22c55e';

  if (calibrated && calibBadge.textContent !== '已校正') {
    calibBadge.textContent = '已校正';
    calibBadge.className   = 'badge badge-green';
  }

  musicBadge.style.display = musicMode ? 'inline' : 'none';

  drawSpectrum(spectrum);
  renderBands(bands);
  renderEQ(eqGains);
}

function drawSpectrum(spectrum) {
  const w = spectrumCanvas.width;
  const h = spectrumCanvas.height;
  ctx2d.clearRect(0, 0, w, h);

  const minDB = -100, maxDB = -10;

  for (let x = 0; x < w; x++) {
    const binIdx = Math.floor((x / w) * spectrum.length);
    const db     = spectrum[binIdx] ?? minDB;
    const norm   = Math.max(0, (db - minDB) / (maxDB - minDB));
    const barH   = norm * h;
    const red    = Math.round((1 - norm) * 80 + norm * 220);
    const green  = Math.round(norm * 200);
    ctx2d.fillStyle = `rgb(${red},${green},60)`;
    ctx2d.fillRect(x, h - barH, 1, barH);
  }

  // Frequency gridlines
  ctx2d.fillStyle = 'rgba(255,255,255,0.35)';
  ctx2d.font = '10px sans-serif';
  const sr = engine.ctx?.sampleRate ?? 44100;
  [100, 500, 1000, 2000, 4000, 8000].forEach(hz => {
    const x = Math.round((hz / (sr / 2)) * w);
    ctx2d.fillRect(x, 0, 1, h);
    ctx2d.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, x + 2, h - 4);
  });
}

function renderBands(bands) {
  bandsContainer.innerHTML = '';
  if (!bands.length) {
    bandsContainer.innerHTML = '<p class="dim">未偵測到顯著噪音來源</p>';
    return;
  }
  bands.forEach(b => {
    const div    = document.createElement('div');
    div.className = 'band-item';
    const detail = b.type === 'broadband'
      ? `${b.db?.toFixed(0)} dB 寬頻`
      : b.peaks.map(p => `${p.hz.toFixed(0)} Hz`).join('、');
    div.innerHTML = `<span class="band-icon">${b.icon}</span>
      <span class="band-label">${b.label}</span>
      <span class="band-detail">${detail}</span>`;
    bandsContainer.appendChild(div);
  });
}

function renderEQ(gains) {
  eqContainer.innerHTML = '';
  const max = 8;
  const threshold = -80; // must match AdaptiveEQ.NOISE_THRESHOLD_DB
  gains.forEach(({ hz, gain, noiseDB }) => {
    const col = document.createElement('div');
    col.className = 'eq-col';
    const pct      = Math.max(0, (gain / max) * 100);
    const aboveThresh = noiseDB > threshold;
    const noiseStr = noiseDB > -119 ? noiseDB.toFixed(0) : '—';
    col.innerHTML = `
      <div class="eq-bar-wrap">
        <div class="eq-bar" style="height:${Math.max(pct, gain > 0.05 ? 4 : 0)}%;background:${aboveThresh ? 'var(--blue)' : 'var(--border)'}"></div>
      </div>
      <span class="eq-label">${hz >= 1000 ? hz / 1000 + 'k' : hz}</span>
      <span class="eq-db" style="color:${aboveThresh ? 'var(--amber)' : 'var(--dim)'}">${noiseStr}</span>`;
    eqContainer.appendChild(col);
  });
}
