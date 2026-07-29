/* ─────────────────────────────────────────────────────────────────────
 * plotly-theme.js  —  shared Plotly theme for ObieWebApp2
 *
 * Provides: cssVar(), plotLayout(), pcfg, COL
 *
 * Loaded before any per-tool JS.  No global state beyond these four
 * exports — all plots read CSS variables at render time so they stay
 * consistent with theme.css without hardcoding hex values.
 * ───────────────────────────────────────────────────────────────────── */

/** Read a CSS custom property from :root at call time. */
function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
}

/**
 * Build a Plotly layout object.
 *
 * @param {string} title   – plot title
 * @param {string} xl      – x-axis label
 * @param {string} yl      – y-axis label
 * @param {object} extra   – optional overrides: { xaxis:{}, yaxis:{}, ...rest }
 */
function plotLayout(title, xl, yl, extra = {}) {
  const { xaxis: xa = {}, yaxis: ya = {}, ...rest } = extra;
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor:  'transparent',
    font:   { size: 10, family: 'inherit' },
    title:  { text: title, font: { size: 11 }, pad: { t: 2, b: 0 } },
    xaxis:  {
      title: xl,
      gridcolor:    cssVar('--border'),
      zerolinecolor: cssVar('--border'),
      tickfont: { size: 9 },
      ...xa,
    },
    yaxis:  {
      title: yl,
      gridcolor:    cssVar('--border'),
      zerolinecolor: cssVar('--border'),
      tickfont: { size: 9 },
      ...ya,
    },
    margin:     { l: 50, r: 12, t: 28, b: 38 },
    autosize:   true,
    showlegend: true,
    legend:     { font: { size: 9 }, x: 1, xanchor: 'right', y: 1 },
    ...rest,
  };
}

/** Plotly config shared by all charts in this app. */
const pcfg = { responsive: true, displayModeBar: false };

/** Standard trace colours — keep in sync with project instructions. */
const COL = {
  frf:  '#7c4dbe',   // purple  — FRF / filter
  wav:  '#2e7d32',   // green   — input / WAV
  out:  '#e65100',   // deep orange — convolved output
  spec: '#1565c0',   // blue    — spectrum overlay
};
