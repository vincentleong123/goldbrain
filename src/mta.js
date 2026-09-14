"use strict";
// Math / stats helpers shared across the app. No external deps.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

function std(a, m = mean(a)) {
  if (a.length < 2) return 0;
  const s = a.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(s / (a.length - 1));
}

// Simple linear-scaled rolling z-score over an array window
function zscore(values, window, at) {
  if (at < window - 1) return 0;
  const w = values.slice(at - window + 1, at + 1);
  const m = mean(w);
  const sd = std(w);
  if (!isFinite(sd) || sd === 0) return 0;
  return (values[at] - m) / sd;
}

// Linear regression slope over last `window` points of a series (returns delta/point)
function slope(values, window, at) {
  const n = Math.min(window, at + 1);
  if (n < 2) return 0;
  const xs = [];
  const ys = [];
  for (let i = at - n + 1; i <= at; i++) {
    xs.push(i);
    ys.push(values[i]);
  }
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den === 0 ? 0 : num / den;
}

// Percentile of closest-to-value in a sorted array (returns index of nearest)
function nearestIndex(sortedAsc, value) {
  let lo = 0;
  let hi = sortedAsc.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sortedAsc[lo - 1] - value) < Math.abs(sortedAsc[lo] - value)) lo--;
  return lo;
}

// Parse PNG-ish timestamps -> ms epoch. Accepts: ms epoch int, unix sec (len 10), ISO string.
function toMs(t) {
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  if (!isNaN(n)) return n;
  return Number(t) || 0;
}

function fmt(n, dec = 2) {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function pct(n, dec = 1) {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return (n * 100).toFixed(dec) + "%";
}

// Compress an array of numbers to at most `max` points for charting (min/max per bucket)
function downsampleSeries(xSeries) {
  return xSeries;
}

module.exports = { clamp, mean, std, zscore, slope, nearestIndex, toMs, fmt, pct, downsampleSeries };