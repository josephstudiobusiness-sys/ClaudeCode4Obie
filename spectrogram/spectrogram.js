/* ─────────────────────────────────────────────────────────────────────
 * spectrogram.js  —  UI wiring for the Spectrogram tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), plotLayout(), pcfg, COL
 *   audio.js          — AudioPlayer
 *
 * Two independent "slots" (A/B) can each be loaded from a file or recorded
 * from the mic, so their spectrograms can be compared side by side. FFT
 * settings (window/hop/max-freq/colorscale/freq-axis-scale) are shared
 * across both slots so the comparison is apples-to-apples.
 *
 * All WAV/FRF decoding and STFT computation run in Python (main.py), using
 * the canonical ObieApp fileio/processing modules. This file only manages
 * playback state, plot rendering, mic capture wiring, and UI interactions.
 * ───────────────────────────────────────────────────────────────────── */

// ── Per-slot state ──────────────────────────────────────────────────────
function _freshSlot() {
  return {
    samples: null, sr: 48000, channels: 1, isStereo: false,
    showChannel: 'l', lCache: null, rCache: null,
  };
}
const slots = { a: _freshSlot(), b: _freshSlot() };

let _logFreq = false;

const player = new AudioPlayer({ a: 'play-btn-a', b: 'play-btn-b' });

// ── Plot initialisation ───────────────────────────────────────────────
const _pcfg = { ...pcfg, toImageButtonOptions: { format: 'png', scale: 2, filename: 'spectrogram' } };
const _wl = (title, xl, yl, extra) => ({
  ...plotLayout(title, xl, yl, extra), paper_bgcolor: '#fff', plot_bgcolor: '#fff',
});

['a', 'b'].forEach(slot => {
  Plotly.newPlot(`waveform-plot-${slot}`, [], _wl('Waveform', 'Time (s)', 'Amplitude'), _pcfg);
  Plotly.newPlot(`spec-plot-${slot}`,     [], _wl('Spectrogram', 'Time (s)', 'Frequency (Hz)'), _pcfg);
});
Plotly.newPlot('diff-plot', [], _wl('Difference: Sample A − Sample B', 'Time (s)', 'Frequency (Hz)'), _pcfg);
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

function loadFile(slot, input) {
  const file = input.files[0]; if (!file) return;
  if (_recordingSlot) stopRecording();
  document.getElementById(`wav-btn-text-${slot}`).textContent = file.name;
  setSt(slot, 'reading…');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onerror = () => setSt(slot, 'read error', 'err');
  reader.onload = async e => {
    if (ext === 'wav') {
      if (!window.pySpecLoadWav) { setSt(slot, 'Python not ready — try again in a moment', 'err'); return; }
      window.pySpecLoadWav(slot, file.name, new Uint8Array(e.target.result));
    } else if (FRF_EXTS.includes(ext)) {
      if (!window.pySpecLoadComplex) { setSt(slot, 'Python not ready — try again in a moment', 'err'); return; }
      window.pySpecLoadComplex(slot, file.name, new Uint8Array(e.target.result));
    } else {
      // mp3 and anything else — decode client-side via Web Audio first.
      if (!window.pySpecLoadDecodedAudio) { setSt(slot, 'Python not ready — try again in a moment', 'err'); return; }
      try {
        const { samples, sr, nChannels } = await _decodeAudioFile(e.target.result);
        window.pySpecLoadDecodedAudio(slot, file.name, samples, sr, nChannels);
      } catch (err) {
        setSt(slot, 'could not decode audio: ' + err.message.slice(0, 60), 'err');
      }
    }
  };
  reader.readAsArrayBuffer(file);
}

window.onSpecSampleResult = function(slot, samplesArr, sr, nChannels, info, stereo) {
  const s = slots[slot];
  s.samples  = new Float32Array(samplesArr);
  s.sr       = +sr;
  s.channels = +nChannels;
  s.isStereo = !!stereo;
  s.showChannel = 'l';
  setSt(slot, info, 'ok');
  document.getElementById(`play-btn-${slot}`).disabled = false;
  document.getElementById(`chan-btn-${slot}`).style.display = s.isStereo ? '' : 'none';
  updateChanBtn(slot);
  plotWaveform(slot);
  if (_mode === 'diff') _requestDiff();
};

window.onSpecSampleError = function(slot, msg) {
  slots[slot].samples = null;
  document.getElementById(`play-btn-${slot}`).disabled = true;
  setSt(slot, 'error: ' + msg, 'err');
};

window.onSpecError = function(slot, msg) {
  if (slot === 'live') {
    const el = document.getElementById('live-status');
    el.textContent = 'error: ' + msg;
    el.className = 'sp-panel-status err';
    return;
  }
  setSt(slot, 'error: ' + msg, 'err');
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
  const s = slots[slot];
  if (channel === 'r') s.rCache = cache; else s.lCache = cache;
  if (s.showChannel === channel) renderSpec(slot);
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

function renderSpec(slot) {
  const s = slots[slot];
  const cache = s.showChannel === 'r' ? s.rCache : s.lCache;
  if (!cache) return;
  const label = _recordingSlot === slot ? ' · Live'
    : s.isStereo ? (s.showChannel === 'r' ? ' · R channel' : ' · L channel') : '';
  _renderGrid(`spec-plot-${slot}`, cache, 'Spectrogram' + label, false);
  renderFrameInfo(slot, cache.times, cache.freqs);
}

// ── Multi-view rendering: heatmap / 3D surface / waterfall ─────────────
// Shared by Sample A, Sample B, and the Difference view — `isDiff` selects
// a diverging, zero-centred colour range so peaks/dips read as +/- dB.
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

function _renderGrid(divId, cache, title, isDiff) {
  let mode = document.getElementById('view-mode-sel').value;

  // Mirror is a Difference-only view (it juxtaposes Sample A and Sample B
  // directly rather than plotting a single grid) — a lone Sample A/B panel
  // has nothing to mirror against, so it falls back to Heatmap.
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
    // A-is-red/B-is-blue convention (see the legend in the diff toolbar), so
    // flip it: negative (B louder) → blue, positive (A louder) → red.
    if (isDiff) { const m = _maxAbs(zDb); trace.cmin = -m; trace.cmax = m; trace.reversescale = true; }
    Plotly.react(divId, [trace], {
      title: { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
      font: { size: 10, family: 'inherit' },
      paper_bgcolor: '#fff',
      scene: {
        xaxis: { title: 'Time (s)' },
        yaxis: { title: 'Frequency (Hz)', type: _logFreq ? 'log' : 'linear' },
        zaxis: { title: isDiff ? 'ΔdB' : 'dB' },
      },
      margin: { l: 0, r: 0, t: 28, b: 0 },
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
    Plotly.react(divId, [trace], _wl(title, 'Time (s)', 'Frequency (Hz)', {
      margin: { l: 50, r: 45, t: 26, b: 34 },
      yaxis: { type: _logFreq ? 'log' : 'linear' },
    }), _pcfg);
  }
}

// ── Mirror view: Sample A on the left, Sample B on the right ───────────
// Unlike Heatmap/Surface/Waterfall, Mirror doesn't subtract A from B — it
// shows each sample's own spectrogram directly, split around a centre line,
// so you compare shapes visually rather than reading a computed difference.
// Two sub-styles, toggled via the "Mirror: …" toolbar button:
//   'freq' (default) — shared frequency axis (Y), like a population pyramid:
//       time is collapsed to a mean-dB-per-bin spectrum for each sample.
//   'time' — shared time axis (Y), each side a full heatmap with frequency
//       (X) increasing outward from the centre line.
let _mirrorAxis = 'freq';           // 'freq' | 'time'
let _mirrorStyle = 'independent';   // 'independent' | 'diff' — freq-axis sub-mode only
const MIRROR_COLOR_A = '#b2182b';   // matches the A-louder/B-louder legend swatches
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
    // True subtraction: avg(A) − avg(B), with B's average resampled onto
    // A's frequency bins first (1-D, same idea as main.py's _compute_diff,
    // just frequency-only since time is already collapsed to a mean here).
    // Positive (A louder) → x negative → extends left, red. Negative (B
    // louder) → x positive → extends right, blue. Split into two traces so
    // each half gets its own fill colour — Plotly can't colour one fill by
    // sign, so wherever a trace's sign doesn't apply its value is zeroed.
    const diff = freqsA.map((f, i) => avgA[i] - _interp1(f, freqsB, avgB));
    const xLeft  = diff.map(d => d > 0 ? -d : 0);
    const xRight = diff.map(d => d < 0 ? -d : 0);
    Plotly.react(divId, [
      { x: xLeft, y: freqsA, customdata: diff, type: 'scatter', mode: 'lines', fill: 'tozerox',
        fillcolor: MIRROR_COLOR_A + '55', line: { color: MIRROR_COLOR_A, width: 1 },
        name: 'A louder', hovertemplate: 'Freq: %{y:.0f} Hz<br>ΔdB: %{customdata:.1f}<extra></extra>' },
      { x: xRight, y: freqsA, customdata: diff, type: 'scatter', mode: 'lines', fill: 'tozerox',
        fillcolor: MIRROR_COLOR_B + '55', line: { color: MIRROR_COLOR_B, width: 1 },
        name: 'B louder', hovertemplate: 'Freq: %{y:.0f} Hz<br>ΔdB: %{customdata:.1f}<extra></extra>' },
    ], _wl(title + ' (Δ = A − B)', '← A louder · B louder →', 'Frequency (Hz)', {
      margin: { l: 55, r: 20, t: 26, b: 34 },
      xaxis: { showticklabels: false, zeroline: true, zerolinewidth: 1, zerolinecolor: cssVar('--border') },
      yaxis: { type: _logFreq ? 'log' : 'linear', range: _logFreq ? undefined : [fMin, fMax] },
      showlegend: false,
    }), _pcfg);
    return;
  }

  // Independent (default): each sample's own average, not a subtraction —
  // see the module comment above for why.
  // reduce(), not Math.min(...arr) — spreading a large array into a function
  // call can overflow the JS argument stack.
  const floor = Math.min(avgA.reduce((m, v) => Math.min(m, v), Infinity),
                          avgB.reduce((m, v) => Math.min(m, v), Infinity));
  const extentA = avgA.map(v => -(v - floor));   // negative → extends left
  const extentB = avgB.map(v => v - floor);      // positive → extends right

  Plotly.react(divId, [
    { x: extentA, y: freqsA, customdata: avgA, type: 'scatter', mode: 'lines', fill: 'tozerox',
      fillcolor: MIRROR_COLOR_A + '55', line: { color: MIRROR_COLOR_A, width: 1 },
      name: 'Sample A', hovertemplate: 'Sample A<br>Freq: %{y:.0f} Hz<br>Level: %{customdata:.1f} dB<extra></extra>' },
    { x: extentB, y: freqsB, customdata: avgB, type: 'scatter', mode: 'lines', fill: 'tozerox',
      fillcolor: MIRROR_COLOR_B + '55', line: { color: MIRROR_COLOR_B, width: 1 },
      name: 'Sample B', hovertemplate: 'Sample B<br>Freq: %{y:.0f} Hz<br>Level: %{customdata:.1f} dB<extra></extra>' },
  ], _wl(title, '← Sample A · Sample B →', 'Frequency (Hz)', {
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
  // since Sample A's y values themselves are negated for the mirror.
  const custA = aCache.freqs.map(f => aCache.times.map(() => f));
  const custB = bCache.freqs.map(f => bCache.times.map(() => f));
  const colorscale = document.getElementById('colorscale-sel').value;
  const fMax = Math.max(aCache.freqs.at(-1), bCache.freqs.at(-1));

  Plotly.react(divId, [
    { x: aCache.times, y: aCache.freqs.map(f => -f), z: aCache.zDb, customdata: custA,
      type: 'heatmap', colorscale, showscale: false, zsmooth: 'fast',
      hovertemplate: 'Sample A<br>Time: %{x:.3f} s<br>Freq: %{customdata:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>' },
    { x: bCache.times, y: bCache.freqs, z: bCache.zDb, customdata: custB,
      type: 'heatmap', colorscale, showscale: true,
      colorbar: { title: 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } }, zsmooth: 'fast',
      hovertemplate: 'Sample B<br>Time: %{x:.3f} s<br>Freq: %{customdata:.0f} Hz<br>Level: %{z:.1f} dB<extra></extra>' },
  ], _wl(title, 'Time (s)', '↓ Sample A · Frequency (Hz) · Sample B ↑', {
    margin: { l: 55, r: 45, t: 26, b: 34 },
    // Log scale is undefined for negative Y (Sample A's mirrored side), so
    // this sub-view is linear-only regardless of the Freq: Lin/Log toggle.
    yaxis: { range: [-fMax, fMax], zeroline: true, zerolinewidth: 1, zerolinecolor: cssVar('--border') },
  }), _pcfg);
}

function _renderMirror(divId, title) {
  const a = slots.a, b = slots.b;
  if (!a.lCache || !b.lCache) {
    Plotly.react(divId, [], _wl(title, '', '', {}), _pcfg);
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
  if (_mode === 'diff') _renderMirror('diff-plot', 'Difference: Sample A − Sample B');
};

window.specToggleMirrorStyle = function() {
  _mirrorStyle = _mirrorStyle === 'independent' ? 'diff' : 'independent';
  document.getElementById('mirror-style-btn').textContent =
    _mirrorStyle === 'diff' ? 'Mirror: Signed Diff' : 'Mirror: Independent';
  if (_mode === 'diff') _renderMirror('diff-plot', 'Difference: Sample A − Sample B');
};

// The mirror-axis toggle only makes sense in Difference mode with Mirror
// selected — hidden otherwise so it doesn't sit around doing nothing.
function _updateMirrorAxisBtn() {
  const btn = document.getElementById('mirror-axis-btn');
  const show = _mode === 'diff' && document.getElementById('view-mode-sel').value === 'mirror';
  btn.style.display = show ? '' : 'none';
}

// The Independent/Signed-Diff style toggle only exists for Mirror-by-
// frequency — Mirror-by-time doesn't have this distinction implemented.
function _updateMirrorStyleBtn() {
  const btn = document.getElementById('mirror-style-btn');
  const show = _mode === 'diff' && document.getElementById('view-mode-sel').value === 'mirror'
    && _mirrorAxis === 'freq';
  btn.style.display = show ? '' : 'none';
}

// The A-red/B-blue legend applies to Heatmap/3D Surface (colour encodes the
// sign of A−B) and Mirror-by-frequency (A's fill/line is literally drawn in
// the same red, B's in the same blue). It's hidden for Waterfall (colour
// means time there) and Mirror-by-time (heatmaps use the selected sequential
// colorscale, not red/blue).
function _updateDiffLegend() {
  const legend = document.getElementById('diff-legend');
  const mode = document.getElementById('view-mode-sel').value;
  const hide = mode === 'waterfall' || (mode === 'mirror' && _mirrorAxis === 'time');
  legend.style.display = hide ? 'none' : '';
}

window.specViewModeChanged = function() {
  _updateDiffLegend();
  _updateMirrorAxisBtn();
  _updateMirrorStyleBtn();
  // Mirror doesn't need the interpolated diff grid — it renders straight
  // from Sample A/B's own already-computed spectrograms — so only fetch a
  // fresh diff when switching to a non-Mirror view that doesn't have one yet.
  if (_mode === 'diff' && document.getElementById('view-mode-sel').value !== 'mirror' && !_diffCache) {
    _requestDiff();
    return;
  }
  specRenderAll();
};

function renderFrameInfo(slot, times, freqs) {
  const el = document.getElementById(`frame-info-${slot}`);
  if (!times.length || !freqs.length) { el.textContent = '–'; return; }
  const dt = times.length > 1 ? times[1] - times[0] : 0;
  const df = freqs.length > 1 ? freqs[1] - freqs[0] : 0;
  el.textContent =
    `${times.length}×${freqs.length} (t×f)  ·  ${(dt * 1000).toFixed(1)} ms/frame  ·  ${df.toFixed(1)} Hz/bin`;
}

function plotWaveform(slot) {
  const s = slots[slot];
  if (!s.samples) return;
  const stride = s.isStereo ? 2 : 1;
  const n = Math.floor(s.samples.length / stride);
  const step = Math.max(1, Math.floor(n / 4000));
  const x = [], y = [];
  for (let i = 0; i < n; i += step) { x.push(i / s.sr); y.push(s.samples[i * stride]); }
  Plotly.react(`waveform-plot-${slot}`, [{
    x, y, type: 'scatter', mode: 'lines',
    line: { color: COL.wav, width: 1 }, showlegend: false,
  }], _wl('Waveform', 'Time (s)', 'Amplitude'), _pcfg);
}

// ── Settings (shared across both slots) ────────────────────────────────
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
  if (_mode === 'diff') {
    // Mirror doesn't use the interpolated diff grid — it reads Sample A/B's
    // own spectrograms directly, which pySpecRecompute above just refreshed.
    if (document.getElementById('view-mode-sel').value === 'mirror') {
      _renderMirror('diff-plot', 'Difference: Sample A − Sample B');
    } else {
      _requestDiff();
    }
  }
}

function specRenderAll() {
  renderSpec('a');
  renderSpec('b');
  if (_mode !== 'diff') return;
  if (document.getElementById('view-mode-sel').value === 'mirror') {
    _renderMirror('diff-plot', 'Difference: Sample A − Sample B');
  } else if (_diffCache) {
    _renderGrid('diff-plot', _diffCache, 'Difference: Sample A − Sample B', true);
  }
}

function updateChanBtn(slot) {
  const btn = document.getElementById(`chan-btn-${slot}`);
  btn.textContent = slots[slot].showChannel === 'l' ? 'Show R ▶' : '◀ Show L';
}

window.specToggleChannel = function(slot) {
  const s = slots[slot];
  s.showChannel = s.showChannel === 'l' ? 'r' : 'l';
  updateChanBtn(slot);
  renderSpec(slot);
};

window.specToggleFreqScale = function() {
  _logFreq = !_logFreq;
  const btn = document.getElementById('freq-scale-btn');
  btn.textContent = _logFreq ? 'Freq: Log' : 'Freq: Lin';
  btn.classList.toggle('active', _logFreq);
  specRenderAll();
};

// ── Compare vs Single vs Difference mode ────────────────────────────────
// Difference computes Sample A's spectrogram minus Sample B's (interpolated
// onto A's frequency/time grid — see main.py's _compute_diff) so intensity
// differences show as "mountains and valleys" rather than raw dB.
// Single reuses the same two panels as Compare (no separate plots/render
// path to maintain) — it just hides one side via CSS so the other fills
// the width.
let _mode = 'single';        // 'compare' | 'single' | 'diff'
let _singleSlot = 'a';       // which sample Single mode shows
let _diffCache = null;

function _applySingleClass() {
  const el = document.getElementById('compare-view');
  el.classList.remove('single-a', 'single-b');
  if (_mode === 'single') el.classList.add('single-' + _singleSlot);
}

window.specSetSingleSlot = function(slot) {
  _singleSlot = slot;
  document.getElementById('single-a-btn').classList.toggle('active', slot === 'a');
  document.getElementById('single-b-btn').classList.toggle('active', slot === 'b');
  _applySingleClass();
  [`waveform-plot-${slot}`, `spec-plot-${slot}`].forEach(id => {
    const el = document.getElementById(id); if (el) setTimeout(() => Plotly.Plots.resize(el), 0);
  });
};

window.specSetMode = function(mode) {
  const prevMode = _mode;
  _mode = mode;
  document.getElementById('mode-compare-btn').classList.toggle('active', mode === 'compare');
  document.getElementById('mode-single-btn').classList.toggle('active', mode === 'single');
  document.getElementById('mode-diff-btn').classList.toggle('active', mode === 'diff');
  document.getElementById('mode-live-btn').classList.toggle('active', mode === 'live');
  document.getElementById('compare-view').style.display = (mode === 'diff' || mode === 'live') ? 'none' : '';
  document.getElementById('diff-view').style.display = mode === 'diff' ? '' : 'none';
  document.getElementById('live-view').style.display = mode === 'live' ? '' : 'none';
  document.getElementById('single-slot-group').style.display = mode === 'single' ? '' : 'none';
  _applySingleClass();
  _updateMirrorAxisBtn();
  _updateMirrorStyleBtn();
  // Leaving Live mode releases the mic promptly rather than leaving it hot
  // in the background — same reasoning as the beforeunload safety net below.
  if (prevMode === 'live' && mode !== 'live' && _liveActive) stopLiveView();
  if (mode === 'diff') {
    _updateDiffLegend();
    if (document.getElementById('view-mode-sel').value === 'mirror') {
      _renderMirror('diff-plot', 'Difference: Sample A − Sample B');
    } else {
      _requestDiff();
    }
    // diff-view was just unhidden — its container had no measurable size
    // while display:none, so the plot just drawn needs an explicit resize.
    const el = document.getElementById('diff-plot');
    if (el) setTimeout(() => Plotly.Plots.resize(el), 0);
  } else if (mode === 'live') {
    const el = document.getElementById('live-plot');
    if (el) setTimeout(() => Plotly.Plots.resize(el), 0);
  } else {
    ['waveform-plot-a', 'spec-plot-a', 'waveform-plot-b', 'spec-plot-b'].forEach(id => {
      const el = document.getElementById(id); if (el) Plotly.Plots.resize(el);
    });
  }
};

function _requestDiff() {
  if (!slots.a.samples || !slots.b.samples) {
    const el = document.getElementById('diff-status');
    el.textContent = 'load or record both samples first';
    el.className = 'sp-panel-status';
    return;
  }
  if (!window.pySpecComputeDiff) return;
  const nFft = +document.getElementById('n-fft-sel').value;
  const hop  = +document.getElementById('hop-sel').value;
  const fMax = +document.getElementById('fmax-inp').value;
  const semitones = +document.getElementById('semitone-sel').value;
  const el = document.getElementById('diff-status');
  el.textContent = 'computing…';
  el.className = 'sp-panel-status';
  window.pySpecComputeDiff(nFft, hop, fMax, semitones);
}

window.onSpecDiffResult = function(times_js, freqs_js, flatZ_js, nFreqs, nTimes) {
  _diffCache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  const el = document.getElementById('diff-status');
  el.textContent = 'A − B';
  el.className = 'sp-panel-status ok';
  if (_mode === 'diff') _renderGrid('diff-plot', _diffCache, 'Difference: Sample A − Sample B', true);
};

window.onSpecDiffError = function(msg) {
  const el = document.getElementById('diff-status');
  el.textContent = 'error: ' + msg;
  el.className = 'sp-panel-status err';
};

// ── Live microphone — shared low-level engine ───────────────────────────
// Mirrors Acquire's AudioWorkletNode capture pattern (Web/tools/acquire/acquire.js):
// an inline worklet posts raw Float32 audio, batched here into fixed-size chunks.
// Two consumers share this one engine — per-slot Recording (below) and the
// standalone Live view (further below) — since there's only one physical
// microphone; whichever starts first holds it until it stops.
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

let _micUser = null;   // 'a' | 'b' | 'live' | null — who currently holds the mic
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

// ── Per-slot recording ───────────────────────────────────────────────────
// Batches are (a) pushed to Python (pySpecMicPush) for a live rolling-window
// preview, using the same canonical compute_spectrogram() as everywhere
// else, and (b) kept in full so that on Stop the complete clip becomes that
// slot's sample (pySpecFinalizeRecording), just like a loaded file.
let _recordingSlot = null;
let _micFullChunks = [], _micFullLen = 0;

async function startRecording(slot) {
  if (_micUser) return;
  try {
    _micFullChunks = []; _micFullLen = 0;
    const sr = await _micAcquire(slot, batch => {
      _micFullChunks.push(batch); _micFullLen += batch.length;
      if (window.pySpecMicPush) window.pySpecMicPush(batch);
    });
    if (window.pySpecMicStart) window.pySpecMicStart(slot, sr);
    _recordingSlot = slot;
    _enterRecordingUI(slot);
  } catch (e) {
    setSt(slot, 'mic error: ' + e.message.slice(0, 60), 'err');
    stopRecording();
  }
}

function stopRecording() {
  const slot = _recordingSlot;
  if (!slot) return;
  const sr = _micSr;
  _micRelease();
  if (window.pySpecMicStop) window.pySpecMicStop();

  const full = new Float32Array(_micFullLen);
  let off = 0;
  for (const c of _micFullChunks) { full.set(c, off); off += c.length; }
  _micFullChunks = []; _micFullLen = 0;

  _recordingSlot = null;
  _exitRecordingUI(slot);

  if (full.length > 0 && window.pySpecFinalizeRecording) {
    setSt(slot, 'processing recording…');
    window.pySpecFinalizeRecording(slot, full, sr);
  } else {
    setSt(slot, 'no audio captured', 'err');
  }
}

window.specToggleRecord = function(slot) {
  if (_recordingSlot === slot) stopRecording();
  else if (!_micUser) startRecording(slot);
};

function _enterRecordingUI(slot) {
  const other = slot === 'a' ? 'b' : 'a';
  const btn = document.getElementById(`mic-btn-${slot}`);
  btn.textContent = '⏹ Stop';
  btn.classList.add('recording');
  document.getElementById(`file-btn-label-${slot}`).style.display = 'none';
  document.getElementById(`mic-btn-${other}`).disabled = true;
  document.getElementById(`play-btn-${slot}`).disabled = true;
  document.getElementById(`chan-btn-${slot}`).style.display = 'none';
  const liveBtn = document.getElementById('live-btn');
  if (liveBtn) liveBtn.disabled = true;
  // Recordings are mono (channel 'l' only) — if this slot was showing a
  // stereo file's R channel, reset to 'l' or the live preview would never
  // render (onSpecSpectrogramResult only renders when channel === showChannel).
  slots[slot].samples = null;
  slots[slot].showChannel = 'l';
  slots[slot].rCache = null;
  Plotly.react(`waveform-plot-${slot}`, [], _wl('Waveform — shown once recording stops', 'Time (s)', 'Amplitude'), _pcfg);
  setSt(slot, 'listening…', 'ok');
}

function _exitRecordingUI(slot) {
  const other = slot === 'a' ? 'b' : 'a';
  const btn = document.getElementById(`mic-btn-${slot}`);
  btn.textContent = '🎤 Record';
  btn.classList.remove('recording');
  document.getElementById(`file-btn-label-${slot}`).style.display = '';
  document.getElementById(`mic-btn-${other}`).disabled = false;
  const liveBtn = document.getElementById('live-btn');
  if (liveBtn) liveBtn.disabled = false;
}

// ── Standalone Live view ─────────────────────────────────────────────────
// A dedicated "just watch the mic" mode for dialing in FFT window/hop/max-
// freq/smoothing/colorscale quickly, without loading the result into Sample
// A or B. Reuses the exact same rolling-window ring buffer and throttled
// compute_spectrogram() in main.py that per-slot recording's live preview
// already uses (pySpecMicStart/Push/Stop, keyed by a 'live' pseudo-slot) —
// settings changes take effect on the very next push since _mic_push always
// reads the current saved settings, so no Python changes were needed here.
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
  ['mic-btn-a', 'mic-btn-b'].forEach(id => { document.getElementById(id).disabled = true; });
}

function _exitLiveUI() {
  const btn = document.getElementById('live-btn');
  btn.textContent = '🎙 Start Live';
  btn.classList.remove('recording');
  const st = document.getElementById('live-status');
  st.textContent = 'stopped';
  st.className = 'sp-panel-status';
  ['mic-btn-a', 'mic-btn-b'].forEach(id => { document.getElementById(id).disabled = false; });
}

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
  document.getElementById('semitone-sel').value = '0';
  document.getElementById('colorscale-sel').value = 'Plasma';
  specSettingsChanged();
  specRenderAll();
};

// ── Playback ──────────────────────────────────────────────────────────
function togglePlay(slot) {
  const s = slots[slot];
  if (!s.samples) return;
  player.toggle(slot, s.samples, s.sr, s.isStereo ? 2 : 1);
}

// ── Help ──────────────────────────────────────────────────────────────
window.specHelp = function() {
  window.open('https://github.com/chrisbuerginrogers/ObieApp', '_blank');
};

// ── UI helpers ────────────────────────────────────────────────────────
function setSt(slot, txt, cls) {
  const el = document.getElementById(`wav-status-${slot}`);
  el.textContent = txt;
  el.className = 'sp-panel-status' + (cls ? ' ' + cls : '');
}

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
    ['waveform-plot-a', 'spec-plot-a', 'waveform-plot-b', 'spec-plot-b', 'diff-plot'].forEach(id => {
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
  specSetMode('single');   // matches the HTML's default active button/classes
});
window.addEventListener('beforeunload', () => {
  if (_recordingSlot) stopRecording();
  if (_liveActive) stopLiveView();
});
