/* ─────────────────────────────────────────────────────────────────────
 * spectrogram.js  —  UI wiring for the Spectrogram tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), plotLayout(), pcfg, COL
 *   audio.js          — AudioPlayer
 *
 * All WAV decoding and STFT computation run in Python (main.py), using the
 * canonical Python/fileio/wavfileio.py and Python/processing/spectrogram.py
 * modules from ObieApp. This file only manages playback state, plot
 * rendering, and UI interactions.
 * ───────────────────────────────────────────────────────────────────── */

// ── Playback / channel state ──────────────────────────────────────────
let wavSamples  = null, wavSR = 48000, wavChannels = 1, wavIsStereo = false;
let _showChannel = 'l';   // 'l' or 'r' — which spectrogram is shown when stereo
let _lSpecCache  = null, _rSpecCache = null;
let _logFreq     = false;

const player = new AudioPlayer({ wav: 'play-btn' });

// ── Plot initialisation ───────────────────────────────────────────────
const _pcfg = { ...pcfg, toImageButtonOptions: { format: 'png', scale: 2, filename: 'spectrogram' } };
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff',
});

Plotly.newPlot('waveform-plot', [], _wl('Waveform', 'Time (s)', 'Amplitude'), _pcfg);
Plotly.newPlot('spec-plot',     [], _wl('Spectrogram', 'Time (s)', 'Frequency (Hz)'), _pcfg);

// ── WAV loading ───────────────────────────────────────────────────────
function loadWAV(input) {
  const file = input.files[0]; if (!file) return;
  document.getElementById('wav-btn-text').textContent = file.name;
  setSt('reading…');
  const reader = new FileReader();
  reader.onerror = () => setSt('read error', 'err');
  reader.onload  = e => {
    if (!window.pySpecLoadWav) {
      setSt('Python not ready — try again in a moment', 'err'); return;
    }
    window.pySpecLoadWav(file.name, new Uint8Array(e.target.result));
  };
  reader.readAsArrayBuffer(file);
}

window.onSpecWavResult = function(samplesArr, sr, nChannels, info, stereo) {
  wavSamples  = new Float32Array(samplesArr);
  wavSR       = +sr;
  wavChannels = +nChannels;
  wavIsStereo = !!stereo;
  setSt(info, 'ok');
  document.getElementById('play-btn').disabled = false;
  document.getElementById('chan-btn').style.display = wavIsStereo ? '' : 'none';
  _showChannel = 'l';
  updateChanBtn();
  plotWaveform();
};

window.onSpecWavError = function(msg) {
  wavSamples = null;
  document.getElementById('play-btn').disabled = true;
  setSt('error: ' + msg, 'err');
};

window.onSpecError = function(msg) {
  setSt('error: ' + msg, 'err');
};

// ── Spectrogram unpack / render ────────────────────────────────────────
function _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const times = Array.from(times_js), freqs = Array.from(freqs_js);
  const arr = Array.from(flatZ_js);
  const nF = +nFreqs, nT = +nTimes;
  const zDb = [];
  for (let i = 0; i < nF; i++) zDb.push(arr.slice(i * nT, (i + 1) * nT));
  return { times, freqs, zDb };
}

window.onSpecLSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _lSpecCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  if (_showChannel === 'l') renderSpec();
};
window.onSpecRSpectrogramResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _rSpecCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  if (_showChannel === 'r') renderSpec();
};

function renderSpec() {
  const cache = _showChannel === 'r' ? _rSpecCache : _lSpecCache;
  if (!cache) return;
  const { times, freqs, zDb } = cache;
  const colorscale = document.getElementById('colorscale-sel').value;
  const label = wavIsStereo ? (_showChannel === 'r' ? ' · R channel' : ' · L channel') : '';
  Plotly.react('spec-plot', [{
    x: times, y: freqs, z: zDb,
    type: 'heatmap', colorscale, showscale: true,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } },
    zsmooth: 'fast', hoverinfo: 'skip',
  }], _wl('Spectrogram' + label, 'Time (s)', 'Frequency (Hz)', {
    margin: { l: 55, r: 55, t: 28, b: 38 },
    yaxis: { type: _logFreq ? 'log' : 'linear' },
  }), _pcfg);
  renderFrameInfo(times, freqs);
}

function renderFrameInfo(times, freqs) {
  const el = document.getElementById('frame-info');
  if (!times.length || !freqs.length) { el.textContent = '–'; return; }
  const dt = times.length > 1 ? times[1] - times[0] : 0;
  const df = freqs.length > 1 ? freqs[1] - freqs[0] : 0;
  el.textContent =
    `${times.length} frames × ${freqs.length} bins\n` +
    `${(dt * 1000).toFixed(1)} ms/frame\n` +
    `${df.toFixed(1)} Hz/bin`;
}

function plotWaveform() {
  if (!wavSamples) return;
  const stride = wavIsStereo ? 2 : 1;
  const n = Math.floor(wavSamples.length / stride);
  const step = Math.max(1, Math.floor(n / 5000));
  const x = [], y = [];
  for (let i = 0; i < n; i += step) { x.push(i / wavSR); y.push(wavSamples[i * stride]); }
  Plotly.react('waveform-plot', [{
    x, y, type: 'scatter', mode: 'lines',
    line: { color: COL.wav, width: 1 }, showlegend: false,
  }], _wl('Waveform', 'Time (s)', 'Amplitude'), _pcfg);
}

// ── Settings ──────────────────────────────────────────────────────────
function specSettingsChanged() {
  const nFft = +document.getElementById('n-fft-sel').value;
  let hop = +document.getElementById('hop-sel').value;
  if (hop >= nFft) {
    hop = Math.max(128, nFft / 4);
    document.getElementById('hop-sel').value = String(hop);
  }
  const fMax = +document.getElementById('fmax-inp').value;
  if (!window.pySpecRecompute) return;
  window.pySpecRecompute(nFft, hop, fMax);
}

function specRenderAll() {
  renderSpec();
}

function updateChanBtn() {
  const btn = document.getElementById('chan-btn');
  btn.textContent = _showChannel === 'l' ? 'Show R ▶' : '◀ Show L';
}

window.specToggleChannel = function() {
  _showChannel = _showChannel === 'l' ? 'r' : 'l';
  updateChanBtn();
  renderSpec();
};

window.specToggleFreqScale = function() {
  _logFreq = !_logFreq;
  const btn = document.getElementById('freq-scale-btn');
  btn.textContent = _logFreq ? 'Freq: Log' : 'Freq: Lin';
  btn.classList.toggle('active', _logFreq);
  renderSpec();
};

// ── Preferences modal ────────────────────────────────────────────────
window.specPreferences = function() {
  document.getElementById('prefs-modal').classList.add('open');
};
window.specClosePrefs = function() {
  document.getElementById('prefs-modal').classList.remove('open');
};
window.specSavePrefs = function() {
  specSettingsChanged();
  const msg = document.getElementById('prefs-save-msg');
  msg.textContent = 'Saved';
  setTimeout(() => { msg.textContent = ''; }, 2500);
};
window.specResetPrefs = function() {
  document.getElementById('n-fft-sel').value = '2048';
  document.getElementById('hop-sel').value = '512';
  document.getElementById('fmax-inp').value = '8000';
  document.getElementById('colorscale-sel').value = 'Plasma';
  specSettingsChanged();
  renderSpec();
};

// ── Playback ──────────────────────────────────────────────────────────
function togglePlay() {
  if (!wavSamples) return;
  player.toggle('wav', wavSamples, wavSR, wavIsStereo ? 2 : 1);
}

// ── Help ──────────────────────────────────────────────────────────────
window.specHelp = function() {
  window.open('https://github.com/chrisbuerginrogers/ObieApp', '_blank');
};

// ── UI helpers ────────────────────────────────────────────────────────
function setSt(txt, cls) {
  const el = document.getElementById('wav-status');
  el.textContent = txt;
  el.className = 'sp-status-txt' + (cls ? ' ' + cls : '');
  document.getElementById('wav-info').textContent = txt;
}

// Python signals ready. Restore saved FFT settings (from localStorage via config.py).
window.onPythonReady = function() {
  setSt('no file loaded');
  const s = window.obieSpecSettings;
  if (s) {
    if (s.n_fft) document.getElementById('n-fft-sel').value = String(s.n_fft);
    if (s.hop)   document.getElementById('hop-sel').value   = String(s.hop);
    if (s.f_max) document.getElementById('fmax-inp').value  = String(s.f_max);
  }
};

// ── Sidebar resize ────────────────────────────────────────────────────
function _initResizer() {
  const resizer = document.getElementById('sp-resizer');
  const sidebar = document.querySelector('.sp-sidebar');
  if (!resizer || !sidebar) return;
  let dragging = false, startX = 0, startW = 0;
  resizer.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(360, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    ['waveform-plot', 'spec-plot'].forEach(id => {
      const el = document.getElementById(id);
      if (el) Plotly.Plots.resize(el);
    });
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// Close modal on backdrop click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _initResizer();
});
