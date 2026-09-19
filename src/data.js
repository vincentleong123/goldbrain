"use strict";
// Data provider with auto-detection order: MT5 bridge files -> Yahoo live feed
// -> uploaded CSV -> synthetic demo feed. Source used is always reported.
const fs = require("fs");
const path = require("path");
const { toMs } = require("./mta");

const DATA_FOLDER = path.join(__dirname, "..", "data", "mt5");

const TF_MS = { M1: 60e3, M2: 120e3, M5: 5 * 60e3, M15: 15 * 60e3, M30: 30 * 60e3, H1: 3600e3, H4: 4 * 3600e3, D1: 86400e3 };

const YAHOO_INTERVAL = { M1: "1m", M5: "5m", M15: "15m", H1: "60m", H4: "60m", D1: "1d" };

// Timeframes Yahoo can't serve directly are resampled from a lower source TF.
const TF_SRC = { M2: "M1", M30: "M15" };

function resample(candles, outMs) {
  const out = [];
  let cur = null;
  const V = (x) => Math.round(x || 0);
  for (const b of candles) {
    const bucket = Math.floor(b.t / outMs) * outMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: V(b.v) };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += V(b.v);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const uploads = new Map(); // "SYM|TF" -> candles

// ---------------------------------------------------------------- MT5 bridge
function listMt5Files() {
  try {
    return fs.readdirSync(DATA_FOLDER).filter((f) => /\.(json|csv)$/i.test(f));
  } catch {
    return [];
  }
}

function mountMt5File(f, symbol, tf) {
  // match token name like XAUUSD_M1, xauusd_h1, XAUUSDm.D1 ...
  const base = f.replace(/\.(json|csv)$/i, "");
  const m = base.match(/^(.*?)[._\-]?([MH]\d+|H4|D1)$/i);
  const upper = base.toUpperCase();
  const wantSym = symbol.toUpperCase().replace(/m$/i, "");
  const matchSym =
    upper.includes(wantSym) || upper.includes(symbol.toUpperCase()) || (symbol.toUpperCase() === "XAUUSD" && upper.includes("XAUUSD"));
  const wantTf = tf.toUpperCase();
  let tfMatch = false;
  if (m) tfMatch = m[2].toUpperCase() === wantTf;
  else tfMatch = upper.includes(wantTf);
  if (!matchSym || !tfMatch) return null;
  try {
    if (/\.json$/i.test(f)) {
      const obj = JSON.parse(fs.readFileSync(path.join(DATA_FOLDER, f), "utf8"));
      const hist = obj.history || obj.candles || obj.bars || [];
      if (!hist.length) return null;
      return { history: hist };
    }
    const text = fs.readFileSync(path.join(DATA_FOLDER, f), "utf8");
    const candles = parseMT4CSV(text, symbol, tf);
    if (candles.length) return { history: candles };
  } catch {
    return null;
  }
  return null;
}

function getMt5(symbol, tf) {
  const files = listMt5Files();
  if (!files.length) return null;
  const exact = files.find((f) => {
    const m = f.replace(/\.(json|csv)$/i, "").match(/^(.*?)[._\-]?([MH]\d+|H4|D1)$/i);
    if (!m) return false;
    return m[2].toUpperCase() === tf.toUpperCase();
  });
  const candidates = exact ? [exact, ...files.filter((f) => f !== exact)] : files;
  for (const f of candidates) {
    const got = mountMt5File(f, symbol, tf);
    if (got) return got;
  }
  return null;
}

// ---------------------------------------------------------------- Yahoo live
let yahooQuoteHits = new Map(); // sym -> working yahoo symbol

function yahooRangesSorted() {
  return [
    ["1d", 1440], ["5d", 7200], ["1mo", 43200], ["3mo", 129600], ["6mo", 259200],
    ["1y", 525600], ["2y", 1051200], ["5y", 2628000], ["10y", 5256000], ["max", 1e12],
  ];
}

function pickRange(needMin) {
  const rows = yahooRangesSorted();
  for (const [r, min] of rows) if (needMin <= min) return r;
  return "max";
}

async function yahooFetch(symbols, interval, range) {
  for (const sym of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const json = await res.json();
      const r = json && json.chart && json.chart.result && json.chart.result[0];
      if (!r || !r.timestamp) continue;
      const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
      if (!q) continue;
      const candles = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
        if ([o, h, l, c].some((v) => v === null || v === undefined || !isFinite(v))) continue;
        if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
        candles.push({ t: Number(r.timestamp[i]) * 1000, o, h, l, c, v: Math.round(q.volume ? q.volume[i] || 0 : 0) });
      }
      if (candles.length >= 2) return { symbol: sym, candles };
    } catch {
      /* try next symbol */
    }
  }
  return null;
}

async function getYahoo(symbol, tf, bars) {
  const ms = TF_MS[tf] || 60000;
  const srcTf = TF_SRC[tf] || tf;
  const interval = srcTf === "M1" ? "1m" : YAHOO_INTERVAL[srcTf];
  if (!interval) return null;
  // M1 is only reliable on range=5d on Yahoo; 1d returns a broken payload.
  let range;
  if (srcTf === "M1") range = "5d";
  else range = pickRange(Math.ceil((bars * ms) / 60000) + 120);
  // reuse the symbol that last worked for this timeframe
  const known = yahooQuoteHits.get(tf);
  const base = ["XAUUSD=X", "GC=F"];
  const candSyms = known ? [known, ...base.filter((s) => s !== known)] : base;
  let got = await yahooFetch(candSyms, interval, range);
  if (!got) {
    const bigger = pickRange(1e12);
    const got2 = await yahooFetch(candSyms, interval, bigger);
    if (!got2) return null;
    got = got2;
  }
  if (srcTf !== tf) {
    const orig = got;
    got = { symbol: orig.symbol, candles: resample(orig.candles, ms) };
  }
  return build(got, bars, tf);
}
function build(got, bars, tf) {
  yahooQuoteHits.set(tf, got.symbol);
  const candles = got.candles.slice(-bars);
  const isFutures = got.symbol !== "XAUUSD=X";
  const srcTf = TF_SRC[tf];
  return {
    candles,
    source: isFutures ? "yahoo-futures" : "yahoo",
    note: srcTf
      ? (isFutures ? "Using COMEX gold futures (GC=F) resampled " : "Live spot gold feed (XAUUSD=X) resampled ") + srcTf + " -> " + tf + "."
      : isFutures ? "Using COMEX gold futures (GC=F) - tracks spot XAUUSD closely." : "Live spot gold feed (XAUUSD=X).",
  };
}

// ---------------------------------------------------------------- CSV upload
function parseMT4CSV(text, symbol, tf) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const hasDate = header.includes("date");
  const hasTime = header.includes("time");
  const getCol = (h, aliases) => header.indexOf(aliases.find((a) => h.includes(a)));
  const gi = (aliases) => header.findIndex((h) => aliases.some((a) => h.includes(a)));
  const idxOpen = gi(["open"]), idxHigh = gi(["high"]), idxLow = gi(["low"]),
    idxClose = gi(["close"]), idxVol = gi(["volume"]);
  const iiDate = gi(["date"]), iiTime = gi(["time"]);
  if (idxOpen < 0 || idxHigh < 0 || idxLow < 0 || idxClose < 0) return [];
  const candles = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(sep).map((s) => s.replace(/^"|"$/g, "").trim());
    if (cells.length < 5) continue;
    const o = parseFloat(cells[idxOpen]), h = parseFloat(cells[idxHigh]),
      l = parseFloat(cells[idxLow]), c = parseFloat(cells[idxClose]);
    if (![o, h, l, c].every(isFinite) || h < l || o <= 0) continue;
    let t = 0;
    if (iiDate >= 0) {
      const dateStr = cells[iiDate];
      const timeStr = iiTime >= 0 && cells[iiTime] ? " " + cells[iiTime] : "";
      const dt = new Date(dateStr.replace(/\./g, "-") + timeStr);
      if (isNaN(dt.getTime())) {
        // maybe in excel-serial or unixtime
        const num = parseFloat(cells[iiDate]);
        t = num > 10000000000 ? num : isFinite(num) ? num : 0;
      } else t = dt.getTime();
    } else if (iiTime >= 0) {
      t = toMs(cells[iiTime]);
    }
    if (!t) continue;
    candles.push({ t, o, h, l, c, v: idxVol >= 0 && cells[idxVol] ? Math.round(parseFloat(cells[idxVol])) || 0 : 0 });
  }
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

function putUpload(symbol, tf, text) {
  const candles = parseMT4CSV(text, symbol, tf);
  if (candles.length < 20) return { ok: false, reason: "Could not parse CSV (need Date,Open,High,Low,Close columns)." };
  uploads.set(`${symbol.toUpperCase()}|${tf.toUpperCase()}`, candles);
  return { ok: true, bars: candles.length, from: new Date(candles[0].t).toISOString(), to: new Date(candles[candles.length - 1].t).toISOString() };
}

function getUpload(symbol, tf) {
  const key = `${symbol.toUpperCase()}|${tf.toUpperCase()}`;
  return uploads.get(key) || null;
}

// ---------------------------------------------------------------- Synthetic
function getSynthetic(bars) {
  const candles = [];
  let price = 4400;
  const start = Date.now() - (bars - 1) * 60000;
  let drift = 0.00002;
  let vol = 0.0006;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < bars; i++) {
    drift = drift * 0.995 + (rnd() - 0.5) * 0.00004;
    vol = vol * 0.99 + (rnd() - 0.5) * 0.0001;
    vol = Math.max(0.0002, Math.min(0.0025, vol));
    const o = price;
    const c = o * (1 + drift + (rnd() + rnd() + rnd() - 1.5) * vol * 2);
    const hi = Math.max(o, c) * (1 + rnd() * vol);
    const lo = Math.min(o, c) * (1 - rnd() * vol);
    candles.push({ t: start + i * 60000, o, h: hi, l: lo, c, v: Math.round(200 + rnd() * 400) });
    price = c;
  }
  return candles;
}

// ---------------------------------------------------------------- Main selector
async function getCandles(symbol, tf, bars, opts = {}) {
  const B = Math.min(Math.max(bars || 300, 40), opts.allowBig ? 20000 : 5000);
  // 1. MT5 bridge
  if (!opts.noMt5) {
    const mt5 = getMt5(symbol, tf);
    if (mt5 && mt5.history && mt5.history.length >= 20) {
      const arr = (mt5.history || []).map((r) => ({
        t: toMs(r.t) || toMs(r.time) || 0,
        o: r.o, h: r.h, l: r.l, c: r.c,
        v: r.v !== undefined ? r.v : r.vol !== undefined ? r.vol : 0,
      }));
      arr.sort((a, b) => a.t - b.t);
      const candles = arr.slice(-B).filter((c) => c.t && c.h >= c.l);
      if (candles.length >= 20) {
        return { source: "mt5", candles, generatedAt: Date.now(), label: "XM MT5 bridge" };
      }
    }
  }
  // 2. Yahoo
  if (!opts.noYahoo) {
    const y = await getYahoo(symbol, tf, B);
    if (y) return { source: y.source, label: y.source === "yahoo" ? "Yahoo spot gold" : "Yahoo gold futures", candles: y.candles, note: y.note, generatedAt: Date.now() };
  }
  // 3. Uploaded CSV
  const up = getUpload(symbol, tf);
  if (up && up.length >= 20) {
    return { source: "csv", label: "Uploaded CSV (MT4/MT5 export)", candles: up.slice(-B), generatedAt: Date.now() };
  }
  // 4. Synthetic demo
  return {
    source: "demo",
    label: "DEMO data (no live source connected)",
    candles: getSynthetic(B),
    note: "No live feed detected. This is generated demo data - enable Yahoo in-console or connect XM MT5 for real analysis.",
    generatedAt: Date.now(),
  };
}

module.exports = { getCandles, putUpload, listMt5Files, TF_MS, parseMT4CSV, resample };