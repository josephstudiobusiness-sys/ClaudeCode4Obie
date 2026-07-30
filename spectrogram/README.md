# Spectrogram — ObieWebApp tool

A standalone, browser-based spectrogram viewer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).

The tool shows **two samples — Sample A and Sample B** — loaded independently,
in one of two ways:

- **Load a file**:
  - `.wav` — decoded directly by the canonical `wavfileio.py`.
  - `.mp3` — scipy (which `wavfileio.py` uses) can't read MP3, so it's
    decoded client-side first via the browser's own Web Audio decoder
    (`AudioContext.decodeAudioData`, the same native decoder Chrome/Edge use
    for `<audio>` playback), then handed to Python as plain float samples —
    from there it's treated exactly like a WAV.
  - Complex/FRF files (`.trf`, `.trv`, `.avc`, `.avr`, `.csv`, `.mat`) — these
    store a frequency-domain transfer function, not audio, so the tool IFFTs
    it to a time-domain impulse response (phase-aware when the file carries
    phase, e.g. TRF `fComplex=1/2` or AvC; minimum-phase estimated otherwise)
    and shows *that* impulse response's spectrogram.

  All of these support stereo, with an L/R channel toggle and playback via
  the browser's `AudioContext`.
- **Record from the mic** — click Record on either sample to capture live
  audio; the spectrogram updates in real time (rolling 5 s window) while
  recording, and on Stop the full clip becomes that sample's static
  spectrogram, ready to compare against the other side. Only one sample can
  record at a time (one physical microphone) — the other side's Record
  button is disabled meanwhile.

Three view modes, via the toolbar:

- **🆚 Compare** (default) — Sample A and Sample B side by side.
- **🔎 Single** — just one sample, full width (a "Sample A / Sample B" toggle
  picks which). Reuses the same panels as Compare — no separate plots to
  keep in sync, it's a pure layout toggle.
- **⛰ Difference** — see below.

FFT window size, hop size, max frequency, **frequency smoothing**, colorscale,
and the frequency-axis scale are all adjustable in the sidebar and apply to
**both** samples, so the comparison is apples-to-apples.

### Frequency smoothing

The **Smoothing** dropdown (¼ semitone up to a full octave) averages each
frequency bin over a ± fractional-octave window, exactly like Explore's
smoothing control — same ratio-based algorithm (`freqs[i]/ratio` to
`freqs[i]*ratio`, `ratio = 2^(semitones/12)`), just adapted to run across an
entire spectrogram matrix (every time frame) at once via a cumulative-sum
range query per bin, rather than one freq/mag curve at a time. Applies
everywhere: Sample A, Sample B, and the Difference view (smoothed *before*
subtracting, so the diff doesn't inherit narrow-band noise from either side).

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
- **Mirror (A | B)** — *Difference view only.* Rather than subtracting A
  from B, this shows both samples' own spectrograms side by side around a
  centre line, so you compare shapes directly instead of reading a computed
  difference. A **Mirror: Frequency / Time** toolbar button (visible only in
  this mode) toggles which axis is shared:
  - **Frequency** (default) — a population-pyramid-style plot: Y=frequency
    (shared), and for each bin a filled line extends left for Sample A's
    time-averaged level, right for Sample B's (red/blue, matching the
    Difference legend). Time is collapsed to a mean.
  - **Time** — Y=time (shared), and each side is a full heatmap with
    frequency (X) increasing outward from the centre line — Sample A
    mirrored on the left, Sample B normal on the right. (Linear frequency
    axis only here — log is undefined for the negative/mirrored side.)

### Difference mode

Toggle **⛰ Difference** (top toolbar) to see Sample A's spectrogram minus
Sample B's as one plot — peaks where A is louder than B, valleys where B is
louder, using a zero-centred diverging colorscale (RdBu, reversed so
**red = A louder, blue = B louder**) so it reads as "mountains and valleys"
rather than raw dB. A colour key showing this appears next to the plot title
in Heatmap, 3D Surface, and Mirror-by-frequency (the modes where colour/fill
encodes A-vs-B) — it's hidden in Waterfall and Mirror-by-time, where colour
instead encodes time or the selected sequential colorscale. 3D Surface is
the most literal read on the "mountains and valleys." If A and B differ in
sample rate or length, B is resampled onto A's frequency/time grid first
(Heatmap/Surface/Waterfall only — Mirror doesn't need this, since it never
subtracts the two).

All signal processing is delegated to the canonical ObieApp Python modules,
loaded live from GitHub at runtime — none of it is reimplemented here (see
`pyscript.toml`):

- [`Python/fileio/wavfileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/wavfileio.py) — WAV decoding
- [`Python/fileio/trf_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/trf_fileio.py), [`avc_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/avc_fileio.py), [`tsv_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/tsv_fileio.py), [`mat_fileio.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/fileio/mat_fileio.py) — FRF file parsing
- [`Python/processing/convolution.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/convolution.py) — `_frf_to_ir` / `_minimum_phase` (FRF → impulse response), the same helpers Convolve uses internally
- [`Python/processing/spectrogram.py`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Python/processing/spectrogram.py) — the STFT itself, used for files, each live-mic update, and both sides of the Difference view

Frequency smoothing and MP3 decoding are the two exceptions to "everything
comes from ObieApp's Python modules" — for good reason in each case:
- Smoothing has no canonical Python module in ObieApp (checked before writing
  anything). Explore implements it client-side in JS
  ([`explore.js`](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Web/tools/explore/explore.js), `_smooth()`), so `main.py` reuses that same
  ratio-window algorithm rather than inventing a different one, adapted to
  run across a whole spectrogram matrix via numpy.
- MP3 decoding isn't signal processing ObieApp owns at all — it's a codec,
  and scipy (which `wavfileio.py` is built on) doesn't support it. The
  browser's own decoder is the appropriate tool here, not a Python
  reimplementation of an MP3 decoder.

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
