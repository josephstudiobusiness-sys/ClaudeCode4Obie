# Spectrogram — ObieWebApp tool

A standalone, browser-based spectrogram viewer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).

Load a WAV file and view its waveform and STFT spectrogram, with adjustable
FFT window size, hop size, max frequency, and colorscale. Stereo files can
toggle between L/R channel spectrograms. Playback uses the browser's
`AudioContext`.

All signal processing (WAV decoding, STFT) is delegated to the canonical
ObieApp Python modules, loaded live from GitHub at runtime:

- [`Python/fileio/wavfileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/wavfileio.py)
- [`Python/processing/spectrogram.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/spectrogram.py)

No DSP is reimplemented in this tool — see `pyscript.toml`.

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
