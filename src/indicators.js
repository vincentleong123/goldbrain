"use strict";
// Technical indicators on OHLCV candle arrays. Zero deps, NaN = no value (warmup).

function sma(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    prev = isNaN(prev) ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder RSI
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// Wilder ATR
function atr(candles, n = 14) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length <= n) return out;
  const trs = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs[i] = candles[i].h - candles[i].l;
    } else {
      const pc = candles[i - 1].c;
      trs[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
    }
  }
  let a = 0;
  for (let i = 1; i <= n; i++) a += trs[i];
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < candles.length; i++) {
    a = (a * (n - 1) + trs[i]) / n;
    out[i] = a;
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (isFinite(ef[i]) && isFinite(es[i]) ? ef[i] - es[i] : NaN));
  const signal = ema(line.map((v) => (isFinite(v) ? v : 0)), sig);
  signal.forEach((_, i) => {
    if (!isFinite(line[i])) signal[i] = NaN;
  });
  const hist = line.map((v, i) => (isFinite(v) && isFinite(signal[i]) ? v - signal[i] : NaN));
  return { line, signal, hist };
}

function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = n - 1; i < closes.length; i++) {
    const m = mid[i];
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (closes[j] - m) * (closes[j] - m);
    const sd = Math.sqrt(s / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

function stochastic(closes, highs, lows, k = 14, d = 3) {
  const raw = new Array(closes.length).fill(NaN);
  for (let i = k - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    raw[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const smooth = emaNaNsafe(raw, d);
  const slow = emaNaNsafe(smooth, d);
  return { k: smooth, d: slow };
}

function emaNaNsafe(values, n) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (isNaN(values[i])) continue;
    prev = isNaN(prev) ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// VWAP anchored at session starts (whenever gap between bars > 8x avg spacing)
function vwap(candles) {
  const spacing = candles.length > 5 ? (candles[candles.length - 1].t - candles[0].t) / (candles.length - 1) : 0;
  const gap = Math.max(spacing * 8, 4 * 3600 * 1000);
  const out = new Array(candles.length).fill(NaN);
  let cv = 0;
  let cvv = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0 && candles[i].t - candles[i - 1].t > gap) {
      cv = 0;
      cvv = 0;
    }
    const typ = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const v = candles[i].v || 0;
    cv += typ * v;
    cvv += v;
    if (cvv > 0) out[i] = cv / cvv;
  }
  return out;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return { v: arr[i], i };
  return { v: NaN, i: -1 };
}

module.exports = { sma, ema, rsi, atr, macd, bollinger, stochastic, vwap, lastFinite };