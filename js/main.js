import { AudioEngine } from './AudioEngine.js';

const engine = new AudioEngine();
let started = false;

// DOM refs
const startBtn = document.getElementById('startBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const overallLevel = document.getElementById('overallLevel');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const bandsContainer = document.getElementById('bandsContainer');
const eqContainer = document.getElementById('eqContainer');
const audioFileInput = document.getElementById('audioFileInput');
const toggleEQ = document.getElementById('toggleEQ');
const toggleMasking = document.getElementById('toggleMasking');

const ctx2d = spectrumCanvas.getContext('2d');

// ── Start / Stop ──────────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  if (started) {
    engine.stop();
    started = false;
    setStatus(false);
    startBtn.textContent = '開始降噪';
    startBtn.className = 'btn-start';
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = '啟動中…';

  try {
    await engine.start();
    engine.onMetricsUpdate = renderMetrics;
    started = true;
    setStatus(true);
    startBtn.textContent = '停止降噪';
    startBtn.className = 'btn-stop';
  } catch (e) {
    alert('無法啟動麥克風：' + e.message);
    startBtn.textContent = '開始降噪';
  } finally {
    startBtn.disabled = false;
  }
});

// ── Audio file ────────────────────────────────────────────────────────────────

audioFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !started) return;
  await engine.loadAudioFile(file);
});

// ── Toggles ───────────────────────────────────────────────────────────────────

toggleEQ.addEventListener('change', () => engine.setAdaptiveEQ(toggleEQ.checked));
toggleMasking.addEventListener('change', () => engine.setMasking(toggleMasking.checked));

// ── Render ────────────────────────────────────────────────────────────────────

function setStatus(running) {
  statusDot.className = running ? 'dot dot-green' : 'dot dot-gray';
  statusText.textContent = running ? '降噪運行中' : '待機';
}

function renderMetrics({ spectrum, peaks, bands, overallDB, eqGains }) {
  overallLevel.textContent = overallDB.toFixed(1) + ' dBFS';
  overallLevel.style.color = overallDB > -30 ? '#ef4444' : overallDB > -50 ? '#f59e0b' : '#22c55e';

  drawSpectrum(spectrum);
  renderBands(bands);
  renderEQ(eqGains);
}

function drawSpectrum(spectrum) {
  const w = spectrumCanvas.width;
  const h = spectrumCanvas.height;
  ctx2d.clearRect(0, 0, w, h);

  const minDB = -100, maxDB = -10;
  const step = Math.max(1, Math.floor(spectrum.length / w));

  for (let x = 0; x < w; x++) {
    const binIdx = Math.floor((x / w) * spectrum.length);
    const db = spectrum[binIdx] ?? minDB;
    const norm = Math.max(0, (db - minDB) / (maxDB - minDB));
    const barH = norm * h;

    const green = Math.round(norm * 200);
    const red = Math.round((1 - norm) * 80 + norm * 220);
    ctx2d.fillStyle = `rgb(${red},${green},60)`;
    ctx2d.fillRect(x, h - barH, 1, barH);
  }

  // Frequency axis labels
  ctx2d.fillStyle = 'rgba(255,255,255,0.4)';
  ctx2d.font = '10px sans-serif';
  const sampleRate = engine.ctx?.sampleRate ?? 44100;
  [100, 500, 1000, 2000, 4000].forEach(hz => {
    const x = Math.round((hz / (sampleRate / 2)) * w);
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
    const div = document.createElement('div');
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
  gains.forEach(({ hz, gain }) => {
    const col = document.createElement('div');
    col.className = 'eq-col';
    const pct = Math.max(0, (gain / max) * 100);
    col.innerHTML = `
      <div class="eq-bar-wrap">
        <div class="eq-bar" style="height:${pct}%"></div>
      </div>
      <span class="eq-label">${hz >= 1000 ? hz / 1000 + 'k' : hz}</span>`;
    eqContainer.appendChild(col);
  });
}
