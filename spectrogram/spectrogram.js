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
  Plotly.newPlot(`spec-plot-${slot}`,     [], _wl('Spectrogram', 'Frequency (Hz)', 'Time (s)'), _pcfg);
});
Plotly.newPlot('diff-plot', [], _wl('Difference: Sample A − Sample B', 'Frequency (Hz)', 'Time (s)'), _pcfg);

// ── File loading (WAV, or FRF files IFFT'd to an impulse response) ────
function loadFile(slot, input) {
  const file = input.files[0]; if (!file) return;
  if (_recordingSlot) stopRecording();
  document.getElementById(`wav-btn-text-${slot}`).textContent = file.name;
  setSt(slot, 'reading…');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isWav = ext === 'wav';
  const reader = new FileReader();
  reader.onerror = () => setSt(slot, 'read error', 'err');
  reader.onload  = e => {
    const fn = isWav ? window.pySpecLoadWav : window.pySpecLoadComplex;
    if (!fn) {
      setSt(slot, 'Python not ready — try again in a moment', 'err'); return;
    }
    fn(slot, file.name, new Uint8Array(e.target.result));
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
  const s = slots[slot];
  const cache = _unpackSpec(times_js, freqs_js, flatZ_js, nFreqs, nTimes);
  if (channel === 'r') s.rCache = cache; else s.lCache = cache;
  if (s.showChannel === channel) renderSpec(slot);
};

// zDb from _unpackSpec is (nFreqBins rows × nTimeFrames cols) — transpose so
// frequency runs along x (horizontal spread) and time runs along y (height).
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
  const { times, freqs, zDb } = cache;
  const zT = _transpose(zDb);   // (nTimes rows × nFreqs cols)
  const mode = document.getElementById('view-mode-sel').value;
  const colorscale = isDiff ? 'RdBu' : document.getElementById('colorscale-sel').value;

  const zLabel = isDiff ? 'ΔdB' : 'Level';
  const hoverTemplate3D = `Freq: %{x:.0f} Hz<br>Time: %{y:.3f} s<br>${zLabel}: %{z:.1f} dB<extra></extra>`;

  if (mode === 'surface') {
    const trace = { x: freqs, y: times, z: zT, type: 'surface', colorscale, showscale: true,
      colorbar: { title: isDiff ? 'ΔdB' : 'dB', titleside: 'right', thickness: 10, tickfont: { size: 9 } },
      hovertemplate: hoverTemplate3D };
    // Plotly's built-in 'RdBu' maps low→red, high→blue — the opposite of the
    // A-is-red/B-is-blue convention (see the legend in the diff toolbar), so
    // flip it: negative (B louder) → blue, positive (A louder) → red.
    if (isDiff) { const m = _maxAbs(zT); trace.cmin = -m; trace.cmax = m; trace.reversescale = true; }
    Plotly.react(divId, [trace], {
      title: { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
      font: { size: 10, family: 'inherit' },
      paper_bgcolor: '#fff',
      scene: {
        xaxis: { title: 'Frequency (Hz)', type: _logFreq ? 'log' : 'linear' },
        yaxis: { title: 'Time (s)' },
        zaxis: { title: isDiff ? 'ΔdB' : 'dB' },
      },
      margin: { l: 0, r: 0, t: 28, b: 0 },
    }, _pcfg);
  } else if (mode === 'waterfall') {
    Plotly.react(divId, _waterfallTraces(freqs, times, zT, isDiff), _wl(title, 'Frequency (Hz)',
      isDiff ? 'ΔdB (offset per time slice)' : 'dB (offset per time slice)', {
        margin: { l: 50, r: 20, t: 26, b: 34 },
        xaxis: { type: _logFreq ? 'log' : 'linear' },
        showlegend: false,
      }), _pcfg);
  } else {
    const trace = { x: freqs, y: times, z: zT, type: 'heatmap', colorscale, showscale: true,
      colorbar: { title: isDiff ? 'ΔdB' : 'dB', titleside: 'right', thickness: 10, len: 0.95, tickfont: { size: 9 } },
      zsmooth: 'fast', hovertemplate: hoverTemplate3D };
    if (isDiff) { const m = _maxAbs(zT); trace.zmin = -m; trace.zmax = m; trace.reversescale = true; }
    Plotly.react(divId, [trace], _wl(title, 'Frequency (Hz)', 'Time (s)', {
      margin: { l: 50, r: 45, t: 26, b: 34 },
      xaxis: { type: _logFreq ? 'log' : 'linear' },
    }), _pcfg);
  }
}

// The A-red/B-blue legend only applies to Heatmap/3D Surface, where colour
// encodes the sign of the difference. Waterfall colours lines by time
// instead (see _waterfallTraces), so the legend would be misleading there.
function _updateDiffLegend() {
  const legend = document.getElementById('diff-legend');
  const mode = document.getElementById('view-mode-sel').value;
  legend.style.display = mode === 'waterfall' ? 'none' : '';
}

window.specViewModeChanged = function() {
  _updateDiffLegend();
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
  if (!window.pySpecRecompute) return;
  window.pySpecRecompute(nFft, hop, fMax);
  if (_mode === 'diff') _requestDiff();
}

function specRenderAll() {
  renderSpec('a');
  renderSpec('b');
  if (_diffCache && _mode === 'diff') _renderGrid('diff-plot', _diffCache, 'Difference: Sample A − Sample B', true);
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

// ── Compare vs Difference mode ──────────────────────────────────────────
// Difference computes Sample A's spectrogram minus Sample B's (interpolated
// onto A's frequency/time grid — see main.py's _compute_diff) so intensity
// differences show as "mountains and valleys" rather than raw dB.
let _mode = 'compare';   // 'compare' | 'diff'
let _diffCache = null;

window.specSetMode = function(mode) {
  _mode = mode;
  document.getElementById('mode-compare-btn').classList.toggle('active', mode === 'compare');
  document.getElementById('mode-diff-btn').classList.toggle('active', mode === 'diff');
  document.getElementById('compare-view').style.display = mode === 'compare' ? '' : 'none';
  document.getElementById('diff-view').style.display = mode === 'diff' ? '' : 'none';
  if (mode === 'diff') {
    _updateDiffLegend();
    _requestDiff();
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
  const el = document.getElementById('diff-status');
  el.textContent = 'computing…';
  el.className = 'sp-panel-status';
  window.pySpecComputeDiff(nFft, hop, fMax);
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

// ── Live microphone recording ──────────────────────────────────────────
// Mirrors Acquire's AudioWorkletNode capture pattern (Web/tools/acquire/acquire.js):
// an inline worklet posts raw Float32 audio. Chunks are (a) batched and pushed to
// Python (pySpecMicPush) for a live rolling-window preview, using the same canonical
// compute_spectrogram() as everywhere else, and (b) kept in full so that on Stop the
// complete clip becomes that slot's sample (pySpecFinalizeRecording), just like a
// loaded file. Only one slot can record at a time — there's one physical microphone.
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

let _recordingSlot = null;
let _micStream = null, _micCtx = null, _micSource = null, _micWorklet = null;
let _micBatch = null, _micBatchFill = 0;
let _micFullChunks = [], _micFullLen = 0, _micSr = 48000;

async function startRecording(slot) {
  if (_recordingSlot) return;
  try {
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
    _micFullChunks = []; _micFullLen = 0;
    _micSr = _micCtx.sampleRate;
    _micWorklet.port.onmessage = e => {
      const chunk = e.data;
      _micFullChunks.push(chunk); _micFullLen += chunk.length;
      let off = 0;
      while (off < chunk.length) {
        const room = MIC_BATCH_SIZE - _micBatchFill;
        const take = Math.min(room, chunk.length - off);
        _micBatch.set(chunk.subarray(off, off + take), _micBatchFill);
        _micBatchFill += take; off += take;
        if (_micBatchFill >= MIC_BATCH_SIZE) {
          if (window.pySpecMicPush) window.pySpecMicPush(_micBatch.slice());
          _micBatchFill = 0;
        }
      }
    };
    _micSource.connect(_micWorklet);

    if (window.pySpecMicStart) window.pySpecMicStart(slot, _micSr);
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
  if (_micSource)  { try { _micSource.disconnect(); }  catch (_) {} _micSource  = null; }
  if (_micWorklet) { try { _micWorklet.disconnect(); } catch (_) {} _micWorklet = null; }
  if (_micStream)  { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  if (_micCtx)     { _micCtx.close().catch(() => {}); _micCtx = null; }
  if (window.pySpecMicStop) window.pySpecMicStop();

  const full = new Float32Array(_micFullLen);
  let off = 0;
  for (const c of _micFullChunks) { full.set(c, off); off += c.length; }
  _micFullChunks = []; _micFullLen = 0;

  _recordingSlot = null;
  _exitRecordingUI(slot);

  if (full.length > 0 && window.pySpecFinalizeRecording) {
    setSt(slot, 'processing recording…');
    window.pySpecFinalizeRecording(slot, full, _micSr);
  } else {
    setSt(slot, 'no audio captured', 'err');
  }
}

window.specToggleRecord = function(slot) {
  if (_recordingSlot === slot) stopRecording();
  else if (!_recordingSlot) startRecording(slot);
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
});
window.addEventListener('beforeunload', () => { if (_recordingSlot) stopRecording(); });
