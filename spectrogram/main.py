"""
main.py — Spectrogram tool entry point.

Python-side responsibilities:
  - Decode WAV bytes                 → Python/fileio/wavfileio.py (load_wav_bytes)
  - Compute the STFT spectrogram     → Python/processing/spectrogram.py (compute_spectrogram)

Both modules are the canonical ObieApp implementations, loaded from GitHub via
pyscript.toml — no signal processing is reimplemented here.
"""

import json
import js
import numpy as np
from pyscript.ffi import create_proxy, to_js
from wavfileio import load_wav_bytes
from spectrogram import compute_spectrogram
from config import configure, load as cfg_load, save as cfg_save

configure('obieWebApp_spectrogram', {
    "settings": {
        "n_fft": 2048,
        "hop": 512,
        "f_max": 8000,
    },
})

# ── Module-level state — the last-loaded file's normalised channel data ────
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


# ── Recompute on FFT-setting change (no re-parse needed) ───────────────────

def _recompute(n_fft_js, hop_js, fmax_js):
    _compute_all(n_fft_js, hop_js, fmax_js)
    cfg_save('settings', {'n_fft': int(n_fft_js), 'hop': int(hop_js), 'f_max': float(fmax_js)})


js.window.pySpecRecompute = create_proxy(_recompute)

js.window.obieSpecSettings = js.JSON.parse(json.dumps(cfg_load('settings')))

js.document.getElementById('loading').classList.add('gone')
js.window.onPythonReady()
