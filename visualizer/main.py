"""
main.py — Visualizer tool entry point.

Python-side responsibilities:
  - Decode WAV bytes                    → Python/fileio/wavfileio.py (load_wav_bytes)
  - Store pre-decoded audio (e.g. MP3)  → browser's own Web Audio decoder
                                            does the format decoding in JS;
                                            this just normalises + stores it
  - Parse complex/FRF files              → Python/fileio/{trf,avc,tsv,mat}_fileio.py
  - IFFT an FRF to an impulse response   → Python/processing/convolution.py
                                            (_frf_to_ir, _minimum_phase)
  - Compute the STFT spectrogram         → Python/processing/spectrogram.py

An arbitrary number of files can be loaded, tracked as "slots" keyed by a
JS-assigned id string. All slots share one set of FFT settings (n_fft/hop/
f_max/semitones) so switching the active file never changes what the numbers
mean. The three view modes (Planar/Radial/3D Surface) are pure JS/Plotly
presentation of the same (times, freqs, S_db) grid this file sends over —
no separate Python path per view.

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

configure('obieWebApp_visualizer', {
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
# loaded, not just a fixed one, so entries are created on demand.
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
            js.window.onVzError(slot, 'Signal is shorter than the FFT window — pick a smaller window size')
            return
        S_db = _smooth_spectrogram(freqs, S_db, semitones)
        js.window.onVzSpectrogramResult(
            slot, channel, to_js(times), to_js(freqs), to_js(S_db.flatten()),
            int(S_db.shape[0]), int(S_db.shape[1]),
        )
    except Exception as exc:
        js.window.onVzError(slot, str(exc)[:160])


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
    js.window.onVzSampleResult(slot, to_js(play_samples), sr, n_channels, info, stereo)
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
        js.window.onVzSampleError(slot, str(exc)[:160])


js.window.pyVzLoadWav = create_proxy(_load_wav)


# ── Pre-decoded audio (e.g. MP3) ────────────────────────────────────────────
# scipy.io.wavfile only reads WAV — for anything else the browser's own
# decoder (Web Audio API's decodeAudioData, called from visualizer.js) does
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
        js.window.onVzSampleError(slot, str(exc)[:160])


js.window.pyVzLoadDecodedAudio = create_proxy(_load_decoded_audio)


# ── Complex / FRF file loading (TRF, TRV, AVC, AVR, CSV, MAT) ──────────────
# Parsed with the same canonical parsers Explore/Convolve/Spectrogram use,
# then IFFT'd to an impulse response with convolution.py's own helpers — the
# exact same path Convolve takes internally before convolving, just without
# a WAV.

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
        js.window.onVzSampleError(slot, str(exc)[:160])


js.window.pyVzLoadComplex = create_proxy(_load_complex)


# ── Recompute on FFT-setting change (no re-parse needed) ───────────────────

def _recompute(n_fft_js, hop_js, fmax_js, semitones_js=0):
    semitones = float(semitones_js)
    cfg_save('settings', {'n_fft': int(n_fft_js), 'hop': int(hop_js),
                           'f_max': float(fmax_js), 'semitones': semitones})
    for slot in _slots:
        _compute_slot(slot, n_fft_js, hop_js, fmax_js, semitones)


js.window.pyVzRecompute = create_proxy(_recompute)

js.window.obieVzSettings = js.JSON.parse(json.dumps(cfg_load('settings')))

js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
