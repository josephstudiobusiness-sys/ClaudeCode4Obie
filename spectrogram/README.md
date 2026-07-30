# Spectrogram — ObieWebApp tool

A standalone, browser-based spectrogram viewer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).

The tool shows **two samples side by side — Sample A and Sample B** — so you
can compare spectrograms directly. Each sample is loaded independently, in
one of two ways:

- **Load a WAV file** — view its waveform and STFT spectrogram directly.
  Stereo files can toggle between L/R channel spectrograms. Playback uses
  the browser's `AudioContext`.
- **Load a complex/FRF file** (`.trf`, `.trv`, `.avc`, `.avr`, `.csv`, `.mat`)
  — these store a frequency-domain transfer function, not audio, so the
  tool IFFTs it to a time-domain impulse response (phase-aware when the
  file carries phase, e.g. TRF `fComplex=1/2` or AvC; minimum-phase
  estimated otherwise) and shows *that* impulse response's spectrogram.
- **Record from the mic** — click Record on either sample to capture live
  audio; the spectrogram updates in real time (rolling 5 s window) while
  recording, and on Stop the full clip becomes that sample's static
  spectrogram, ready to compare against the other side. Only one sample can
  record at a time (one physical microphone) — the other side's Record
  button is disabled meanwhile.

FFT window size, hop size, max frequency, colorscale, and the frequency-axis
scale are all adjustable in the sidebar and apply to **both** samples, so the
comparison is apples-to-apples.

### View modes

A **Plot type** selector (sidebar) switches how any spectrogram is drawn —
Sample A, Sample B, or the Difference view:

- **Heatmap** (default) — X=frequency, Y=time, colour=dB.
- **3D Surface** — X=frequency, Y=time, Z=dB as actual height, matching how
  an FRF plot puts dB on a real axis rather than encoding it as colour.
  Rotatable/zoomable.
- **Waterfall** — the classic acoustics cascade plot: one FRF-style line
  (X=frequency, Y=dB) per time slice, stacked with a vertical offset so
  later slices sit above earlier ones (decimated to ~30 slices for
  readability), colour-graded early→late.

### Difference mode

Toggle **⛰ Difference** (top toolbar) to see Sample A's spectrogram minus
Sample B's as one plot — peaks where A is louder than B, valleys where B is
louder, using a zero-centred diverging colorscale (RdBu) so it reads as
"mountains and valleys" rather than raw dB. 3D Surface is the most literal
read on this; Heatmap and Waterfall work too. If A and B differ in sample
rate or length, B is resampled onto A's frequency/time grid first.

All signal processing is delegated to the canonical ObieApp Python modules,
loaded live from GitHub at runtime — none of it is reimplemented here (see
`pyscript.toml`):

- [`Python/fileio/wavfileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/wavfileio.py) — WAV decoding
- [`Python/fileio/trf_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/trf_fileio.py), [`avc_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/avc_fileio.py), [`tsv_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/tsv_fileio.py), [`mat_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/mat_fileio.py) — FRF file parsing
- [`Python/processing/convolution.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/convolution.py) — `_frf_to_ir` / `_minimum_phase` (FRF → impulse response), the same helpers Convolve uses internally
- [`Python/processing/spectrogram.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/spectrogram.py) — the STFT itself, used for files, each live-mic update, and both sides of the Difference view

The mic capture path (`AudioWorkletNode` → batched samples → a Python rolling
buffer for the live preview, plus the full clip kept client-side for the
final static spectrogram on Stop) mirrors the capture pattern already used by
[Acquire](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Web/tools/acquire/acquire.js).

## Deploying

This folder is self-contained and can be deployed to any static HTTPS host
(GitHub Pages, Netlify, S3 + CloudFront, your own server, etc.):

1. Copy the entire `spectrogram/` folder to your host.
2. Serve it over **HTTPS** (or `localhost` for local testing) — this is
   required both by `coi-serviceworker.js` (enables cross-origin isolation /
   `SharedArrayBuffer` for PyScript) and by the File System Access APIs used
   elsewhere in ObieWebApp.
3. Open `index.html`. No build step, no server-side code.

Requires a Chromium-based browser (Chrome or Edge) — `js/browser-check.js`
warns otherwise.

## Versions (pinned — do not change without checking upstream compatibility)

- PyScript `2026.3.1`
- Plotly `2.32.0`
