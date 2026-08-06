# Visualizer — ObieWebApp tool

A standalone, browser-based acoustics visualizer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).
It is **not** the Spectrogram tool and doesn't share a codebase with it — it's a
separate self-contained tool that starts from the same file types and layout
conventions, focused entirely on three ways to look at one file's
time/frequency data.

Files pile up in a **numbered list in the left sidebar**, Explore/Spectrogram
-style — load as many as you like, then tick a checkbox to make one of them
active:

- **Load a file** (📂 Load, top of the sidebar — pick one or several at once):
  - `.wav` — decoded directly by the canonical `wavfileio.py`.
  - `.mp3` — scipy (which `wavfileio.py` uses) can't read MP3, so it's
    decoded client-side first via the browser's own Web Audio decoder
    (`AudioContext.decodeAudioData`), then handed to Python as plain float
    samples — from there it's treated exactly like a WAV.
  - Complex/FRF files (`.trf`, `.trv`, `.avc`, `.avr`, `.csv`, `.mat`) — these
    store a frequency-domain transfer function, not audio, so the tool IFFTs
    it to a time-domain impulse response (phase-aware when the file carries
    phase; minimum-phase estimated otherwise) and visualizes *that* impulse
    response.

  All of these support stereo, with an L/R channel toggle (per sidebar row)
  and playback via the browser's `AudioContext`.

Each sidebar row carries a checkbox (which file is active — the topmost
checked file wins, same convention as Spectrogram's Single mode), the
number/name, a ▶ play button, an L/R channel chip when stereo, and a ✕ to
remove it.

## Three views, one colour scale

The toolbar's three buttons switch how the active file's time/frequency data
is drawn — the underlying grid (from `Python/processing/spectrogram.py`)
never changes, only its presentation:

- **▦ Planar** (default) — the classic flat spectrogram: X=time, Y=frequency,
  colour=level.
- **🌀 Radial** — the same grid wrapped into a circle: frequency runs around
  the circumference (0 Hz at 12 o'clock, sweeping clockwise) and time is the
  radius (centre = start, edge = end), colour=level. Plotly has no native
  polar heatmap, so this reuses the 3D `surface` trace with manually-computed
  `(x, y) = (r·cosθ, r·sinθ)` coordinates and colour driven by
  `surfacecolor` instead of height, with flat lighting so it reads as pure
  colour rather than a shaded 3D object. A dotted spoke plus "0 Hz"/"‹max›
  Hz" labels mark the seam where the sweep wraps around, and full
  centre-to-edge reference gridlines at 200 Hz–7 kHz (whichever fall under
  the file's max frequency) let you trace a frequency across the disc.
- **⛰ 3D Surface** — X=time, Y=frequency, Z=level as real, rotatable height,
  instead of colour alone.

The **colour-scale picker** (top right — "difference in colour": Plasma,
Viridis, Inferno, Jet, Greyscale, RdBu, Turbo, Hot) applies to all three
views at once, so switching views never changes what a given colour means.
**Freq: Lin/Log** toggles the frequency axis (and the Radial view's angular
spacing) between linear and logarithmic.

FFT window size, hop size, max frequency, and fractional-octave smoothing
live in the **⚙️ FFT Settings** button and apply to whichever file is active.

## Deploying

This folder is self-contained and can be deployed to any static HTTPS host
(GitHub Pages, Netlify, S3 + CloudFront, your own server, etc.):

1. Copy the entire `visualizer/` folder to your host.
2. Serve it over **HTTPS** (or `localhost` for local testing) — required by
   `coi-serviceworker.js` (cross-origin isolation / `SharedArrayBuffer` for
   PyScript).
3. Open `index.html`. No build step, no server-side code.

Requires a Chromium-based browser (Chrome or Edge) — `js/browser-check.js`
warns otherwise.

All signal processing is delegated to the canonical ObieApp Python modules,
loaded live from GitHub at runtime — none of it is reimplemented here (see
`pyscript.toml`):

- [`Python/fileio/wavfileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/wavfileio.py) — WAV decoding
- [`Python/fileio/trf_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/trf_fileio.py), [`avc_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/avc_fileio.py), [`tsv_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/tsv_fileio.py), [`mat_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/mat_fileio.py) — FRF file parsing
- [`Python/processing/convolution.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/convolution.py) — `_frf_to_ir` / `_minimum_phase` (FRF → impulse response)
- [`Python/processing/spectrogram.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/spectrogram.py) — the STFT itself

Frequency smoothing has no canonical Python module in ObieApp — `main.py`
reuses Explore's client-side ratio-window algorithm, adapted to run across a
whole spectrogram matrix via numpy (same approach Spectrogram takes). MP3
decoding is the browser's own decoder, not a Python reimplementation of a
codec ObieApp doesn't own.

## Versions (pinned — do not change without checking upstream compatibility)

- PyScript `2026.3.1`
- Plotly `2.32.0`
