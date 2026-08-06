"""
dom.py — shared DOM helpers for ObieWebApp2.
All formatting done in Python — no JS round-trips for simple things.
"""

import js


def format_size(n):
    """Human-readable byte count."""
    n = int(n)
    if n < 1024:           return f'{n} B'
    if n < 1024 * 1024:    return f'{n / 1024:.1f} KB'
    return f'{n / 1024 / 1024:.2f} MB'


def esc(s):
    return (str(s)
            .replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def set_status(msg, kind='info'):
    el = js.document.getElementById('status-msg')
    if el:
        el.textContent = msg
        el.className   = kind


def render_header(header):
    box = js.document.getElementById('hdr-box')
    if not box:
        return
    if not header:
        box.innerHTML = '<span class="muted">no metadata</span>'
        return
    rows = ''.join(
        f'<tr><td class="k">{esc(k)}</td><td class="v">{esc(v)}</td></tr>'
        for k, v in header.items()
    )
    box.innerHTML = f'<table class="hdr-table">{rows}</table>'


def render_fileinfo(filename, size_bytes):
    el = js.document.getElementById('file-info')
    if el:
        el.innerHTML = (
            f'<div class="name">{esc(filename)}</div>'
            f'<div class="meta">{format_size(size_bytes)}</div>'
        )
