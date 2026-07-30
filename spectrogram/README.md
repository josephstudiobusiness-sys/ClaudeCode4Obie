# Spectrogram — ObieWebApp tool

A standalone, browser-based spectrogram viewer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).

Three ways to get a spectrogram:

- **Load a WAV file** — view its waveform and STFT spectrogram directly.
  Stereo files can toggle between L/R channel spectrograms. Playback uses
  the browser's `AudioContext`.
- **Load a complex/FRF file** (`.trf`, `.trv`, `.avc`, `.avr`, `.csv`, `.mat`)
  — these store a frequency-domain transfer function, not audio, so the
  tool IFFTs it to a time-domain impulse response (phase-aware when the
  file carries phase, e.g. TRF `fComplex=1/2` or AvC; minimum-phase
  estimated otherwise) and shows *that* impulse response's spectrogram.
- **Live Mic** — a real-time, continuously-updating spectrogram of the
  last 5 seconds of microphone input.

FFT window size, hop size, max frequency, and colorscale are all adjustable
in the sidebar and apply to all three modes.

All signal processing is delegated to the canonical ObieApp Python modules,
loaded live from GitHub at runtime — none of it is reimplemented here (see
`pyscript.toml`):

- [`Python/fileio/wavfileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/wavfileio.py) — WAV decoding
- [`Python/fileio/trf_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/trf_fileio.py), [`avc_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/avc_fileio.py), [`tsv_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/tsv_fileio.py), [`mat_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/mat_fileio.py) — FRF file parsing
- [`Python/processing/convolution.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/convolution.py) — `_frf_to_ir` / `_minimum_phase` (FRF → impulse response), the same helpers Convolve uses internally
- [`Python/processing/spectrogram.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/spectrogram.py) — the STFT itself, used for files and for each live-mic update

The live-mic capture path (`AudioWorkletNode` → batched samples → a Python
rolling buffer) mirrors the pattern already used by
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
