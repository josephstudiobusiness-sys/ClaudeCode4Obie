/* ─────────────────────────────────────────────────────────────────────
 * visualizer.js  —  UI wiring for the Visualizer tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), plotLayout(), pcfg, COL
 *   audio.js          — decodeWAV/encodeWAV (playback here is a small
 *                        self-contained player, same reasoning as Spectrogram)
 *
 * An arbitrary number of files can be loaded, tracked in `_files` and
 * listed in the sidebar, Explore/Spectrogram-style. Exactly one file is
 * "active" at a time — whichever checked file sits highest in the list
 * (same convention as Spectrogram's Single mode) — and that file's
 * (times, freqs, dB) grid is rendered through whichever of the three view
 * modes is selected:
 *   - Planar     the classic flat time/frequency heatmap
 *   - Radial     the same grid wrapped into a circle (frequency around the
 *                circumference, time as radius)
 *   - 3D Surface the same grid with level as real, rotatable height
 * A single colour-scale picker ("difference in colour") applies across all
 * three views, so switching views never changes what a given colour means.
 *
 * All WAV/FRF decoding and STFT computation run in Python (main.py), using
 * the canonical ObieApp fileio/processing modules. This file only manages
 * the file list, playback, plot rendering, and UI state.
 * ───────────────────────────────────────────────────────────────────── */

// ── Loaded-file list ────────────────────────────────────────────────────
function _freshFile(id, name) {
  return {
    id, name,
    samples: null, sr: 48000, channels: 1, isStereo: false,
    showChannel: 'l', lCache: null, rCache: null,
    status: '', statusCls: '',
    active: false,
  };
}
let _files = [];
let _nextId = 1;

function _getFile(id) { return _files.find(f => f.id === id); }
function _fileNum(id) { return _files.findIndex(f => f.id === id) + 1; }
function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The same checkbox both "selects" a file and picks the active one — the
// topmost checked file wins, so checking a higher file bumps it in front of
// ones already checked, and unchecking it reveals the next-highest checked
// file underneath (identical convention to Spectrogram's Single mode).
function _activeTargetId() {
  const f = _files.find(x => x.active);
  return f ? f.id : null;
}

function _autoActivate(f) {
  if (!_files.some(x => x.active)) f.active = true;
}

// ── Plot config ──────────────────────────────────────────────────────
const _pcfg = { ...pcfg, toImageButtonOptions: { format: 'png', scale: 2, filename: 'visualizer' } };
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff',
});
let _logFreq = false;
let _view = 'planar';   // 'planar' | 'radial' | 'surface'

Plotly.newPlot('viz-plot', [], _wl('Visualizer', '', '', {}), _pcfg);

// ── File loading (WAV, MP3, or FRF files IFFT'd to an impulse response) ──
async function _decodeAudioFile(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close().catch(() => {});
  }
  const sr = buf.sampleRate;
  if (buf.numberOfChannels >= 2) {
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    const interleaved = new Float32Array(l.length * 2);
    for (let i = 0; i < l.length; i++) { interleaved[2 * i] = l[i]; interleaved[2 * i + 1] = r[i]; }
    return { samples: interleaved, sr, nChannels: 2 };
  }
  return { samples: buf.getChannelData(0).slice(), sr, nChannels: 1 };
}

const FRF_EXTS = ['trf', 'trv', 'avc', 'avr', 'csv', 'mat'];

function _setFileStatus(id, text, cls) {
  const f = _getFile(id);
  if (!f) return;
  f.status = text; f.statusCls = cls || '';
  _renderFileList();
}

window.loadFiles = function(input) {
  const picked = Array.from(input.files || []);
  input.value = '';   // allow re-selecting the same file(s) later
  picked.forEach(_loadOneFile);
};

function _loadOneFile(file) {
  const id = String(_nextId++);
  const f = _freshFile(id, file.name);
  f.status = 'reading…';
  _files.push(f);
  _autoActivate(f);
  _renderFileList();
  _refreshCurrentView();

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onerror = () => _setFileStatus(id, 'read error', 'err');
  reader.onload = async e => {
    if (ext === 'wav') {
      if (!window.pyVzLoadWav) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      window.pyVzLoadWav(id, file.name, new Uint8Array(e.target.result));
    } else if (FRF_EXTS.includes(ext)) {
      if (!window.pyVzLoadComplex) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      window.pyVzLoadComplex(id, file.name, new Uint8Array(e.target.result));
    } else {
      // mp3 and anything else — decode client-side via Web Audio first.
      if (!window.pyVzLoadDecodedAudio) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      try {
        const { samples, sr, nChannels } = await _decodeAudioFile(e.target.result);
        window.pyVzLoadDecodedAudio(id, file.name, samples, sr, nChannels);
      } catch (err) {
        _setFileStatus(id, 'could not decode audio: ' + err.message.slice(0, 60), 'err');
      }
    }
  };
  reader.readAsArrayBuffer(file);
}

window.onVzSampleResult = function(slot, samplesArr, sr, nChannels, info, stereo) {
  const f = _getFile(slot);
  if (!f) return;   // file was removed before this async result arrived
  f.samples  = new Float32Array(samplesArr);
  f.sr       = +sr;
  f.channels = +nChannels;
  f.isStereo = !!stereo;
  f.showChannel = 'l';
  f.status = info; f.statusCls = 'ok';
  _renderFileList();
  if (f.id === _activeTargetId()) vzRender();
};

window.onVzSampleError = function(slot, msg) {
  const f = _getFile(slot);
  if (!f) return;
  f.samples = null;
  f.status = 'error: ' + msg; f.statusCls = 'err';
  _renderFileList();
};

window.onVzError = function(slot, msg) {
  const f = _getFile(slot);
  if (!f) return;
  f.status = 'error: ' + msg; f.statusCls = 'err';
  _renderFileList();
};

// ── Spectrogram unpack ─────────────────────────────────────────────────
function _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const times = Array.from(times_js), freqs = Array.from(freqs_js);
  const arr = Array.from(flatZ_js);
  const nF = +nFreqs, nT = +nTimes;
  const zDb = [];
  for (let i = 0; i < nF; i++) zDb.push(arr.slice(i * nT, (i + 1) * nT));
  return { times, freqs, zDb };
}

window.onVzSpectrogramResult = function(slot, channel, times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const cache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  const f = _getFile(slot);
  if (!f) return;
  if (channel === 'r') f.rCache = cache; else f.lCache = cache;
  if (f.showChannel === channel && f.id === _activeTargetId()) vzRender();
};

function _dataMinMax(zDb) {
  let lo = Infinity, hi = -Infinity;
  for (const row of zDb) for (const v of row) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { min: lo, max: hi };
}

function _axisTitle(text) {
  return { text, font: { size: 30, family: 'Arial, sans-serif', color: cssVar('--text') || '#1a1a1a' } };
}

function _activeCache() {
  const id = _activeTargetId();
  const f = id != null ? _getFile(id) : null;
  const cache = f && (f.showChannel === 'r' ? f.rCache : f.lCache);
  return { f, cache };
}

function renderFrameInfo(times, freqs) {
  const el = document.getElementById('frame-info');
  if (!el) return;
  if (!times || !times.length || !freqs || !freqs.length) { el.textContent = '–'; return; }
  const dt = times.length > 1 ? times[1] - times[0] : 0;
  const df = freqs.length > 1 ? freqs[1] - freqs[0] : 0;
  el.textContent =
    `${times.length}×${freqs.length} (t×f)  ·  ${(dt * 1000).toFixed(1)} ms/frame  ·  ${df.toFixed(1)} Hz/bin`;
}

// ── Planar (flat heatmap) and 3D Surface — share the same grid layout ────
function _renderPlanar(cache, title) {
  const { times, freqs, zDb } = cache;
  const colorscale = document.getElementById('colorscale-sel').value;
  const range = _dataMinMax(zDb);
  const trace = {
    x: times, y: freqs, z: zDb, type: 'heatmap', colorscale, showscale: true,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } },
    zsmooth: 'fast', zmin: range.min, zmax: range.max,
    hovertemplate: 'Time: %{x:.3f} s<br>Freq: %{y:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>',
  };
  Plotly.react('viz-plot', [trace], _wl(title, 'Time (s)', 'Frequency (Hz)', {
    margin: { l: 50, r: 45, t: 26, b: 34 },
    yaxis: { type: _logFreq ? 'log' : 'linear' },
  }), _pcfg);
}

function _renderSurface(cache, title) {
  const { times, freqs, zDb } = cache;
  const colorscale = document.getElementById('colorscale-sel').value;
  const range = _dataMinMax(zDb);
  const trace = {
    x: times, y: freqs, z: zDb, type: 'surface', colorscale, showscale: true,
    cmin: range.min, cmax: range.max,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10, tickfont: { size: 9 } },
    hovertemplate: 'Time: %{x:.3f} s<br>Freq: %{y:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>',
  };
  Plotly.react('viz-plot', [trace], {
    title: { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
    font: { size: 10, family: 'inherit' },
    paper_bgcolor: '#fff',
    scene: {
      xaxis: { title: _axisTitle('Time (s)') },
      yaxis: { title: _axisTitle('Frequency (Hz)'), type: _logFreq ? 'log' : 'linear' },
      zaxis: { title: _axisTitle('dB'), range: [range.min, range.max] },
    },
    margin: { l: 30, r: 30, t: 28, b: 30 },
  }, _pcfg);
}

// ── Radial: frequency around the circumference, time as radius ──────────
// Plotly has no native polar heatmap, so this reuses the 3D 'surface' trace
// with manually-computed (x,y) = (r·cosθ, r·sinθ) coordinates instead of the
// usual straight-line time/frequency ones, and colour driven by
// surfacecolor instead of height. Flat lighting keeps the disc reading as
// pure colour rather than a shaded 3D object.
function _visualizerFreqFraction(freq, fMax, freqFloor) {
  if (!_logFreq) return fMax ? freq / fMax : 0;
  const lo = Math.log(Math.max(freqFloor, 1e-9));
  const hi = Math.log(Math.max(fMax, freqFloor * 1.0001));
  if (hi <= lo) return 0;
  const f = Math.max(freq, freqFloor);
  return Math.min(1, Math.max(0, (Math.log(f) - lo) / (hi - lo)));
}

function _renderRadial(cache, title) {
  const { times, freqs, zDb } = cache;
  const tMax = times[times.length - 1] || 1;
  const fMax = freqs[freqs.length - 1] || 1;
  const freqFloor = freqs.find(fq => fq > 0) || fMax * 0.001;
  const tickFreqs = [200, 400, 600, 1000, 2000, 3000, 5000, 7000].filter(fq => fq > freqFloor && fq < fMax * 0.97);

  const innerR = 0.15;   // small hole at the centre so t=0 isn't a singular point
  const outerR = 1;
  // 0 Hz at 12 o'clock, sweeping clockwise up to fMax back at 12 o'clock.
  const thetaOf = freq => Math.PI / 2 - 2 * Math.PI * _visualizerFreqFraction(freq, fMax, freqFloor);

  const dbRange = _dataMinMax(zDb);
  const dbSpan = (dbRange.max - dbRange.min) || 1;
  const Z_SCALE = 0.05;

  const x = [], y = [], z = [], customdata = [];
  for (let i = 0; i < freqs.length; i++) {
    const theta = thetaOf(freqs[i]);
    const xRow = [], yRow = [], zRow = [], cdRow = [];
    for (let j = 0; j < times.length; j++) {
      const r = innerR + (outerR - innerR) * (tMax ? times[j] / tMax : 0);
      xRow.push(r * Math.cos(theta));
      yRow.push(r * Math.sin(theta));
      zRow.push(Z_SCALE * (zDb[i][j] - dbRange.min) / dbSpan);
      cdRow.push(freqs[i]);
    }
    x.push(xRow); y.push(yRow); z.push(zRow); customdata.push(cdRow);
  }

  const muted = cssVar('--muted') || '#5a5f6a';
  const textColor = cssVar('--text') || '#1a1a1a';

  const seamSpoke = (() => {
    const th = thetaOf(0);
    return {
      type: 'scatter3d', mode: 'lines',
      x: [innerR * Math.cos(th), outerR * Math.cos(th)],
      y: [innerR * Math.sin(th), outerR * Math.sin(th)],
      z: [0, 0],
      line: { color: muted, width: 2, dash: 'dot' },
      hoverinfo: 'skip', showlegend: false,
    };
  })();

  const tickX = [], tickY = [], tickZ = [];
  for (const fq of tickFreqs) {
    const th = thetaOf(fq);
    tickX.push(innerR * Math.cos(th), outerR * Math.cos(th), null);
    tickY.push(innerR * Math.sin(th), outerR * Math.sin(th), null);
    tickZ.push(0, 0, null);
  }
  const tickMarks = {
    type: 'scatter3d', mode: 'lines', x: tickX, y: tickY, z: tickZ,
    line: { color: muted, width: 1, dash: 'dot' }, opacity: 0.55,
    hoverinfo: 'skip', showlegend: false,
  };

  const seamLabelR = outerR + 0.2, tickLabelR = outerR + 0.14;
  const eps = 0.08;
  const seamFont = { size: 11, family: 'Arial, sans-serif', color: textColor };
  const tickFont = { size: 9, family: 'Arial, sans-serif', color: muted };
  const freqTickLabel = fq => fq >= 1000 ? `${fq / 1000}k` : `${fq}`;

  const annotations = [
    { x: seamLabelR * Math.cos(thetaOf(0) - eps), y: seamLabelR * Math.sin(thetaOf(0) - eps), z: 0,
      text: '0 Hz', showarrow: false, font: seamFont },
    { x: seamLabelR * Math.cos(thetaOf(0) + eps), y: seamLabelR * Math.sin(thetaOf(0) + eps), z: 0,
      text: `${fMax.toFixed(0)} Hz`, showarrow: false, font: seamFont },
    ...tickFreqs.map(fq => {
      const th = thetaOf(fq);
      return { x: tickLabelR * Math.cos(th), y: tickLabelR * Math.sin(th), z: 0,
        text: freqTickLabel(fq), showarrow: false, font: tickFont };
    }),
  ];

  const colorscale = document.getElementById('colorscale-sel').value;
  const range = seamLabelR + 0.08;

  Plotly.react('viz-plot', [{
    type: 'surface', x, y, z, surfacecolor: zDb, colorscale, showscale: true,
    cmin: dbRange.min, cmax: dbRange.max,
    colorbar: { title: 'dB', titleside: 'right', thickness: 10, tickfont: { size: 9 } },
    customdata,
    hovertemplate: 'Freq: %{customdata:.0f} Hz<br>Level: %{surfacecolor:.1f} dB<extra></extra>',
    lighting: { ambient: 1, diffuse: 0, specular: 0 },
  }, seamSpoke, tickMarks], {
    title: {
      text: `${title} — frequency around the circumference (0–${fMax.toFixed(0)} Hz, ${_logFreq ? 'log' : 'linear'}), time as radius`,
      font: { size: 11 }, pad: { t: 2, b: 0 },
    },
    font: { size: 10, family: 'inherit' },
    paper_bgcolor: '#fff',
    scene: {
      xaxis: { visible: false, range: [-range, range] },
      yaxis: { visible: false, range: [-range, range] },
      zaxis: { visible: false, range: [-0.1, 0.2] },
      aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: 0.05 },
      camera: { eye: { x: 0, y: 0, z: 1.5 }, up: { x: 0, y: 1, z: 0 } },
      annotations,
    },
    margin: { l: 10, r: 10, t: 40, b: 10 },
  }, _pcfg);
}

// ── Top-level render dispatch ───────────────────────────────────────────
function vzRender() {
  const { f, cache } = _activeCache();
  const statusEl = document.getElementById('active-status');
  const titleEl = document.getElementById('active-title');
  if (!cache) {
    statusEl.textContent = 'Tick a file’s checkbox in the sidebar to see it here';
    statusEl.className = 'vz-panel-status';
    titleEl.textContent = 'Visualizer';
    Plotly.react('viz-plot', [], _wl('Visualizer', '', '', {}), _pcfg);
    renderFrameInfo(null, null);
    return;
  }
  const label = f.isStereo ? (f.showChannel === 'r' ? ' · R channel' : ' · L channel') : '';
  const title = `#${_fileNum(f.id)} ${f.name}` + label;
  statusEl.textContent = title;
  statusEl.className = 'vz-panel-status ok';
  titleEl.textContent = title;

  if (_view === 'radial') _renderRadial(cache, title);
  else if (_view === 'surface') _renderSurface(cache, title);
  else _renderPlanar(cache, title);
  renderFrameInfo(cache.times, cache.freqs);
}

function _refreshCurrentView() { vzRender(); }

window.vzSetView = function(view) {
  _view = view;
  document.getElementById('view-planar-btn').classList.toggle('active', view === 'planar');
  document.getElementById('view-radial-btn').classList.toggle('active', view === 'radial');
  document.getElementById('view-surface-btn').classList.toggle('active', view === 'surface');
  vzRender();
};

window.vzToggleFreqScale = function() {
  _logFreq = !_logFreq;
  const btn = document.getElementById('freq-scale-btn');
  btn.textContent = _logFreq ? 'Freq: Log' : 'Freq: Lin';
  btn.classList.toggle('active', _logFreq);
  vzRender();
};

window.vzToggleChannel = function(id) {
  const f = _getFile(id);
  if (!f) return;
  f.showChannel = f.showChannel === 'l' ? 'r' : 'l';
  _renderFileList();
  if (f.id === _activeTargetId()) vzRender();
};

// ── Settings ────────────────────────────────────────────────────────────
function vzSettingsChanged() {
  const nFft = +document.getElementById('n-fft-sel').value;
  let hop = +document.getElementById('hop-sel').value;
  if (hop >= nFft) {
    hop = Math.max(128, nFft / 4);
    document.getElementById('hop-sel').value = String(hop);
  }
  const fMax = +document.getElementById('fmax-inp').value;
  const semitones = +document.getElementById('semitone-sel').value;
  if (!window.pyVzRecompute) return;
  window.pyVzRecompute(nFft, hop, fMax, semitones);
}

// ── Sidebar file list (Explore/Spectrogram-style) ───────────────────────
function _renderFileList() {
  const box = document.getElementById('file-list');
  if (!_files.length) {
    box.innerHTML = '<div class="vz-file-empty">Load a file to get started</div>';
    return;
  }
  const activeId = _activeTargetId();
  box.innerHTML = _files.map((f, i) => {
    const num = i + 1;
    return `<div class="vz-file-row${f.id === activeId ? ' active' : ''}" data-id="${f.id}">
      <div class="vz-file-row-top">
        <span class="vz-file-num">${num}.</span>
        <input type="checkbox" class="vz-file-cmp" data-id="${f.id}"${f.active ? ' checked' : ''} title="Make this the active file">
        <span class="vz-file-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
        <button class="vz-file-remove" data-id="${f.id}" title="Remove">✕</button>
      </div>
      <div class="vz-file-status ${f.statusCls}">${_esc(f.status)}</div>
      <div class="vz-file-row-ctl">
        <button class="vz-file-ctl-btn play-btn" data-id="${f.id}" ${f.samples ? '' : 'disabled'} title="Play/pause">${_playingId === f.id ? '■' : '▶'}</button>
        ${f.isStereo ? `<button class="vz-file-ctl-btn chan-btn" data-id="${f.id}" title="Toggle L/R channel">${f.showChannel === 'l' ? 'L' : 'R'}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.vz-file-cmp').forEach(cb => cb.addEventListener('change', e => _toggleActive(e.target.dataset.id, e.target.checked)));
  box.querySelectorAll('.vz-file-remove').forEach(el => el.addEventListener('click', e => _removeFile(e.target.dataset.id)));
  box.querySelectorAll('.play-btn').forEach(el => el.addEventListener('click', e => togglePlay(e.target.dataset.id)));
  box.querySelectorAll('.chan-btn').forEach(el => el.addEventListener('click', e => window.vzToggleChannel(e.target.dataset.id)));
}

// Same convention as Spectrogram's Compare checkbox: only the topmost
// checked file is ever "active," so checking this one bumps it in front of
// any already checked above it, and unchecking falls back to the next one
// down. There's no independent multi-select here — only one file drives
// the view at a time.
function _toggleActive(id, checked) {
  const f = _getFile(id);
  if (!f) return;
  if (!checked) { f.active = false; }
  else { _files.forEach(x => { x.active = false; }); f.active = true; }
  _renderFileList();
  vzRender();
}

function _removeFile(id) {
  const f = _getFile(id);
  if (!f) return;
  const wasActive = f.active;
  _files = _files.filter(x => x.id !== id);
  if (wasActive && _files.length) _files[0].active = true;
  if (_playingId === id) _stopPlayback();
  _renderFileList();
  vzRender();
}

// ── Settings / Info modals ──────────────────────────────────────────────
window.vzPreferences = function() {
  document.getElementById('prefs-modal').classList.add('open');
};
window.vzClosePrefs = function() {
  document.getElementById('prefs-modal').classList.remove('open');
};
window.vzSavePrefs = function() {
  vzSettingsChanged();
  const msg = document.getElementById('prefs-save-msg');
  msg.textContent = 'Saved';
  setTimeout(() => { msg.textContent = ''; }, 2500);
};
window.vzResetPrefs = function() {
  document.getElementById('n-fft-sel').value = '2048';
  document.getElementById('hop-sel').value = '512';
  document.getElementById('fmax-inp').value = '8000';
  document.getElementById('semitone-sel').value = '0';
  document.getElementById('colorscale-sel').value = 'Plasma';
  vzSettingsChanged();
  vzRender();
};
window.vzShowInfo = function() {
  document.getElementById('info-modal').classList.add('open');
};
window.vzCloseInfo = function() {
  document.getElementById('info-modal').classList.remove('open');
};

// ── Playback ─────────────────────────────────────────────────────────────
let _playCtx = null, _playSource = null, _playingId = null;

function _stopPlayback() {
  if (_playSource) { try { _playSource.stop(); } catch (_) {} _playSource = null; }
  _playingId = null;
}

function togglePlay(id) {
  const f = _getFile(id);
  if (!f || !f.samples) return;
  if (_playingId === id) { _stopPlayback(); _renderFileList(); return; }
  _stopPlayback();
  if (!_playCtx) _playCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_playCtx.state === 'suspended') _playCtx.resume();
  const channels = f.isStereo ? 2 : 1;
  const nFrames = Math.floor(f.samples.length / channels);
  const buf = _playCtx.createBuffer(channels, nFrames, f.sr);
  if (channels === 1) {
    buf.copyToChannel(f.samples, 0);
  } else {
    for (let ch = 0; ch < channels; ch++) {
      const chBuf = new Float32Array(nFrames);
      for (let i = 0; i < nFrames; i++) chBuf[i] = f.samples[i * channels + ch];
      buf.copyToChannel(chBuf, ch);
    }
  }
  const src = _playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(_playCtx.destination);
  src.onended = () => { if (_playingId === id) { _playingId = null; _renderFileList(); } };
  src.start();
  _playSource = src;
  _playingId = id;
  _renderFileList();
}

// ── Help ──────────────────────────────────────────────────────────────
window.vzHelp = function() {
  window.open('https://github.com/chrisbuerginrogers/ObieApp', '_blank');
};

// Python signals ready. Restore saved FFT settings (from localStorage via config.py).
window.onPythonReady = function() {
  const s = window.obieVzSettings;
  if (s) {
    if (s.n_fft) document.getElementById('n-fft-sel').value = String(s.n_fft);
    if (s.hop)   document.getElementById('hop-sel').value   = String(s.hop);
    if (s.f_max) document.getElementById('fmax-inp').value  = String(s.f_max);
    if (s.semitones) document.getElementById('semitone-sel').value = String(s.semitones);
  }
};

// ── Sidebar resize ────────────────────────────────────────────────────
function _initResizer() {
  const resizer = document.getElementById('vz-resizer');
  const sidebar = document.querySelector('.vz-sidebar');
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
    const el = document.getElementById('viz-plot');
    if (el && el.data) Plotly.Plots.resize(el);
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
  _renderFileList();
  vzRender();
});
