"""
config.py — browser-side equivalent of fileio/obieapp_config.py.

Uses localStorage instead of the filesystem; same load() / save() API.
Call configure(key, defaults) once in main.py before load() / save().
"""

import json
import js

_key      = 'obieWebApp'
_defaults = {}


def configure(key, defaults):
    global _key, _defaults
    _key      = key
    _defaults = defaults


def load(section=None):
    try:
        raw = js.window.localStorage.getItem(_key)
        if raw:
            saved = json.loads(raw)
            cfg = {k: {**_defaults[k], **saved.get(k, {})} for k in _defaults}
        else:
            cfg = {k: dict(v) for k, v in _defaults.items()}
    except Exception:
        cfg = {k: dict(v) for k, v in _defaults.items()}
    return cfg[section] if section else cfg


def save(section=None, data=None):
    cfg = load()
    if section:
        cfg[section] = data
    else:
        cfg = data
    try:
        js.window.localStorage.setItem(_key, json.dumps(cfg))
    except Exception:
        pass


__all__ = ['configure', 'load', 'save']
