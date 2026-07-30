"""
main.py — Spectrogram tool entry point.

Python-side responsibilities:
  - Decode WAV bytes                    → Python/fileio/wavfileio.py (load_wav_bytes)
  - Parse complex/FRF files              → Python/fileio/{trf,avc,tsv,mat}_fileio.py
  - IFFT an FRF to an impulse response   → Python/processing/convolution.py
                                            (_frf_to_ir, _minimum_phase)
  - Compute the STFT spectrogram         → Python/processing/spectrogram.py
  - Roll a live-mic ring buffer and recompute its spectrogram on each push

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
    },
})

# FRF files (TRF/AVC/AVR/CSV/MAT) don't carry a sample rate for the impulse
# response we synthesise from them — TRF files written by Acquire do (via the
# OBIE_META block), which we use when present; otherwise this is our fallback.
_DEFAULT_FRF_SR = 48000

# ── Module-level state — the last-loaded signal's normalised channel data ──
_sr     = None   # int sample rate
_l_norm = None   # np.ndarray float64, [-1, 1], left/mono channel
_r_norm = None   # np.ndarray float64, [-1, 1], right channel — None if mono


def _to_float32(data):
    if data.dtype == np.int16:
        return data.astype(np.float32) / 32768.0
    if data.dtype == np.int32:
        return data.astype(np.float32) / 2147483648.0
    if data.dtype == np.uint8:
        return (data.astype(np.float32) - 128.0) / 128.0
    return data.astype(np.float32)


def _send_spectrogram(sig, sr, n_fft, hop, f_max, cb):
    """Compute one channel's spectrogram via the canonical module and fire a JS callback."""
    try:
        times, freqs, S_db = compute_spectrogram(sig, sr, n_fft=n_fft, hop=hop, f_max=f_max)
        if S_db.size == 0:
            js.window.onSpecError('Signal is shorter than the FFT window — pick a smaller window size')
            return
        getattr(js.window, cb)(
            to_js(times), to_js(freqs), to_js(S_db.flatten()),
            int(S_db.shape[0]), int(S_db.shape[1]),
        )
    except Exception as exc:
        js.window.onSpecError(str(exc)[:160])


def _compute_all(n_fft, hop, f_max):
    if _l_norm is None:
        return
    n_fft, hop, f_max = int(n_fft), int(hop), float(f_max)
    _send_spectrogram(_l_norm, _sr, n_fft, hop, f_max, 'onSpecLSpectrogramResult')
    if _r_norm is not None:
        _send_spectrogram(_r_norm, _sr, n_fft, hop, f_max, 'onSpecRSpectrogramResult')


# ── WAV loading ──────────────────────────────────────────────────────────

def _load_wav(filename_js, data_js):
    global _sr, _l_norm, _r_norm
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
            _l_norm = f[:, 0].astype(np.float64)
            _r_norm = f[:, 1].astype(np.float64)
        else:
            mono = f if f.ndim == 1 else f.mean(axis=1)
            play_samples = mono.astype(np.float32)
            n_channels = 1
            _l_norm = mono.astype(np.float64)
            _r_norm = None
        _sr = int(sr)

        name = fname.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        n_frames = f.shape[0]
        info = (f'{name} · {n_frames / sr:.2f}s · {sr / 1000:.1f}kHz · '
                f'{"stereo" if stereo else "mono"}')
        js.window.onSpecWavResult(to_js(play_samples), _sr, n_channels, info, stereo)

        prefs = cfg_load('settings')
        _compute_all(prefs['n_fft'], prefs['hop'], prefs['f_max'])
    except Exception as exc:
        js.window.onSpecWavError(str(exc)[:160])


js.window.pySpecLoadWav = create_proxy(_load_wav)


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


def _load_complex(filename_js, data_js):
    global _sr, _l_norm, _r_norm
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

        _sr = int(sr)
        _l_norm = ir.astype(np.float64)
        _r_norm = None

        name = fname.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        sr_note = '' if sr_hint else ' (assumed rate)'
        info = (f'{name} · impulse response from FRF · {len(ir) / sr * 1000:.1f} ms · '
                f'{sr / 1000:.1f}kHz{sr_note}')
        js.window.onSpecWavResult(to_js(ir), _sr, 1, info, False)

        prefs = cfg_load('settings')
        _compute_all(prefs['n_fft'], prefs['hop'], prefs['f_max'])
    except Exception as exc:
        js.window.onSpecWavError(str(exc)[:160])


js.window.pySpecLoadComplex = create_proxy(_load_complex)


# ── Recompute on FFT-setting change (no re-parse needed) ───────────────────
# While the mic is live, _l_norm/_r_norm still hold whatever file was loaded
# before it started — recomputing against them here would flash the *old
# file's* spectrogram over the live one. The mic loop (_mic_push) always
# reads fresh settings via cfg_load() on its own, so while live we only
# need to persist the new values, not recompute a file that isn't showing.

def _recompute(n_fft_js, hop_js, fmax_js):
    cfg_save('settings', {'n_fft': int(n_fft_js), 'hop': int(hop_js), 'f_max': float(fmax_js)})
    if _mic_buf is None:
        _compute_all(n_fft_js, hop_js, fmax_js)


js.window.pySpecRecompute = create_proxy(_recompute)


# ── Live microphone — rolling buffer, recomputed on each push ──────────────
# Mirrors Acquire's ring-buffer pattern (Web/py/acquire_logic.py) but simpler:
# a single fixed-length window that's always "the last N seconds," recomputed
# with the same canonical compute_spectrogram() used everywhere else here.

_MIC_WINDOW_S       = 5.0
_MIC_RECOMPUTE_EVERY = 3   # throttle: recompute every Nth push, not every push

_mic_sr      = None
_mic_size    = 0
_mic_buf     = None   # np.ndarray float64, rolling window, oldest-first
_mic_filled  = 0
_mic_counter = 0


def _mic_start(sr_js):
    global _mic_sr, _mic_size, _mic_buf, _mic_filled, _mic_counter
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
        _send_spectrogram(window, _mic_sr, int(prefs['n_fft']), int(prefs['hop']),
                           float(prefs['f_max']), 'onSpecLSpectrogramResult')
    except Exception as exc:
        js.window.onSpecError(str(exc)[:160])


def _mic_stop():
    global _mic_buf, _mic_filled, _mic_counter
    _mic_buf     = None
    _mic_filled  = 0
    _mic_counter = 0


js.window.pySpecMicStart = create_proxy(_mic_start)
js.window.pySpecMicPush  = create_proxy(_mic_push)
js.window.pySpecMicStop  = create_proxy(_mic_stop)

js.window.obieSpecSettings = js.JSON.parse(json.dumps(cfg_load('settings')))

js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
