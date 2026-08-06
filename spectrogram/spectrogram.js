/* ─────────────────────────────────────────────────────────────────────
 * spectrogram.js  —  UI wiring for the Spectrogram tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), plotLayout(), pcfg, COL
 *   audio.js          — decodeWAV/encodeWAV (AudioPlayer isn't used here —
 *                        see the playback section below for why)
 *
 * An arbitrary number of files can be loaded (or recorded from the mic),
 * tracked in `_files` and listed in the sidebar, Explore-style. From there:
 *   - Single  shows the topmost sidebar-checked file, full width — the same
 *             checkbox Compare uses, so checking/unchecking files switches
 *             what Single shows too (highest-checked wins).
 *   - Compare stacks up to MAX_COMPARE files whose sidebar checkbox is
 *             ticked, as rows.
 *   - Difference/Mirror operate on exactly two files, chosen via the small
 *     ①/② buttons on each sidebar row.
 *   - Live watches the microphone continuously without saving anything.
 * FFT settings (window/hop/max-freq/smoothing/colorscale) are shared across
 * every loaded file, so any comparison is apples-to-apples.
 *
 * All WAV/FRF decoding and STFT computation run in Python (main.py), using
 * the canonical ObieApp fileio/processing modules. This file only manages
 * the file list, playback, plot rendering, mic capture wiring, and UI state.
 * ───────────────────────────────────────────────────────────────────── */

// ── Loaded-file list ────────────────────────────────────────────────────
function _freshFile(id, name) {
  return {
    id, name,
    samples: null, sr: 48000, channels: 1, isStereo: false,
    showChannel: 'l', lCache: null, rCache: null,
    status: '', statusCls: '',
    compareSelected: false, recording: false,
  };
}
const MAX_COMPARE = 6;   // most rows Compare mode will stack at once
let _files = [];
let _nextId = 1;
let _diffId1 = null;     // "①" — Difference/Mirror
let _diffId2 = null;     // "②" — Difference/Mirror

function _getFile(id) { return _files.find(f => f.id === id); }
function _fileNum(id) { return _files.findIndex(f => f.id === id) + 1; }
function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Single mode has no separate "focus" concept — it shows whichever checked
// (Compare-selected) file sits highest in the list, so the same checkbox
// controls both "included in Compare's rows" and "the current Single-view
// pick." Checking a higher file bumps it in front of ones already checked;
// unchecking it reveals the next-highest checked file underneath.
function _singleTargetId() {
  const f = _files.find(x => x.compareSelected);
  return f ? f.id : null;
}

// New files are auto-enrolled into the two "active" comparisons — Compare
// selection (up to MAX_COMPARE, which doubles as Single mode's pick) and
// the Difference ①/② pair — so the tool has something to show immediately,
// while the sidebar's checkbox/①/② controls remain free to override the
// choice at any time.
function _autoAssignNewFile(f) {
  if (_diffId1 == null) _diffId1 = f.id;
  else if (_diffId2 == null && f.id !== _diffId1) _diffId2 = f.id;
  if (_files.filter(x => x.compareSelected).length < MAX_COMPARE) f.compareSelected = true;
}

let _mode = 'single';   // 'single' | 'compare' | 'diff' | 'live'

// ── Plot initialisation ───────────────────────────────────────────────
const _pcfg = { ...pcfg, toImageButtonOptions: { format: 'png', scale: 2, filename: 'spectrogram' } };
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff',
});
let _logFreq = false;

Plotly.newPlot('diff-plot', [], _wl('Difference: ① − ②', 'Time (s)', 'Frequency (Hz)'), _pcfg);
Plotly.newPlot('live-plot', [], _wl('Live Spectrogram', 'Time (s)', 'Frequency (Hz)'), _pcfg);

// ── File loading (WAV, MP3, or FRF files IFFT'd to an impulse response) ──
// WAV bytes go straight to Python (scipy reads the format directly). MP3 —
// and anything else scipy can't parse — is decoded first via the browser's
// own Web Audio decoder (decodeAudioData), then the resulting float samples
// are handed to Python exactly like a WAV would be. FRF files (.trf/.trv/
// .avc/.avr/.csv/.mat) go through the IFFT-to-impulse-response path.
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
  if (_recordingId) stopRecording();
  const id = String(_nextId++);
  const f = _freshFile(id, file.name);
  f.status = 'reading…';
  _files.push(f);
  _autoAssignNewFile(f);
  _renderFileList();
  _refreshCurrentView();

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onerror = () => _setFileStatus(id, 'read error', 'err');
  reader.onload = async e => {
    if (ext === 'wav') {
      if (!window.pySpecLoadWav) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      window.pySpecLoadWav(id, file.name, new Uint8Array(e.target.result));
    } else if (FRF_EXTS.includes(ext)) {
      if (!window.pySpecLoadComplex) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      window.pySpecLoadComplex(id, file.name, new Uint8Array(e.target.result));
    } else {
      // mp3 and anything else — decode client-side via Web Audio first.
      if (!window.pySpecLoadDecodedAudio) { _setFileStatus(id, 'Python not ready — try again in a moment', 'err'); return; }
      try {
        const { samples, sr, nChannels } = await _decodeAudioFile(e.target.result);
        window.pySpecLoadDecodedAudio(id, file.name, samples, sr, nChannels);
      } catch (err) {
        _setFileStatus(id, 'could not decode audio: ' + err.message.slice(0, 60), 'err');
      }
    }
  };
  reader.readAsArrayBuffer(file);
}

window.onSpecSampleResult = function(slot, samplesArr, sr, nChannels, info, stereo) {
  const f = _getFile(slot);
  if (!f) return;   // file was removed before this async result arrived
  // A just-finalized recording still has its "Recording…" placeholder name —
  // give it a real one now that it's a static sample like any loaded file.
  // (recording is already flipped false by stopRecording() before this
  // async result arrives, so the name itself is the only reliable marker.)
  if (f.name === 'Recording…') f.name = 'Mic recording';
  f.samples  = new Float32Array(samplesArr);
  f.sr       = +sr;
  f.channels = +nChannels;
  f.isStereo = !!stereo;
  f.showChannel = 'l';
  f.status = info; f.statusCls = 'ok';
  f.recording = false;
  // A changed sample invalidates any cached numeric diff grid, regardless of
  // which mode is active right now — otherwise switching into Difference
  // mode later (or Mirror's 3D Signed-Diff style, which reads _diffCache
  // directly) could render a stale ①−② computed against the old sample.
  _diffCache = null;
  _renderFileList();
  const shown = _panelIdsForMode();
  if (shown.includes(f.id)) renderSpec(f.id);
  if (_mode === 'diff') _maybeRequestDiff();
};

window.onSpecSampleError = function(slot, msg) {
  const f = _getFile(slot);
  if (!f) return;
  f.samples = null;
  f.status = 'error: ' + msg; f.statusCls = 'err';
  _renderFileList();
};

window.onSpecError = function(slot, msg) {
  if (slot === 'live') {
    const el = document.getElementById('live-status');
    el.textContent = 'error: ' + msg;
    el.className = 'sp-panel-status err';
    return;
  }
  const f = _getFile(slot);
  if (!f) return;
  f.status = 'error: ' + msg; f.statusCls = 'err';
  _renderFileList();
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

window.onSpecSpectrogramResult = function(slot, channel, times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  const cache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  if (slot === 'live') {
    _renderGrid('live-plot', cache, 'Live Spectrogram', false);
    renderFrameInfo('live', cache.times, cache.freqs);
    return;
  }
  const f = _getFile(slot);
  if (!f) return;
  if (channel === 'r') f.rCache = cache; else f.lCache = cache;
  if (f.showChannel === channel) {
    const shown = _panelIdsForMode();
    if (shown.includes(f.id)) {
      // Redraw every currently-shown panel, not just this one — the shared
      // intensity range (see _globalDbRange) this update may have shifted.
      shown.forEach(renderSpec);
    }
  }
};

// zDb from _unpackSpec is (nFreqBins rows × nTimeFrames cols) — already the
// right shape for Plotly's heatmap/surface z (rows=y=freq, cols=x=time), so
// Heatmap/Surface use it directly. Waterfall needs the opposite (one row per
// time frame, to pull out a freq/dB curve per slice), so it still transposes.
function _transpose(z) {
  const nRows = z.length, nCols = z[0].length;
  const t = new Array(nCols);
  for (let j = 0; j < nCols; j++) {
    const row = new Array(nRows);
    for (let i = 0; i < nRows; i++) row[i] = z[i][j];
    t[j] = row;
  }
  return t;
}

function _dataMinMax(zDb) {
  let lo = Infinity, hi = -Infinity;
  for (const row of zDb) for (const v of row) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { min: lo, max: hi };
}

// A single dB range spanning every loaded file (not just whichever happens
// to be currently shown/checked) — with no explicit range each panel would
// otherwise auto-scale its own heatmap/surface to its OWN min/max, so the
// hottest colour in one panel and the hottest colour in another could mean
// two different dB values, and switching which files are checked would
// shift the scale under you. Computing it across the whole loaded set
// instead means a given dB always reads as the same colour/height
// everywhere, and it only moves when a file is actually added or removed —
// never just from checking/unchecking or switching which one is shown.
function _globalDbRange() {
  let lo = Infinity, hi = -Infinity;
  for (const f of _files) {
    const cache = f.showChannel === 'r' ? f.rCache : f.lCache;
    if (!cache) continue;
    const mm = _dataMinMax(cache.zDb);
    if (mm.min < lo) lo = mm.min;
    if (mm.max > hi) hi = mm.max;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? { min: lo, max: hi } : null;
}

function renderSpec(id) {
  const f = _getFile(id);
  if (!f) return;
  const cache = f.showChannel === 'r' ? f.rCache : f.lCache;
  const el = document.getElementById(`spec-plot-${id}`);
  if (!cache || !el) return;
  const label = f.recording ? ' · Live'
    : f.isStereo ? (f.showChannel === 'r' ? ' · R channel' : ' · L channel') : '';
  _renderGrid(`spec-plot-${id}`, cache, `#${_fileNum(id)} ${f.name}` + label, false, undefined, _globalDbRange());
  renderFrameInfo(id, cache.times, cache.freqs);
}

// 3D scenes are WebGL-rendered, unlike the SVG text everywhere else in the
// page — they don't reliably resolve the layout's 'inherit' font-family the
// way 2D plots do, so an axis title left at the default can render
// invisibly even though it's set correctly in the data. Spelling out a real
// font here (and a decent size) is what actually puts the label on screen.
function _axisTitle(text) {
  return { text, font: { size: 30, family: 'Arial, sans-serif', color: cssVar('--text') || '#1a1a1a' } };
}

// ── Multi-view rendering: heatmap / 3D surface / waterfall ─────────────
// Shared by every panel and the Difference view — `isDiff` selects a
// diverging, zero-centred colour range so peaks/dips read as +/- dB.
function _maxAbs(zT) {
  let m = 0;
  for (const row of zT) for (const v of row) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  return m || 1;
}

function _waterfallTraces(freqs, times, zT, isDiff) {
  const nT = zT.length;   // time frames (rows, after transpose)
  const maxSlices = 30;
  const step = Math.max(1, Math.round(nT / maxSlices));
  let lo = Infinity, hi = -Infinity;
  for (const row of zT) for (const v of row) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = (hi - lo) || 1;
  const nSlicesShown = Math.ceil(nT / step);
  const offsetStep = Math.max(2, range / Math.max(1, nSlicesShown - 1) * 0.6);
  const zLabel = isDiff ? 'ΔdB' : 'dB';
  const traces = [];
  let idx = 0;
  for (let t = 0; t < nT; t += step) {
    const hue = 250 - (idx / Math.max(1, nSlicesShown - 1)) * 250;   // blue (early) → red (late)
    traces.push({
      x: freqs, y: zT[t].map(v => v + idx * offsetStep),
      // customdata carries the true (un-offset) dB value — y is shifted for
      // display, so hovering on y directly would show the wrong number.
      customdata: zT[t],
      type: 'scatter', mode: 'lines',
      line: { color: `hsl(${hue},70%,45%)`, width: 1 },
      name: `t=${times[t].toFixed(2)}s`,
      hovertemplate: `Freq: %{x:.0f} Hz<br>${zLabel}: %{customdata:.1f}<br>t=${times[t].toFixed(2)}s<extra></extra>`,
      showlegend: false,
    });
    idx++;
  }
  return traces;
}

function _renderGrid(divId, cache, title, isDiff, forceMode, range) {
  let mode = forceMode || document.getElementById('view-mode-sel').value;

  // Mirror is a Difference-only view (it juxtaposes ① and ② directly rather
  // than plotting a single grid) — a lone panel has nothing to mirror
  // against, so it falls back to Heatmap. (forceMode sidesteps this —
  // Mirror's own 3D Signed-Diff style calls back into this function with
  // forceMode:'surface' to reuse the surface-drawing code below directly,
  // rather than bouncing back into _renderMirror.)
  if (mode === 'mirror') {
    if (isDiff) { _renderMirror(divId, title); return; }
    mode = 'heatmap';
  }

  const { times, freqs, zDb } = cache;   // zDb: nFreqBins rows × nTimeFrames cols
  const colorscale = isDiff ? 'RdBu' : document.getElementById('colorscale-sel').value;

  const zLabel = isDiff ? 'ΔdB' : 'Level';
  const hoverTemplate3D = `Time: %{x:.3f} s<br>Freq: %{y:.0f} Hz<br>${zLabel}: %{z:.1f} dB<extra></extra>`;

  if (mode === 'surface') {
    const trace = { x: times, y: freqs, z: zDb, type: 'surface', colorscale, showscale: true,
      colorbar: { title: isDiff ? 'ΔdB' : 'dB', titleside: 'right', thickness: 10, tickfont: { size: 9 } },
      hovertemplate: hoverTemplate3D };
    // Plotly's built-in 'RdBu' maps low→red, high→blue — the opposite of the
    // ①-is-red/②-is-blue convention (see the legend in the diff toolbar), so
    // flip it: negative (② louder) → blue, positive (① louder) → red.
    if (isDiff) { const m = _maxAbs(zDb); trace.cmin = -m; trace.cmax = m; trace.reversescale = true; }
    else if (range) { trace.cmin = range.min; trace.cmax = range.max; }
    Plotly.react(divId, [trace], {
      title: { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
      font: { size: 10, family: 'inherit' },
      paper_bgcolor: '#fff',
      scene: {
        xaxis: { title: _axisTitle('Time (s)') },
        yaxis: { title: _axisTitle('Frequency (Hz)'), type: _logFreq ? 'log' : 'linear' },
        zaxis: { title: _axisTitle(isDiff ? 'ΔdB' : 'dB'), range: (!isDiff && range) ? [range.min, range.max] : undefined },
      },
      margin: { l: 30, r: 30, t: 28, b: 30 },
    }, _pcfg);
  } else if (mode === 'waterfall') {
    const zT = _transpose(zDb);   // (nTimes rows × nFreqs cols) — one row per time frame
    Plotly.react(divId, _waterfallTraces(freqs, times, zT, isDiff), _wl(title, 'Frequency (Hz)',
      isDiff ? 'ΔdB (offset per time slice)' : 'dB (offset per time slice)', {
        margin: { l: 50, r: 20, t: 26, b: 34 },
        xaxis: { type: _logFreq ? 'log' : 'linear' },
        showlegend: false,
      }), _pcfg);
  } else {
    const trace = { x: times, y: freqs, z: zDb, type: 'heatmap', colorscale, showscale: true,
      colorbar: { title: isDiff ? 'ΔdB' : 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } },
      zsmooth: 'fast', hovertemplate: hoverTemplate3D };
    if (isDiff) { const m = _maxAbs(zDb); trace.zmin = -m; trace.zmax = m; trace.reversescale = true; }
    else if (range) { trace.zmin = range.min; trace.zmax = range.max; }
    Plotly.react(divId, [trace], _wl(title, 'Time (s)', 'Frequency (Hz)', {
      margin: { l: 50, r: 45, t: 14, b: 20 },
      yaxis: { type: _logFreq ? 'log' : 'linear' },
    }), _pcfg);
  }
}

// ── Mirror view: ① on the left, ② on the right ─────────────────────────
// Unlike Heatmap/Surface/Waterfall, Mirror doesn't subtract ① from ② — it
// shows each file's own spectrogram directly, split around a centre line,
// so you compare shapes visually rather than reading a computed difference.
// Two sub-styles, toggled via the "Mirror: …" toolbar button:
//   'freq' (default) — shared frequency axis (Y), like a population pyramid:
//       time is collapsed to a mean-dB-per-bin spectrum for each file.
//   'time' — shared time axis (Y), each side a full heatmap with frequency
//       (X) increasing outward from the centre line.
let _mirrorAxis = 'freq';           // 'freq' | 'time' — ignored when _mirror3D is on
let _mirrorStyle = 'independent';   // 'independent' | 'diff'
let _mirror3D = false;              // flat 2D pyramid/mirrored-heatmap vs literal 3D surfaces
const MIRROR_COLOR_A = '#b2182b';   // matches the ①-louder/②-louder legend swatches
const MIRROR_COLOR_B = '#2166ac';

function _avgSpectrum(cache) {
  // Mean dB per frequency bin across all time frames — a display-only
  // approximation (a true average would mean over linear power, not dB);
  // fine for "which regions run hotter," not for precise level readings.
  return cache.zDb.map(row => row.reduce((s, v) => s + v, 0) / (row.length || 1));
}

// Linear interpolation, boundary-clamped — same convention as main.py's
// np.interp (used for the numeric Difference view's frequency alignment).
function _interp1(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}

function _renderMirrorByFreq(divId, title, aCache, bCache) {
  const freqsA = aCache.freqs, freqsB = bCache.freqs;
  const avgA = _avgSpectrum(aCache), avgB = _avgSpectrum(bCache);
  const fMin = Math.min(freqsA[0], freqsB[0]), fMax = Math.max(freqsA.at(-1), freqsB.at(-1));

  if (_mirrorStyle === 'diff') {
    // True subtraction: avg(①) − avg(②), with ②'s average resampled onto
    // ①'s frequency bins first (1-D, same idea as main.py's _compute_diff,
    // just frequency-only since time is already collapsed to a mean here).
    // Positive (① louder) → x negative → extends left, red. Negative (②
    // louder) → x positive → extends right, blue. Split into two traces so
    // each half gets its own fill colour — Plotly can't colour one fill by
    // sign, so wherever a trace's sign doesn't apply its value is zeroed.
    const diff = freqsA.map((f, i) => avgA[i] - _interp1(f, freqsB, avgB));
    const xLeft  = diff.map(d => d > 0 ? -d : 0);
    const xRight = diff.map(d => d < 0 ? -d : 0);
    Plotly.react(divId, [
      { x: xLeft, y: freqsA, customdata: diff, type: 'scatter', mode: 'lines', fill: 'tozerox',
        fillcolor: MIRROR_COLOR_A + '55', line: { color: MIRROR_COLOR_A, width: 1 },
        name: '① louder', hovertemplate: 'Freq: %{y:.0f} Hz<br>ΔdB: %{customdata:.1f}<extra></extra>' },
      { x: xRight, y: freqsA, customdata: diff, type: 'scatter', mode: 'lines', fill: 'tozerox',
        fillcolor: MIRROR_COLOR_B + '55', line: { color: MIRROR_COLOR_B, width: 1 },
        name: '② louder', hovertemplate: 'Freq: %{y:.0f} Hz<br>ΔdB: %{customdata:.1f}<extra></extra>' },
    ], _wl(title + ' (Δ = ① − ②)', '← ① louder · ② louder →', 'Frequency (Hz)', {
      margin: { l: 55, r: 20, t: 26, b: 34 },
      xaxis: { showticklabels: false, zeroline: true, zerolinewidth: 1, zerolinecolor: cssVar('--border') },
      yaxis: { type: _logFreq ? 'log' : 'linear', range: _logFreq ? undefined : [fMin, fMax] },
      showlegend: false,
    }), _pcfg);
    return;
  }

  // Independent (default): each file's own average, not a subtraction — see
  // the module comment above for why.
  // reduce(), not Math.min(...arr) — spreading a large array into a function
  // call can overflow the JS argument stack.
  const floor = Math.min(avgA.reduce((m, v) => Math.min(m, v), Infinity),
                          avgB.reduce((m, v) => Math.min(m, v), Infinity));
  const extentA = avgA.map(v => -(v - floor));   // negative → extends left
  const extentB = avgB.map(v => v - floor);      // positive → extends right

  Plotly.react(divId, [
    { x: extentA, y: freqsA, customdata: avgA, type: 'scatter', mode: 'lines', fill: 'tozerox',
      fillcolor: MIRROR_COLOR_A + '55', line: { color: MIRROR_COLOR_A, width: 1 },
      name: '①', hovertemplate: '①<br>Freq: %{y:.0f} Hz<br>Level: %{customdata:.1f} dB<extra></extra>' },
    { x: extentB, y: freqsB, customdata: avgB, type: 'scatter', mode: 'lines', fill: 'tozerox',
      fillcolor: MIRROR_COLOR_B + '55', line: { color: MIRROR_COLOR_B, width: 1 },
      name: '②', hovertemplate: '②<br>Freq: %{y:.0f} Hz<br>Level: %{customdata:.1f} dB<extra></extra>' },
  ], _wl(title, '← ① · ② →', 'Frequency (Hz)', {
    margin: { l: 55, r: 20, t: 26, b: 34 },
    xaxis: { showticklabels: false, zeroline: true, zerolinewidth: 1, zerolinecolor: cssVar('--border') },
    yaxis: { type: _logFreq ? 'log' : 'linear', range: _logFreq ? undefined : [fMin, fMax] },
    showlegend: false,
  }), _pcfg);
}

function _renderMirrorByTime(divId, title, aCache, bCache) {
  // zDb is already freq-major (one row per freq bin) — exactly the shape
  // needed here, since frequency is now the mirrored/split axis (y) and
  // time is shared (x). customdata carries each row's true (positive) freq,
  // since ①'s y values themselves are negated for the mirror.
  const custA = aCache.freqs.map(f => aCache.times.map(() => f));
  const custB = bCache.freqs.map(f => bCache.times.map(() => f));
  const colorscale = document.getElementById('colorscale-sel').value;
  const fMax = Math.max(aCache.freqs.at(-1), bCache.freqs.at(-1));
  // Two heatmap traces in one figure still auto-scale colour independently
  // unless given the same explicit range — share one so a given dB reads as
  // the same colour on both sides of the mirror.
  const rangeA = _dataMinMax(aCache.zDb), rangeB = _dataMinMax(bCache.zDb);
  const zmin = Math.min(rangeA.min, rangeB.min), zmax = Math.max(rangeA.max, rangeB.max);

  Plotly.react(divId, [
    { x: aCache.times, y: aCache.freqs.map(f => -f), z: aCache.zDb, customdata: custA,
      type: 'heatmap', colorscale, showscale: false, zsmooth: 'fast', zmin, zmax,
      hovertemplate: '①<br>Time: %{x:.3f} s<br>Freq: %{customdata:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>' },
    { x: bCache.times, y: bCache.freqs, z: bCache.zDb, customdata: custB,
      type: 'heatmap', colorscale, showscale: true, zmin, zmax,
      colorbar: { title: 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } }, zsmooth: 'fast',
      hovertemplate: '②<br>Time: %{x:.3f} s<br>Freq: %{customdata:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>' },
  ], _wl(title, 'Time (s)', '↓ ① · Frequency (Hz) · ② ↑', {
    margin: { l: 55, r: 45, t: 26, b: 34 },
    // Log scale is undefined for negative Y (①'s mirrored side), so this
    // sub-view is linear-only regardless of the Freq: Lin/Log toggle.
    yaxis: { range: [-fMax, fMax], zeroline: true, zerolinewidth: 1, zerolinecolor: cssVar('--border') },
  }), _pcfg);
}

// 3D style, Independent: ① and ② each as their own full, time-resolved 3D
// surface (X=time, Y=freq, Z=dB), overlaid semi-transparent in one scene —
// unlike the flat pyramid, nothing is collapsed to a mean, so this is
// literally each file's whole spectrogram as terrain you can rotate to see
// where one pokes above the other. Solid (non-diverging) per-surface
// colours matching the ①-red/②-blue legend, since here colour just
// distinguishes the two surfaces rather than encoding a difference.
function _renderMirror3DIndependent(divId, title, aCache, bCache) {
  const hover = label => `${label}<br>Time: %{x:.3f} s<br>Freq: %{y:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>`;
  Plotly.react(divId, [
    { x: aCache.times, y: aCache.freqs, z: aCache.zDb, type: 'surface', showscale: false, opacity: 0.75,
      colorscale: [[0, MIRROR_COLOR_A], [1, MIRROR_COLOR_A]], hovertemplate: hover('①'), name: '①' },
    { x: bCache.times, y: bCache.freqs, z: bCache.zDb, type: 'surface', showscale: false, opacity: 0.75,
      colorscale: [[0, MIRROR_COLOR_B], [1, MIRROR_COLOR_B]], hovertemplate: hover('②'), name: '②' },
  ], {
    title: { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
    font: { size: 10, family: 'inherit' },
    paper_bgcolor: '#fff',
    scene: {
      xaxis: { title: _axisTitle('Time (s)') },
      yaxis: { title: _axisTitle('Frequency (Hz)'), type: _logFreq ? 'log' : 'linear' },
      zaxis: { title: _axisTitle('dB') },
    },
    margin: { l: 30, r: 30, t: 28, b: 30 },
  }, _pcfg);
}

function _renderMirror(divId, title) {
  const a = _getFile(_diffId1), b = _getFile(_diffId2);
  if (!a || !b || !a.lCache || !b.lCache) {
    Plotly.react(divId, [], _wl(title, '', '', {}), _pcfg);
    return;
  }
  if (_mirror3D) {
    if (_mirrorStyle === 'diff') {
      // A literal 3D mountains/valleys surface of the true ①−② difference
      // needs the full, un-collapsed (time, freq) diff grid — the same data
      // the numeric Difference view's own 3D Surface uses — so this reuses
      // _renderGrid's surface-drawing code directly (forceMode:'surface'
      // sidesteps its usual "Plot type is mirror" redirect) rather than
      // duplicating cmin/cmax/reversescale/hover logic here.
      if (!_diffCache) { _fetchDiffGrid(); return; }
      _renderGrid(divId, _diffCache, title + ' (Δ = ① − ②)', true, 'surface');
    } else {
      _renderMirror3DIndependent(divId, title, a.lCache, b.lCache);
    }
    return;
  }
  if (_mirrorAxis === 'freq') _renderMirrorByFreq(divId, title, a.lCache, b.lCache);
  else _renderMirrorByTime(divId, title, a.lCache, b.lCache);
}

window.specToggleMirrorAxis = function() {
  _mirrorAxis = _mirrorAxis === 'freq' ? 'time' : 'freq';
  document.getElementById('mirror-axis-btn').textContent =
    _mirrorAxis === 'freq' ? 'Mirror: Frequency' : 'Mirror: Time';
  _updateDiffLegend();
  _updateMirrorStyleBtn();
  if (_mode === 'diff') _renderMirror('diff-plot', _diffTitle());
};

window.specToggleMirrorStyle = function() {
  _mirrorStyle = _mirrorStyle === 'independent' ? 'diff' : 'independent';
  document.getElementById('mirror-style-btn').textContent =
    _mirrorStyle === 'diff' ? 'Mirror: Signed Diff' : 'Mirror: Independent';
  if (_mode === 'diff') _renderMirror('diff-plot', _diffTitle());
};

window.specToggleMirror3D = function() {
  _mirror3D = !_mirror3D;
  document.getElementById('mirror-3d-btn').textContent = _mirror3D ? 'Mirror: 3D Surface' : 'Mirror: Flat';
  _updateDiffLegend();
  _updateMirrorAxisBtn();
  _updateMirrorStyleBtn();
  if (_mode === 'diff') _renderMirror('diff-plot', _diffTitle());
};

// The mirror-axis toggle only makes sense in flat Mirror mode — 3D doesn't
// need it (overlapping surfaces + rotation separate ① and ② without having
// to pick which axis to mirror on).
function _updateMirrorAxisBtn() {
  const btn = document.getElementById('mirror-axis-btn');
  const show = _mode === 'diff' && document.getElementById('view-mode-sel').value === 'mirror' && !_mirror3D;
  btn.style.display = show ? '' : 'none';
}

// The 3D-surface toggle applies to Mirror mode regardless of axis sub-mode.
function _updateMirror3DBtn() {
  const btn = document.getElementById('mirror-3d-btn');
  const show = _mode === 'diff' && document.getElementById('view-mode-sel').value === 'mirror';
  btn.style.display = show ? '' : 'none';
}

// The Independent/Signed-Diff style toggle exists for Mirror-by-frequency
// (flat) and for either axis once 3D is on — 3D always draws it (twin
// surfaces vs one true-diff surface), so the axis choice stops mattering.
// Flat Mirror-by-time still has no such distinction implemented.
function _updateMirrorStyleBtn() {
  const btn = document.getElementById('mirror-style-btn');
  const show = _mode === 'diff' && document.getElementById('view-mode-sel').value === 'mirror'
    && (_mirror3D || _mirrorAxis === 'freq');
  btn.style.display = show ? '' : 'none';
}

// The ①-red/②-blue legend applies to Heatmap/3D Surface (colour encodes the
// sign of ①−②), Mirror-by-frequency (①'s fill/line is literally drawn in
// the same red, ②'s in the same blue), and Mirror's 3D style (same
// convention, either as two solid-coloured surfaces or one reversed-RdBu
// diff surface). It's hidden for Waterfall (colour means time there) and
// flat Mirror-by-time (heatmaps use the selected sequential colorscale).
function _updateDiffLegend() {
  const legend = document.getElementById('diff-legend');
  const mode = document.getElementById('view-mode-sel').value;
  const hide = mode === 'waterfall' || (mode === 'mirror' && _mirrorAxis === 'time' && !_mirror3D);
  legend.style.display = hide ? 'none' : '';
}

window.specViewModeChanged = function() {
  _updateDiffLegend();
  _updateMirrorAxisBtn();
  _updateMirror3DBtn();
  _updateMirrorStyleBtn();
  const mode = document.getElementById('view-mode-sel').value;
  // Flat Mirror renders straight from ①/②'s own already-computed
  // spectrograms, no interpolated diff grid needed — but Mirror's 3D
  // Signed-Diff style does need it (see _renderMirror), same as every
  // non-Mirror view, so only skip the fetch for flat/Independent Mirror.
  const needsDiffCache = !(mode === 'mirror' && !(_mirror3D && _mirrorStyle === 'diff'));
  if (_mode === 'diff' && needsDiffCache && !_diffCache) {
    _maybeRequestDiff();
    return;
  }
  specRenderAll();
};

function renderFrameInfo(id, times, freqs) {
  const el = document.getElementById(`frame-info-${id}`);
  if (!el) return;
  if (!times.length || !freqs.length) { el.textContent = '–'; return; }
  const dt = times.length > 1 ? times[1] - times[0] : 0;
  const df = freqs.length > 1 ? freqs[1] - freqs[0] : 0;
  el.textContent =
    `${times.length}×${freqs.length} (t×f)  ·  ${(dt * 1000).toFixed(1)} ms/frame  ·  ${df.toFixed(1)} Hz/bin`;
}

// ── Settings (shared across every loaded file) ─────────────────────────
function specSettingsChanged() {
  const nFft = +document.getElementById('n-fft-sel').value;
  let hop = +document.getElementById('hop-sel').value;
  if (hop >= nFft) {
    hop = Math.max(128, nFft / 4);
    document.getElementById('hop-sel').value = String(hop);
  }
  const fMax = +document.getElementById('fmax-inp').value;
  const semitones = +document.getElementById('semitone-sel').value;
  if (!window.pySpecRecompute) return;
  window.pySpecRecompute(nFft, hop, fMax, semitones);
  // A settings change invalidates any cached numeric diff grid — flat Mirror
  // doesn't need it (it reads ①/②'s own spectrograms directly, which
  // pySpecRecompute above just refreshed), but Mirror's 3D Signed-Diff style
  // does, so null it unconditionally and let _renderMirror re-fetch lazily.
  _diffCache = null;
  if (_mode === 'diff') _maybeRequestDiff();
}

function specRenderAll() {
  _panelIdsForMode().forEach(renderSpec);
  if (_mode !== 'diff') return;
  if (document.getElementById('view-mode-sel').value === 'mirror') {
    _renderMirror('diff-plot', _diffTitle());
  } else if (_diffCache) {
    _renderGrid('diff-plot', _diffCache, _diffTitle(), true);
  }
}

window.specToggleChannel = function(id) {
  const f = _getFile(id);
  if (!f) return;
  f.showChannel = f.showChannel === 'l' ? 'r' : 'l';
  _renderFileList();
  const shown = _panelIdsForMode();
  if (shown.includes(id)) shown.forEach(renderSpec);
};

window.specToggleFreqScale = function() {
  _logFreq = !_logFreq;
  const btn = document.getElementById('freq-scale-btn');
  btn.textContent = _logFreq ? 'Freq: Log' : 'Freq: Lin';
  btn.classList.toggle('active', _logFreq);
  specRenderAll();
};

// ── Single vs Compare vs Difference vs Live mode ────────────────────────
// Single shows the highest-checked file (see _singleTargetId), full width.
// Compare stacks up to MAX_COMPARE sidebar-checked files as rows. Difference computes
// ①'s spectrogram minus ②'s (interpolated onto ①'s frequency/time grid —
// see main.py's _compute_diff) so intensity differences show as "mountains
// and valleys" rather than raw dB.
let _diffCache = null;

function _panelIdsForMode() {
  if (_mode === 'single') { const id = _singleTargetId(); return id != null ? [id] : []; }
  if (_mode === 'compare') return _files.filter(f => f.compareSelected).slice(0, MAX_COMPARE).map(f => f.id);
  return [];
}

function _rebuildComparePanels() {
  const el = document.getElementById('compare-view');
  const ids = _panelIdsForMode();
  if (!ids.length) {
    el.innerHTML = `<div class="sp-file-empty" style="margin:auto;font-size:12px">` +
      (_mode === 'single' ? 'Tick a file’s checkbox in the sidebar to see it here'
        : `Tick the checkbox on up to ${MAX_COMPARE} sidebar files to compare them`) +
      `</div>`;
    return;
  }
  el.innerHTML = ids.map(id => {
    const f = _getFile(id);
    return `<div class="sp-panel" data-file-id="${id}">
      <div class="sp-plot-row sp-spec-row"><div id="spec-plot-${id}" class="plot-div"></div></div>
      <div class="sp-panel-frameinfo" id="frame-info-${id}">–</div>
    </div>`;
  }).join('');
  ids.forEach(id => {
    const f = _getFile(id);
    Plotly.newPlot(`spec-plot-${id}`, [], _wl(`#${_fileNum(id)} ${f.name}`, 'Time (s)', 'Frequency (Hz)'), _pcfg);
    renderSpec(id);
  });
}

// Refreshes whichever of Single/Compare is on screen — the one thing all
// three call sites (a file loading, a checkbox changing, a file being
// removed, a settings change) actually need, so they can call this one
// function instead of remembering both modes individually.
function _refreshCurrentView() {
  if (_mode === 'single' || _mode === 'compare') _rebuildComparePanels();
}

function _diffTitle() {
  const a = _getFile(_diffId1), b = _getFile(_diffId2);
  return `Difference: ${a ? '①' + a.name : '①'} − ${b ? '②' + b.name : '②'}`;
}

function _updateDiffTitle() {
  document.getElementById('diff-title').textContent = _diffTitle();
}

window.specSetMode = function(mode) {
  const prevMode = _mode;
  _mode = mode;
  document.getElementById('mode-compare-btn').classList.toggle('active', mode === 'compare');
  document.getElementById('mode-single-btn').classList.toggle('active', mode === 'single');
  document.getElementById('mode-diff-btn').classList.toggle('active', mode === 'diff');
  document.getElementById('mode-live-btn').classList.toggle('active', mode === 'live');
  document.getElementById('compare-view').style.display =
    (mode === 'diff' || mode === 'live') ? 'none' : '';
  document.getElementById('diff-view').style.display = mode === 'diff' ? '' : 'none';
  document.getElementById('live-view').style.display = mode === 'live' ? '' : 'none';
  _updateMirrorAxisBtn();
  _updateMirror3DBtn();
  _updateMirrorStyleBtn();
  // Leaving Live mode releases the mic promptly rather than leaving it hot
  // in the background — same reasoning as the beforeunload safety net below.
  if (prevMode === 'live' && mode !== 'live' && _liveActive) stopLiveView();
  if (mode === 'single' || mode === 'compare') _rebuildComparePanels();
  if (mode === 'diff') {
    _updateDiffLegend();
    _updateDiffTitle();
    _maybeRequestDiff();
    // diff-view was just unhidden — its container had no measurable size
    // while display:none, so the plot just drawn needs an explicit resize.
    const el = document.getElementById('diff-plot');
    if (el) setTimeout(() => Plotly.Plots.resize(el), 0);
  } else if (mode === 'live') {
    const el = document.getElementById('live-plot');
    if (el) setTimeout(() => Plotly.Plots.resize(el), 0);
  }
};

// Actually kicks off the Python numeric-diff computation — the one thing
// that populates _diffCache. Called both by _maybeRequestDiff (non-Mirror
// views) and directly by _renderMirror's 3D Signed-Diff branch. Mirror must
// call this directly rather than going through _maybeRequestDiff: that
// function re-dispatches to _renderMirror whenever the view is Mirror, and
// _renderMirror's 3D-diff branch used to call _maybeRequestDiff right back
// when the cache was empty — an infinite synchronous loop that overflowed
// the call stack and silently aborted mid-render, leaving the plot stuck on
// stale data (the "some files stop updating" bug).
function _fetchDiffGrid() {
  if (!window.pySpecComputeDiff) return;
  const nFft = +document.getElementById('n-fft-sel').value;
  const hop  = +document.getElementById('hop-sel').value;
  const fMax = +document.getElementById('fmax-inp').value;
  const semitones = +document.getElementById('semitone-sel').value;
  const el = document.getElementById('diff-status');
  el.textContent = 'computing…';
  el.className = 'sp-panel-status';
  window.pySpecComputeDiff(_diffId1, _diffId2, nFft, hop, fMax, semitones);
}

function _maybeRequestDiff() {
  _updateDiffTitle();
  const a = _getFile(_diffId1), b = _getFile(_diffId2);
  const el = document.getElementById('diff-status');
  if (!a || !b || !a.samples || !b.samples) {
    el.textContent = 'choose two loaded files in the sidebar (① and ②)';
    el.className = 'sp-panel-status';
    _diffCache = null;
    if (document.getElementById('view-mode-sel').value === 'mirror') _renderMirror('diff-plot', _diffTitle());
    else Plotly.react('diff-plot', [], _wl(_diffTitle(), '', '', {}), _pcfg);
    return;
  }
  if (document.getElementById('view-mode-sel').value === 'mirror') {
    _renderMirror('diff-plot', _diffTitle());
    return;
  }
  _fetchDiffGrid();
}

window.onSpecDiffResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _diffCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  const el = document.getElementById('diff-status');
  el.textContent = '① − ②';
  el.className = 'sp-panel-status ok';
  if (_mode === 'diff') _renderGrid('diff-plot', _diffCache, _diffTitle(), true);
};

window.onSpecDiffError = function(msg) {
  const el = document.getElementById('diff-status');
  el.textContent = 'error: ' + msg;
  el.className = 'sp-panel-status err';
};

// ── Sidebar file list (Explore-style) ───────────────────────────────────
function _renderFileList() {
  const box = document.getElementById('file-list');
  if (!_files.length) {
    box.innerHTML = '<div class="sp-file-empty">Load a file, or hit Record, to get started</div>';
    return;
  }
  const singleId = _singleTargetId();
  box.innerHTML = _files.map((f, i) => {
    const num = i + 1;
    return `<div class="sp-file-row${f.id === singleId ? ' focused' : ''}${f.recording ? ' recording' : ''}" data-id="${f.id}">
      <div class="sp-file-row-top">
        <span class="sp-file-num">${num}.</span>
        <input type="checkbox" class="sp-file-cmp" data-id="${f.id}"${f.compareSelected ? ' checked' : ''} title="Compare (up to ${MAX_COMPARE}) — also controls Single: the topmost checked file is shown there">
        <span class="sp-file-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
        <button class="sp-file-remove" data-id="${f.id}" title="Remove" ${f.recording ? 'disabled' : ''}>✕</button>
      </div>
      <div class="sp-file-status ${f.statusCls}">${_esc(f.status)}</div>
      <div class="sp-file-row-ctl">
        <button class="sp-file-ctl-btn play-btn" data-id="${f.id}" ${f.samples ? '' : 'disabled'} title="Play/pause">${_playingId === f.id ? '■' : '▶'}</button>
        ${f.isStereo ? `<button class="sp-file-ctl-btn chan-btn" data-id="${f.id}" title="Toggle L/R channel">${f.showChannel === 'l' ? 'L' : 'R'}</button>` : ''}
        <span class="sp-file-ctl-gap"></span>
        <button class="sp-file-ctl-btn diff1-btn${_diffId1 === f.id ? ' on-1' : ''}" data-id="${f.id}" title="Use as ① in Difference/Mirror">①</button>
        <button class="sp-file-ctl-btn diff2-btn${_diffId2 === f.id ? ' on-2' : ''}" data-id="${f.id}" title="Use as ② in Difference/Mirror">②</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.sp-file-cmp').forEach(cb => cb.addEventListener('change', e => _toggleCompareSelect(e.target.dataset.id, e.target.checked)));
  box.querySelectorAll('.sp-file-remove').forEach(el => el.addEventListener('click', e => _removeFile(e.target.dataset.id)));
  box.querySelectorAll('.play-btn').forEach(el => el.addEventListener('click', e => togglePlay(e.target.dataset.id)));
  box.querySelectorAll('.chan-btn').forEach(el => el.addEventListener('click', e => window.specToggleChannel(e.target.dataset.id)));
  box.querySelectorAll('.diff1-btn').forEach(el => el.addEventListener('click', e => _setDiffSlot(e.target.dataset.id, 1)));
  box.querySelectorAll('.diff2-btn').forEach(el => el.addEventListener('click', e => _setDiffSlot(e.target.dataset.id, 2)));
}

function _toggleCompareSelect(id, checked) {
  const f = _getFile(id);
  if (!f) return;
  if (checked && _files.filter(x => x.compareSelected).length >= MAX_COMPARE) checked = false;   // cap
  f.compareSelected = checked;
  _renderFileList();
  // This checkbox drives Compare's row set and Single's pick, so either
  // mode may need a refresh.
  _refreshCurrentView();
}

function _removeFile(id) {
  const f = _getFile(id);
  if (!f || f.recording) return;
  _files = _files.filter(x => x.id !== id);
  if (_diffId1 === id) _diffId1 = null;
  if (_diffId2 === id) _diffId2 = null;
  if (_playingId === id) _stopPlayback();
  _renderFileList();
  _refreshCurrentView();
  if (_mode === 'diff') { _diffCache = null; _maybeRequestDiff(); }
}

function _setDiffSlot(id, which) {
  if (which === 1) {
    if (_diffId2 === id) _diffId2 = null;
    _diffId1 = _diffId1 === id ? null : id;   // clicking the active role again clears it
  } else {
    if (_diffId1 === id) _diffId1 = null;
    _diffId2 = _diffId2 === id ? null : id;
  }
  _diffCache = null;
  _renderFileList();
  if (_mode === 'diff') _maybeRequestDiff();
}

// ── Live microphone — shared low-level engine ───────────────────────────
// Mirrors Acquire's AudioWorkletNode capture pattern (Web/tools/acquire/acquire.js):
// an inline worklet posts raw Float32 audio, batched here into fixed-size chunks.
// Two consumers share this one engine — Recording (below) and the standalone
// Live view (further below) — since there's only one physical microphone;
// whichever starts first holds it until it stops.
const MIC_WORKLET_SRC = `
class SpecCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp[0] && inp[0].length > 0) this.port.postMessage(inp[0].slice());
    return true;
  }
}
registerProcessor('spec-capture', SpecCaptureProcessor);
`;
const MIC_BATCH_SIZE = 4096;

let _micUser = null;   // a slot id, 'live', or null — who currently holds the mic
let _micStream = null, _micCtx = null, _micSource = null, _micWorklet = null;
let _micBatch = null, _micBatchFill = 0, _micSr = 48000;
let _micOnBatch = null;   // callback(Float32Array) — a full MIC_BATCH_SIZE batch

// Acquires the mic and starts calling onBatch(Float32Array) once per full
// batch. Resolves with the actual AudioContext sample rate. Throws if the
// mic is already held by another consumer.
async function _micAcquire(user, onBatch) {
  if (_micUser) throw new Error('microphone already in use');
  _micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  _micCtx = new (window.AudioContext || window.webkitAudioContext)();
  const blobUrl = URL.createObjectURL(new Blob([MIC_WORKLET_SRC], { type: 'application/javascript' }));
  await _micCtx.audioWorklet.addModule(blobUrl);
  _micSource  = _micCtx.createMediaStreamSource(_micStream);
  _micWorklet = new AudioWorkletNode(_micCtx, 'spec-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
  _micBatch = new Float32Array(MIC_BATCH_SIZE);
  _micBatchFill = 0;
  _micSr = _micCtx.sampleRate;
  _micOnBatch = onBatch;
  _micWorklet.port.onmessage = e => {
    const chunk = e.data;
    let off = 0;
    while (off < chunk.length) {
      const room = MIC_BATCH_SIZE - _micBatchFill;
      const take = Math.min(room, chunk.length - off);
      _micBatch.set(chunk.subarray(off, off + take), _micBatchFill);
      _micBatchFill += take; off += take;
      if (_micBatchFill >= MIC_BATCH_SIZE && _micOnBatch) {
        _micOnBatch(_micBatch.slice());
        _micBatchFill = 0;
      }
    }
  };
  _micSource.connect(_micWorklet);
  _micUser = user;
  return _micSr;
}

function _micRelease() {
  // Detach the message handler first — disconnect() stops future audio flow
  // but doesn't cancel messages already in flight from the worklet thread,
  // so without this, one or two trailing batches can still arrive after
  // _micOnBatch is nulled below and throw.
  if (_micWorklet) { _micWorklet.port.onmessage = null; try { _micWorklet.disconnect(); } catch (_) {} _micWorklet = null; }
  if (_micSource)  { try { _micSource.disconnect(); }  catch (_) {} _micSource  = null; }
  if (_micStream)  { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  if (_micCtx)     { _micCtx.close().catch(() => {}); _micCtx = null; }
  _micOnBatch = null;
  _micUser = null;
}

// ── Recording — adds a new numbered file to the list ────────────────────
// Batches are (a) pushed to Python (pySpecMicPush) for a live rolling-window
// preview, using the same canonical compute_spectrogram() as everywhere
// else, and (b) kept in full so that on Stop the complete clip becomes the
// new file's sample (pySpecFinalizeRecording), just like a loaded file.
let _recordingId = null;
let _micFullChunks = [], _micFullLen = 0;

async function startRecording() {
  if (_micUser) return;
  const id = String(_nextId++);
  const f = _freshFile(id, 'Recording…');
  f.recording = true; f.status = 'listening…'; f.statusCls = 'ok';
  _files.push(f);
  _autoAssignNewFile(f);
  _renderFileList();
  _refreshCurrentView();
  try {
    _micFullChunks = []; _micFullLen = 0;
    const sr = await _micAcquire(id, batch => {
      _micFullChunks.push(batch); _micFullLen += batch.length;
      if (window.pySpecMicPush) window.pySpecMicPush(batch);
    });
    if (window.pySpecMicStart) window.pySpecMicStart(id, sr);
    _recordingId = id;
    _enterRecordingUI();
  } catch (e) {
    f.status = 'mic error: ' + e.message.slice(0, 60); f.statusCls = 'err'; f.recording = false;
    _renderFileList();
  }
}

function stopRecording() {
  const id = _recordingId;
  if (!id) return;
  const sr = _micSr;
  _micRelease();
  if (window.pySpecMicStop) window.pySpecMicStop();

  const full = new Float32Array(_micFullLen);
  let off = 0;
  for (const c of _micFullChunks) { full.set(c, off); off += c.length; }
  _micFullChunks = []; _micFullLen = 0;

  _recordingId = null;
  _exitRecordingUI();
  const f = _getFile(id);
  if (f) f.recording = false;

  if (full.length > 0 && window.pySpecFinalizeRecording) {
    if (f) { f.status = 'processing recording…'; f.statusCls = ''; }
    _renderFileList();
    window.pySpecFinalizeRecording(id, full, sr);
  } else {
    if (f) { f.status = 'no audio captured'; f.statusCls = 'err'; }
    _renderFileList();
  }
}

window.specToggleRecord = function() {
  if (_recordingId) stopRecording();
  else if (!_micUser) startRecording();
};

function _enterRecordingUI() {
  const btn = document.getElementById('record-btn');
  btn.textContent = '⏹ Stop';
  btn.classList.add('recording');
  const liveBtn = document.getElementById('live-btn');
  if (liveBtn) liveBtn.disabled = true;
}

function _exitRecordingUI() {
  const btn = document.getElementById('record-btn');
  btn.textContent = '🎤 Record';
  btn.classList.remove('recording');
  const liveBtn = document.getElementById('live-btn');
  if (liveBtn) liveBtn.disabled = false;
}

// ── Standalone Live view ─────────────────────────────────────────────────
// A dedicated "just watch the mic" mode for dialing in FFT window/hop/max-
// freq/smoothing/colorscale quickly, without adding anything to the file
// list. Reuses the exact same rolling-window ring buffer and throttled
// compute_spectrogram() in main.py that Recording's live preview already
// uses (pySpecMicStart/Push/Stop, keyed by a 'live' pseudo-slot) — settings
// changes take effect on the very next push since _mic_push always reads
// the current saved settings, so no Python changes were needed here.
let _liveActive = false;

async function startLiveView() {
  if (_micUser) return;
  try {
    const sr = await _micAcquire('live', batch => {
      if (window.pySpecMicPush) window.pySpecMicPush(batch);
    });
    if (window.pySpecMicStart) window.pySpecMicStart('live', sr);
    _liveActive = true;
    _enterLiveUI();
  } catch (e) {
    document.getElementById('live-status').textContent = 'mic error: ' + e.message.slice(0, 60);
    document.getElementById('live-status').className = 'sp-panel-status err';
    stopLiveView();
  }
}

function stopLiveView() {
  if (!_liveActive) { _micRelease(); return; }
  _micRelease();
  if (window.pySpecMicStop) window.pySpecMicStop();
  _liveActive = false;
  _exitLiveUI();
}

window.specToggleLive = function() {
  if (_liveActive) stopLiveView();
  else startLiveView();
};

function _enterLiveUI() {
  const btn = document.getElementById('live-btn');
  btn.textContent = '⏹ Stop Live';
  btn.classList.add('recording');
  const st = document.getElementById('live-status');
  st.textContent = 'listening…';
  st.className = 'sp-panel-status ok';
  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) recordBtn.disabled = true;
}

function _exitLiveUI() {
  const btn = document.getElementById('live-btn');
  btn.textContent = '🎙 Start Live';
  btn.classList.remove('recording');
  const st = document.getElementById('live-status');
  st.textContent = 'stopped';
  st.className = 'sp-panel-status';
  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) recordBtn.disabled = false;
}

// ── Settings / Info modals ──────────────────────────────────────────────
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
  document.getElementById('semitone-sel').value = '0';
  document.getElementById('colorscale-sel').value = 'Plasma';
  specSettingsChanged();
  specRenderAll();
};
window.specShowInfo = function() {
  document.getElementById('info-modal').classList.add('open');
};
window.specCloseInfo = function() {
  document.getElementById('info-modal').classList.remove('open');
};

// ── Playback ─────────────────────────────────────────────────────────────
// A small self-contained player rather than the shared AudioPlayer utility
// (js/audio.js) — AudioPlayer needs a fixed key→button-id map at
// construction time, which doesn't fit a file list that grows and shrinks
// at runtime. This mirrors what AudioPlayer.start() does internally.
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
window.specHelp = function() {
  window.open('https://github.com/chrisbuerginrogers/ObieApp', '_blank');
};

// Python signals ready. Restore saved FFT settings (from localStorage via config.py).
window.onPythonReady = function() {
  const s = window.obieSpecSettings;
  if (s) {
    if (s.n_fft) document.getElementById('n-fft-sel').value = String(s.n_fft);
    if (s.hop)   document.getElementById('hop-sel').value   = String(s.hop);
    if (s.f_max) document.getElementById('fmax-inp').value  = String(s.f_max);
    if (s.semitones) document.getElementById('semitone-sel').value = String(s.semitones);
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
    const ids = ['diff-plot', 'live-plot', ..._panelIdsForMode().map(id => `spec-plot-${id}`)];
    ids.forEach(pid => {
      const el = document.getElementById(pid);
      if (el && el.data) Plotly.Plots.resize(el);
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
  _renderFileList();
  specSetMode('single');   // matches the HTML's default active button
});
window.addEventListener('beforeunload', () => {
  if (_recordingId) stopRecording();
  if (_liveActive) stopLiveView();
});
