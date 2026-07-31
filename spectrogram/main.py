"""
main.py — Spectrogram tool entry point.

Python-side responsibilities:
  - Decode WAV bytes                    → Python/fileio/wavfileio.py (load_wav_bytes)
  - Store pre-decoded audio (e.g. MP3)  → browser's own Web Audio decoder
                                            does the format decoding in JS;
                                            this just normalises + stores it
  - Parse complex/FRF files              → Python/fileio/{trf,avc,tsv,mat}_fileio.py
  - IFFT an FRF to an impulse response   → Python/processing/convolution.py
                                            (_frf_to_ir, _minimum_phase)
  - Compute the STFT spectrogram         → Python/processing/spectrogram.py
  - Roll a live-mic ring buffer and recompute its spectrogram on each push
  - Diff two chosen files' spectrograms, resampled onto a shared grid, for
    the "Difference" view

An arbitrary number of files can be loaded (each loaded from a file or
recorded from the mic), tracked as "slots" keyed by a JS-assigned id string.
All slots share one set of FFT settings (n_fft/hop/f_max) so any comparison
is apples-to-apples. The Difference view operates on whichever two slot ids
the UI passes in — there's no fixed "Sample A"/"Sample B" on the Python side.

All of the above delegate to the canonical ObieApp implementations, loaded
from GitHub via pyscript.toml — no signal processing is reimplemented here.
"""

import json
import js
import numpy as np
from pyscript.ffi import create_proxy, to_js
from wavfileio import load_wav_bytes
from spectrogram import compute_spectrogram
from trf_fileio import parse_trf
from avc_fileio import parse_avc, parse_avr
from tsv_fileio import parse_csv
from mat_fileio import parse_mat_bytes as _parse_mat
from convolution import _frf_to_ir, _minimum_phase, _adaptive_ir_length
from config import configure, load as cfg_load, save as cfg_save

configure('obieWebApp_spectrogram', {
    "settings": {
        "n_fft": 2048,
        "hop": 512,
        "f_max": 8000,
        "semitones": 0,
    },
})

# FRF files (TRF/AVC/AVR/CSV/MAT) don't carry a sample rate for the impulse
# response we synthesise from them — TRF files written by Acquire do (via the
# OBIE_META block), which we use when present; otherwise this is our fallback.
_DEFAULT_FRF_SR = 48000

# ── Module-level state — one entry per loaded file, keyed by its JS-assigned
# id (a string, e.g. "1", "2", …) — an arbitrary number of files can be
# loaded, not just a fixed two, so entries are created on demand rather than
# pre-populated for two fixed slots.
_slots = {}   # slot -> {'sr': int, 'l': np.ndarray float64 [-1,1], 'r': np.ndarray or None}


def _to_float32(data):
    if data.dtype == np.int16:
        return data.astype(np.float32) / 32768.0
    if data.dtype == np.int32:
        return data.astype(np.float32) / 2147483648.0
    if data.dtype == np.uint8:
        return (data.astype(np.float32) - 128.0) / 128.0
    return data.astype(np.float32)


def _smooth_spectrogram(freqs, S_db, semitones):
    """Fractional-octave smoothing — averages each frequency bin over a
    ±semitones/12-octave window. Same ratio-based algorithm as Explore's
    client-side smoothing (Web/tools/explore/explore.js: _smooth), adapted
    here to run across every time frame of the spectrogram at once (a
    cumulative-sum range query per bin) rather than one freq/mag curve.
    """
    if not semitones:
        return S_db
    ratio = 2.0 ** (semitones / 12.0)
    n = len(freqs)
    csum = np.cumsum(S_db, axis=0)
    csum = np.vstack([np.zeros((1, S_db.shape[1])), csum])
    out = np.empty_like(S_db)
    for i in range(n):
        lo = int(np.searchsorted(freqs, freqs[i] / ratio, side='left'))
        hi = int(np.searchsorted(freqs, freqs[i] * ratio, side='right'))
        out[i] = (csum[hi] - csum[lo]) / max(hi - lo, 1)
    return out


def _send_spectrogram(slot, channel, sig, sr, n_fft, hop, f_max, semitones=0):
    """Compute one slot/channel's spectrogram via the canonical module and fire a JS callback."""
    try:
        times, freqs, S_db = compute_spectrogram(sig, sr, n_fft=n_fft, hop=hop, f_max=f_max)
        if S_db.size == 0:
            js.window.onSpecError(slot, 'Signal is shorter than the FFT window — pick a smaller window size')
            return
        S_db = _smooth_spectrogram(freqs, S_db, semitones)
        js.window.onSpecSpectrogramResult(
            slot, channel, to_js(times), to_js(freqs), to_js(S_db.flatten()),
            int(S_db.shape[0]), int(S_db.shape[1]),
        )
    except Exception as exc:
        js.window.onSpecError(slot, str(exc)[:160])


def _compute_slot(slot, n_fft, hop, f_max, semitones=0):
    st = _slots[slot]
    if st['l'] is None:
        return
    n_fft, hop, f_max = int(n_fft), int(hop), float(f_max)
    _send_spectrogram(slot, 'l', st['l'], st['sr'], n_fft, hop, f_max, semitones)
    if st['r'] is not None:
        _send_spectrogram(slot, 'r', st['r'], st['sr'], n_fft, hop, f_max, semitones)


def _store_sample(slot, sr, l, r, play_samples, n_channels, info, stereo):
    _slots[slot] = {'sr': sr, 'l': l, 'r': r}
    js.window.onSpecSampleResult(slot, to_js(play_samples), sr, n_channels, info, stereo)
    prefs = cfg_load('settings')
    _compute_slot(slot, prefs['n_fft'], prefs['hop'], prefs['f_max'], prefs.get('semitones', 0))


# ── WAV loading ──────────────────────────────────────────────────────────

def _load_wav(slot_js, filename_js, data_js):
    slot  = str(slot_js)
    fname = str(filename_js)
    try:
        raw = bytes(data_js.to_py())
        data, sr = load_wav_bytes(raw)
        f = _to_float32(data)
        peak = float(np.max(np.abs(f))) or 1.0
        f = f / peak

        stereo = f.ndim > 1 and f.shape[1] > 1
        if stereo:
            play_samples = np.empty(f.shape[0] * 2, dtype=np.float32)
            play_samples[0::2] = f[:, 0]
            play_samples[1::2] = f[:, 1]
            n_channels = 2
            l = f[:, 0].astype(np.float64)
            r = f[:, 1].astype(np.float64)
        else:
            mono = f if f.ndim == 1 else f.mean(axis=1)
            play_samples = mono.astype(np.float32)
            n_channels = 1
            l = mono.astype(np.float64)
            r = None

        name = fname.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        n_frames = f.shape[0]
        info = (f'{name} · {n_frames / sr:.2f}s · {sr / 1000:.1f}kHz · '
                f'{"stereo" if stereo else "mono"}')
        _store_sample(slot, int(sr), l, r, play_samples, n_channels, info, stereo)
    except Exception as exc:
        js.window.onSpecSampleError(slot, str(exc)[:160])


js.window.pySpecLoadWav = create_proxy(_load_wav)


# ── Pre-decoded audio (e.g. MP3) ────────────────────────────────────────────
# scipy.io.wavfile only reads WAV — for anything else the browser's own
# decoder (Web Audio API's decodeAudioData, called from spectrogram.js) does
# the format decoding client-side and hands us plain float samples here, at
# which point it's handled exactly like a WAV: peak-normalise, split
# channels, store.

def _load_decoded_audio(slot_js, filename_js, samples_js, sr_js, n_channels_js):
    slot  = str(slot_js)
    fname = str(filename_js)
    try:
        n_channels = int(n_channels_js)
        sr = int(sr_js)
        flat = np.array(samples_js.to_py(), dtype=np.float32)
        peak = float(np.max(np.abs(flat))) or 1.0
        flat = flat / peak

        stereo = n_channels == 2
        if stereo:
            l = flat[0::2].astype(np.float64)
            r = flat[1::2].astype(np.float64)
        else:
            l = flat.astype(np.float64)
            r = None

        name = fname.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        n_frames = len(l)
        info = (f'{name} · {n_frames / sr:.2f}s · {sr / 1000:.1f}kHz · '
                f'{"stereo" if stereo else "mono"}')
        _store_sample(slot, sr, l, r, flat, n_channels, info, stereo)
    except Exception as exc:
        js.window.onSpecSampleError(slot, str(exc)[:160])


js.window.pySpecLoadDecodedAudio = create_proxy(_load_decoded_audio)


# ── Complex / FRF file loading (TRF, TRV, AVC, AVR, CSV, MAT) ──────────────
# Parsed with the same canonical parsers Explore/Convolve use, then IFFT'd to
# an impulse response with convolution.py's own helpers — the exact same
# path Convolve takes internally before convolving, just without a WAV.

def _frf_to_complex(ext, raw):
    """Returns (freqs, H_complex128, sample_rate_hint_or_None)."""
    if ext in ('trf', 'trv'):
        p = parse_trf(raw)
        if p['n_rows'] == 0:
            raise ValueError((p.get('warnings') or ['empty TRF file'])[0])
        freqs = np.array(p['freq'], dtype=np.float64)
        if 're' in p:
            H = np.array(p['re'], dtype=np.float64) + 1j * np.array(p['im'], dtype=np.float64)
        else:
            H = (10.0 ** (np.array(p['mag'], dtype=np.float64) / 20.0)).astype(np.complex128)
        sr_hint = None
        try:
            sr_hint = int(float(p['header']['sample_rate']))
        except (KeyError, ValueError):
            pass
        return freqs, H.astype(np.complex128), sr_hint

    if ext == 'avc':
        p = parse_avc(raw)
        return (np.asarray(p['freqs'], dtype=np.float64),
                np.asarray(p['H_complex'], dtype=np.complex128), None)

    if ext == 'avr':
        p = parse_avr(raw)
        H = np.asarray(p['data'], dtype=np.float64).astype(np.complex128)
        return np.asarray(p['freqs'], dtype=np.float64), H, None

    if ext == 'csv':
        p = parse_csv(raw)
        if p['n_rows'] == 0:
            raise ValueError((p.get('warnings') or ['empty CSV file'])[0])
        freqs = np.array(p['freq'], dtype=np.float64)
        H = (10.0 ** (np.array(p['mag'], dtype=np.float64) / 20.0)).astype(np.complex128)
        return freqs, H, None

    if ext == 'mat':
        p = _parse_mat(raw)
        if p['kind'] == 'timedomain':
            raise ValueError('.mat time-domain files are audio — load them as a WAV-style file instead')
        sr_hint = int(p['sample_rate']) if p.get('sample_rate') else None
        return (np.asarray(p['freqs'], dtype=np.float64),
                np.asarray(p['frf'], dtype=np.complex128), sr_hint)

    raise ValueError(f'.{ext} is not a supported file type')


def _load_complex(slot_js, filename_js, data_js):
    slot  = str(slot_js)
    fname = str(filename_js)
    ext = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
    try:
        raw = bytes(data_js.to_py())
        freqs, H, sr_hint = _frf_to_complex(ext, raw)
        sr = sr_hint or _DEFAULT_FRF_SR

        imag_energy = float(np.max(np.abs(H.imag)))
        real_energy = float(np.max(np.abs(H.real))) + 1e-30
        if imag_energy < 1e-8 * real_energy:
            H = _minimum_phase(H)

        ir_len = _adaptive_ir_length(freqs, sr)
        ir = _frf_to_ir(freqs, H, sr, ir_len)   # float32, unit peak

        name = fname.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        sr_note = '' if sr_hint else ' (assumed rate)'
        info = (f'{name} · impulse response from FRF · {len(ir) / sr * 1000:.1f} ms · '
                f'{sr / 1000:.1f}kHz{sr_note}')
        _store_sample(slot, int(sr), ir.astype(np.float64), None, ir, 1, info, False)
    except Exception as exc:
        js.window.onSpecSampleError(slot, str(exc)[:160])


js.window.pySpecLoadComplex = create_proxy(_load_complex)


# ── Finalise a mic recording into a slot (full clip, static spectrogram) ───
# JS accumulates the complete recording client-side (from the same worklet
# chunks used for the live preview below) and hands it over here once the
# user stops — from this point on it's treated exactly like a loaded file.

def _finalize_recording(slot_js, samples_js, sr_js):
    slot = str(slot_js)
    try:
        raw = np.array(samples_js.to_py(), dtype=np.float32)
        if raw.size == 0:
            raise ValueError('recording was empty')
        peak = float(np.max(np.abs(raw))) or 1.0
        mono = (raw / peak).astype(np.float64)
        sr = int(sr_js)
        info = f'Mic recording · {len(mono) / sr:.2f}s · {sr / 1000:.1f}kHz · mono'
        _store_sample(slot, sr, mono, None, mono.astype(np.float32), 1, info, False)
    except Exception as exc:
        js.window.onSpecSampleError(slot, str(exc)[:160])


js.window.pySpecFinalizeRecording = create_proxy(_finalize_recording)


# ── Recompute on FFT-setting change (no re-parse needed) ───────────────────
# While a slot is mid-recording, its live preview is driven by _mic_push
# below (which always reads fresh settings itself) — recomputing that slot's
# *previous* sample here would flash stale data over the live preview, so we
# skip it and just persist the new settings.

def _recompute(n_fft_js, hop_js, fmax_js, semitones_js=0):
    semitones = float(semitones_js)
    cfg_save('settings', {'n_fft': int(n_fft_js), 'hop': int(hop_js),
                           'f_max': float(fmax_js), 'semitones': semitones})
    for slot in _slots:
        if _mic_slot == slot and _mic_buf is not None:
            continue
        _compute_slot(slot, n_fft_js, hop_js, fmax_js, semitones)


js.window.pySpecRecompute = create_proxy(_recompute)


# ── Live microphone — rolling buffer, recomputed on each push ──────────────
# Mirrors Acquire's ring-buffer pattern (Web/py/acquire_logic.py) but simpler:
# a single fixed-length window that's always "the last N seconds," recomputed
# with the same canonical compute_spectrogram() used everywhere else here.
# Only one slot can be recording at a time (one physical microphone).

_MIC_WINDOW_S        = 5.0
_MIC_RECOMPUTE_EVERY = 3   # throttle: recompute every Nth push, not every push

_mic_slot    = None   # a slot id string, or None when not recording
_mic_sr      = None
_mic_size    = 0
_mic_buf     = None   # np.ndarray float64, rolling window, oldest-first
_mic_filled  = 0
_mic_counter = 0


def _mic_start(slot_js, sr_js):
    global _mic_slot, _mic_sr, _mic_size, _mic_buf, _mic_filled, _mic_counter
    _mic_slot    = str(slot_js)
    _mic_sr      = int(sr_js)
    _mic_size    = max(1, int(_MIC_WINDOW_S * _mic_sr))
    _mic_buf     = np.zeros(_mic_size, dtype=np.float64)
    _mic_filled  = 0
    _mic_counter = 0


def _mic_push(samples_js):
    global _mic_buf, _mic_filled, _mic_counter
    if _mic_buf is None:
        return
    try:
        chunk = np.array(samples_js.to_py(), dtype=np.float64)
        n = len(chunk)
        if n == 0:
            return
        if n >= _mic_size:
            _mic_buf[:] = chunk[-_mic_size:]
            _mic_filled = _mic_size
        else:
            _mic_buf[:-n] = _mic_buf[n:]
            _mic_buf[-n:] = chunk
            _mic_filled = min(_mic_size, _mic_filled + n)

        _mic_counter += 1
        if _mic_counter < _MIC_RECOMPUTE_EVERY:
            return
        _mic_counter = 0

        window = _mic_buf[-_mic_filled:] if _mic_filled < _mic_size else _mic_buf
        prefs = cfg_load('settings')
        _send_spectrogram(_mic_slot, 'l', window, _mic_sr, int(prefs['n_fft']),
                           int(prefs['hop']), float(prefs['f_max']), prefs.get('semitones', 0))
    except Exception as exc:
        js.window.onSpecError(_mic_slot or 'live', str(exc)[:160])


def _mic_stop():
    global _mic_slot, _mic_buf, _mic_filled, _mic_counter
    _mic_slot    = None
    _mic_buf     = None
    _mic_filled  = 0
    _mic_counter = 0


js.window.pySpecMicStart = create_proxy(_mic_start)
js.window.pySpecMicPush  = create_proxy(_mic_push)
js.window.pySpecMicStop  = create_proxy(_mic_stop)


# ── Difference view — one chosen file's spectrogram minus another's ────────
# The user picks which two loaded files are "1" and "2" from the sidebar
# list (there's no fixed Sample A/B anymore). Both share FFT settings, but
# can differ in sample rate and/or clip length (their frequency bins and
# time frames won't line up 1:1), so #2 is resampled onto #1's (frequency,
# time) grid via linear interpolation before subtracting — same idea as a
# "regrid then diff" step, just done with np.interp rather than a heavier
# 2-D interpolator (fine for a display-only diff; edges of #2 outside #1's
# coverage hold at #2's boundary value).

def _interp_grid_to(freqs_b, times_b, S_db_b, freqs_a, times_a):
    """Resample S_db_b (n_freqs_b × n_times_b) onto the (freqs_a, times_a) grid."""
    by_freq = np.empty((len(freqs_a), S_db_b.shape[1]))
    for j in range(S_db_b.shape[1]):
        by_freq[:, j] = np.interp(freqs_a, freqs_b, S_db_b[:, j])
    by_time = np.empty((len(freqs_a), len(times_a)))
    for i in range(len(freqs_a)):
        by_time[i, :] = np.interp(times_a, times_b, by_freq[i, :])
    return by_time


def _compute_diff(slot_a_js, slot_b_js, n_fft_js, hop_js, fmax_js, semitones_js=0):
    slot_a, slot_b = str(slot_a_js), str(slot_b_js)
    a, b = _slots.get(slot_a), _slots.get(slot_b)
    if not a or not b or a['l'] is None or b['l'] is None:
        js.window.onSpecDiffError('choose two loaded files to compare (① and ②)')
        return
    n_fft, hop, f_max, semitones = int(n_fft_js), int(hop_js), float(fmax_js), float(semitones_js)
    try:
        times_a, freqs_a, S_a = compute_spectrogram(a['l'], a['sr'], n_fft=n_fft, hop=hop, f_max=f_max)
        times_b, freqs_b, S_b = compute_spectrogram(b['l'], b['sr'], n_fft=n_fft, hop=hop, f_max=f_max)
        if S_a.size == 0 or S_b.size == 0:
            js.window.onSpecDiffError('a signal is shorter than the FFT window — pick a smaller window size')
            return
        S_a = _smooth_spectrogram(freqs_a, S_a, semitones)
        S_b = _smooth_spectrogram(freqs_b, S_b, semitones)
        S_b_aligned = _interp_grid_to(freqs_b, times_b, S_b, freqs_a, times_a)
        diff = (S_a - S_b_aligned).astype(np.float32)
        js.window.onSpecDiffResult(
            to_js(times_a), to_js(freqs_a), to_js(diff.flatten()),
            int(diff.shape[0]), int(diff.shape[1]),
        )
    except Exception as exc:
        js.window.onSpecDiffError(str(exc)[:160])


js.window.pySpecComputeDiff = create_proxy(_compute_diff)

js.window.obieSpecSettings = js.JSON.parse(json.dumps(cfg_load('settings')))

js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
