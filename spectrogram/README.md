# Spectrogram — ObieWebApp tool

A standalone, browser-based spectrogram viewer built with PyScript + Plotly,
following the ObieWebApp look & feel (see
[ObieApp/CLAUDE.md](https://github.com/chrisbuerginrogers/ObieApp/blob/main/CLAUDE.md)).

Files pile up in a **numbered list in the left sidebar**, Explore-style —
load as many as you like (or record from the mic), then pick what to do
with them:

- **Load a file** (📂 Load, top of the sidebar — pick one or several at once):
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

  All of these support stereo, with an L/R channel toggle (per sidebar row)
  and playback via the browser's `AudioContext`.
- **Record from the mic** (🎤 Record, top of the sidebar) — capture live
  audio into a new numbered row; the spectrogram updates in real time
  (rolling 5 s window) while recording, and on Stop the full clip becomes
  that row's static sample. Only one recording can run at a time (one
  physical microphone).

Each sidebar row carries everything about that file: a checkbox (Compare
selection — this same checkbox also drives Single mode, see below), the
number/name, a ▶ play button, an L/R channel chip when stereo, ①/② buttons
(Difference/Mirror pairing — see below), and a ✕ to remove it.

Five view modes, via the toolbar:

- **🔎 Single** (default) — one file, full width: whichever checked file
  sits **highest in the sidebar list**. There's no separate "focus" click —
  the same checkbox Compare uses picks Single's file too, so ticking a file
  further up the list switches Single to show it, and unticking the
  top-most checked file falls back to the next one down. With files 2-5
  checked, Single shows 2; check 1 and it takes over.
- **🆚 Compare** — every file whose sidebar checkbox is ticked, stacked as
  **rows**, up to **6 at a time**. Ticking a 7th box while 6 are already
  selected is a no-op — untick one first.
- **⛰ Difference** — see below.
- **🎙 Live** — see "Live view" below.
- **🌀 Visualizer** — see "Visualizer" below.

FFT window size, hop size, max frequency, **frequency smoothing**, and
colorscale live in the **⚙️ FFT Settings** button (top right) and apply to
**every loaded file**, so any comparison is apples-to-apples. The **View**
selector next to it (labelled with the current plot type, e.g. "Heatmap")
picks how spectrograms are drawn — see "View modes" below — and **ℹ** opens
a quick how-to-use popup.

Every currently-shown panel is its own Plotly figure, so left to their
defaults they'd colour-scale independently — the hottest colour in one
panel could mean a completely different dB than the hottest colour in
another. To keep them genuinely comparable, Single/Compare's Heatmap and 3D
Surface (colour *and* height) always share one fixed intensity range — the
combined min/max across *every loaded file*, not just whichever happen to
be currently checked or shown — instead of each auto-scaling to its own
data. That range only moves when a file is actually loaded or removed, so
checking/unchecking files, or going from several panels down to one, never
shifts the scale under you. Either side of Mirror-by-time separately shares
its own combined min/max between just that pair. The Difference view's own
colour range (zero-centred on ΔdB) is unaffected — that's a separate,
already-shared computation.

### Frequency smoothing

The **Smoothing** dropdown (¼ semitone up to a full octave) averages each
frequency bin over a ± fractional-octave window, exactly like Explore's
smoothing control — same ratio-based algorithm (`freqs[i]/ratio` to
`freqs[i]*ratio`, `ratio = 2^(semitones/12)`), just adapted to run across an
entire spectrogram matrix (every time frame) at once via a cumulative-sum
range query per bin, rather than one freq/mag curve at a time. Applies
everywhere: every loaded file, and the Difference view (smoothed *before*
subtracting, so the diff doesn't inherit narrow-band noise from either side).

### View modes

The **View** selector (toolbar, top right) switches how any spectrogram is
drawn — every panel (Single/Compare) and the Difference view:

- **Heatmap** (default) — X=time, Y=frequency, colour=dB — the usual
  spectrogram layout (time scrolling left→right, frequency bottom→top).
- **3D Surface** — X=time, Y=frequency, Z=dB as actual height, matching how
  an FRF plot puts dB on a real axis rather than encoding it as colour.
  Rotatable/zoomable.
- **Waterfall** — the classic acoustics cascade plot: one FRF-style line
  (X=frequency, Y=dB) per time slice, stacked with a vertical offset so
  later slices sit above earlier ones (decimated to ~30 slices for
  readability), colour-graded early→late. Frequency stays on X here — a
  waterfall isn't a time/frequency grid, each line *is* one time slice, so
  there's no "which axis is time" to flip.
- **Mirror (① | ②)** — *Difference view only.* Rather than subtracting ①
  from ②, this shows both files' own spectrograms directly, arranged around
  a centre line/plane, so you compare shapes visually instead of (or
  alongside) reading a computed difference. Two independent toolbar toggles
  (visible only in this mode) control how:
  - **Mirror: Independent / Signed Diff** — what's actually plotted.
    **Independent** (default) shows each file's own values, unrelated to
    each other — good for comparing overall shape/timbre. **Signed Diff**
    shows a true `① − ②` subtraction instead — the same computation as the
    numeric Difference view (interpolated onto a shared grid), just routed
    through Mirror's layout.
  - **Mirror: Flat / 3D Surface** — 2D chart vs literal 3D terrain.
    **Flat** (default) draws a 2D chart, and a second toggle, **Mirror:
    Frequency / Time**, then picks which axis is shared:
    - **Frequency** — a population-pyramid-style plot: Y=frequency (shared),
      and for each bin a filled line extends left for ①, right for ②
      (red/blue, matching the Difference legend). Time is collapsed to a
      mean (Independent: each file's own average; Signed Diff: `avg(①) −
      avg(②)` per frequency bin, split left/right by sign).
    - **Time** — X=time (shared), and each side is a full heatmap with
      frequency (Y) increasing outward from the centre line — ① mirrored
      below, ② normal above. Linear frequency axis only here (log is
      undefined for the negative/mirrored side), and no Independent/Signed-
      Diff distinction (a per-(time,freq) mirrored heatmap doesn't have the
      same single-value-per-point ambiguity the frequency-axis pyramid does).

    **3D Surface** ignores the Frequency/Time axis choice — a literal
    surface doesn't need 2D's left-right/top-bottom trick to visually
    separate ① and ②, since overlap plus rotation already does that job.
    Independent renders **two semi-transparent surfaces** overlaid in one
    scene (① red, ② blue, X=time/Y=frequency/Z=dB) — the whole time-resolved
    terrain for each file, not just a time-averaged snapshot, so you can
    rotate around to see exactly where one pokes above the other. Signed
    Diff renders **one surface** — reusing the exact same full-resolution
    `① − ②` grid the numeric Difference view's own 3D Surface uses (not a
    separate computation), so switching to Mirror's 3D Signed Diff and to
    ⛰ Difference → Plot type: 3D Surface show identical data, just reached
    two different ways.

### Difference mode

Toggle **⛰ Difference** (top toolbar) to see one chosen file's spectrogram
minus another's, as one plot. Which two files: click the small **①**/**②**
buttons on any two sidebar rows — whichever files you've marked that way are
the pair, regardless of where they sit in the list or whether their Compare
checkbox is ticked. New files auto-fill ① then ② the first time they're
loaded, so a fresh two-file session works with no extra clicks, but you're
free to re-pick at any time. Peaks show where ① is louder than ②, valleys
where ② is louder, using a zero-centred diverging colorscale (RdBu, reversed
so **red = ① louder, blue = ② louder**) so it reads as "mountains and
valleys" rather than raw dB. A colour key showing this appears next to the plot title
in Heatmap, 3D Surface, and Mirror-by-frequency (the modes where colour/fill
encodes ①-vs-②) — it's hidden in Waterfall and Mirror-by-time, where colour
instead encodes time or the selected sequential colorscale. 3D Surface is
the most literal read on the "mountains and valleys." If ① and ② differ in
sample rate or length, ② is resampled onto ①'s frequency/time grid first
(Heatmap/Surface/Waterfall only — Mirror doesn't need this, since it never
subtracts the two).

### Live view

Toggle **🎙 Live** (top toolbar) for a full-width, continuously-updating
spectrogram of the microphone — useful for dialing in FFT window/hop/max-
freq/smoothing/colorscale by ear-and-eye without adding anything to the file
list. Click **Start Live** to begin; it uses the exact same rolling 5 s ring
buffer and throttled `compute_spectrogram()` recompute that Recording's live
preview already uses (just keyed by a `'live'` pseudo-slot instead of a real
file id), so setting changes (⚙️ FFT Settings) take effect within a push or
two, same as during a recording. There's only one physical microphone, so
Live and Recording are mutually exclusive — each disables the other's
controls while active — and leaving Live mode (or closing the tab) stops it
and releases the mic automatically.

### Visualizer

Toggle **🌀 Visualizer** for a circular take on the same spectrogram data.
Frequency always runs **around the circumference, starting at 12 o'clock and
sweeping clockwise** (like a dial) from 0 Hz up to the file's max frequency,
honoring the same **Freq: Lin/Log** toolbar toggle the rest of the tool uses
— switching it changes the angular spacing here too (on a log scale, 0 Hz
has no distinct position, same as any log-frequency axis, so it clamps to
the first real bin). It shows whichever file Single would show (the topmost
sidebar-checked one) — there's no separate picker, so ticking a different
file's checkbox updates both at once. A second toolbar button,
**Visualizer: Disc / Visualizer: Line**, switches between two styles:

- **Disc** — the full time-resolved spectrogram wrapped into a ring: time is
  the radius (centre = start, edge = end) and colour is dB, same as Heatmap.
  A dotted spoke plus **"0 Hz"**/**"‹max› Hz"** labels mark the seam at the
  top where the sweep starts and wraps back around, and full centre-to-edge
  reference gridlines (not just rim ticks) at 200, 400, 600, 1k, 2k, 3k, 5k,
  7k Hz (whichever fall under the file's max frequency) let you trace a
  frequency across the whole disc. Plotly's 3D `surface` hover highlights an
  entire row/column of the grid rather than a single point — an inherent
  limitation of that trace type, not something fixable from the data side —
  so treat the gridlines, not hover, as the precise way to read a frequency
  off the Disc; the popup that does appear still reports frequency and dB.
- **Line** — a single radial line: one point per frequency bin, radius is
  that bin's dB averaged across the whole file, then run through a short
  band-average (each point blended with its near neighbours) to smooth out
  bin-to-bin noise so the overall shape reads clearly. This is a native 2D
  polar chart (not the 3D surface trick Disc needs), so hover is precise,
  point-by-point, with no row/column highlighting.

Disc reuses the 3D `surface` machinery the tool already relies on
elsewhere: `(x, y)` computed per grid point as `(r·cosθ, r·sinθ)` instead of
the usual straight-line time/frequency coordinates, colour driven by
`surfacecolor` instead of height, with flat lighting so it reads as pure
colour rather than a shaded 3D object, and a tightened axis range (hugging
the disc's actual extent rather than a fixed oversized box) so it fills
more of the panel. The **View** selector (Heatmap/3D Surface/Waterfall/
Mirror) doesn't apply here — Visualizer is its own fixed layout, not one
more Plot type option.

Both styles' dB scale — Disc's colour range and Line's radial-axis range —
is fixed across every loaded file rather than auto-scaled to whichever one
is currently shown. Without that, the same colour or the same ring could
mean a different dB depending only on which file's checkbox happened to be
ticked, which would defeat a fast side-by-side comparison; checking a
different file re-shows the plot at the exact same scale, so a genuine
level difference actually looks different instead of both files getting
independently stretched to fill the same visual range. The scale only
moves when a file is actually loaded or removed, never from switching or
checking/unchecking which one is displayed. Compare mode's Heatmap/3D
Surface panels share this same fixed, whole-library dB range for the same
reason — every panel (and a lone panel left after unchecking others) reads
off one constant scale rather than each auto-normalizing to its own data.

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
buffer, recomputed on each push) mirrors the capture pattern already used by
[Acquire](https://github.com/chrisbuerginrogers/ObieApp/blob/main/Web/tools/acquire/acquire.js).
Per-slot Recording and the standalone Live view share this one low-level
engine (only one consumer can hold the mic at a time) but differ in what
they do with it: Recording also keeps the full clip client-side so Stop can
finalise it into that slot's static sample, while Live view is read-only —
nothing is kept beyond the rolling window, so it can run indefinitely.

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
