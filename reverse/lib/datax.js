"use strict";
// XAUEUR data provider for the REVERSE dashboard.
// Source order: MT5 bridge files (from ../data/mt5, GoldPalBridge export)
//              -> Yahoo cross  XAUUSD=X / EURUSD=X   (XAU in EUR = USD-per-oz / USD-per-EUR)
//              -> clearly-labelled synthetic demo (EUR, for offline tinkering).
const fs = require("fs");
const path = require("path");

const DATA_FOLDER = path.join(__dirname, "..", "..", "data", "mt5");

const TF_MS = { M5: 5 * 60e3, M15: 15 * 60e3, H1: 3600e3, H4: 4 * 3600e3, D1: 86400e3 };
const YAHOO_INTERVAL = { M5: "5m", M15: "15m", H1: "60m", D1: "1d" };
const RANGES = [["1d", 1440], ["5d", 7200], ["1mo", 43200], ["3mo", 129600], ["6mo", 259200], ["1y", 525600], ["2y", 1051200], ["5y", 2628000], ["10y", 5256000], ["max", 1e12]];

const cache = new Map();

function toMs(t) {
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  if (!isNaN(n)) return n;
  return Number(t) || 0;
}

function pickRange(needMin) {
  for (const [r, min] of RANGES) if (needMin <= min) return r;
  return "max";
}

// ------------------------------------------------------------- MT5 bridge files
function listMt5Files() {
  try {
    return fs.readdirSync(DATA_FOLDER).filter((f) => /\.(json|csv)$/i.test(f));
  } catch {
    return [];
  }
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const gi = (names) => header.findIndex((h) => names.some((a) => h.includes(a)));
  const iO = gi(["open"]), iH = gi(["high"]), iL = gi(["low"]), iC = gi(["close"]), iV = gi(["volume"]);
  const iD = gi(["date"]), iT = gi(["time"]);
  if (iO < 0 || iH < 0 || iL < 0 || iC < 0) return [];
  const out = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(sep).map((s) => s.replace(/^"|"$/g, "").trim());
    if (cells.length < 5) continue;
    const o = parseFloat(cells[iO]), h = parseFloat(cells[iH]), l = parseFloat(cells[iL]), c = parseFloat(cells[iC]);
    if (![o, h, l, c].every(isFinite) || h < l || o <= 0) continue;
    let t = 0;
    if (iD >= 0) {
      const dateStr = cells[iD];
      const timeStr = iT >= 0 && cells[iT] ? " " + cells[iT] : "";
      const dt = new Date(dateStr.replace(/\./g, "-") + timeStr);
      t = isNaN(dt.getTime()) ? toMs(parseFloat(cells[iD])) : dt.getTime();
    } else if (iT >= 0) t = toMs(cells[iT]);
    if (!t) continue;
    out.push({ t, o, h, l, c, v: iV >= 0 && cells[iV] ? Math.round(parseFloat(cells[iV])) || 0 : 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function getMt5Candles(tf) {
  const want = (tf || "M15").toUpperCase();
  const files = listMt5Files();
  if (!files.length) return null;
  for (const f of files) {
    const base = f.replace(/\.(json|csv)$/i, "");
    const upper = base.toUpperCase().replace(/\s+/g, "");
    if (!upper.includes("XAUEUR")) continue;
    const m = upper.match(/([MH]\d+|D1)$/);
    const ftf = m ? m[1] : "";
    if (ftf && ftf !== want) {
      const line = base.match(/[_\-.](\w+)$/);
      if (line && line[1].toUpperCase() !== want) continue;
      if (!line) continue;
    }
    try {
      let arr;
      if (/\.json$/i.test(f)) {
        const obj = JSON.parse(fs.readFileSync(path.join(DATA_FOLDER, f), "utf8"));
        arr = (obj.history || obj.candles || obj.bars || []).map((r) => ({
          t: toMs(r.t) || toMs(r.time) || 0, o: r.o, h: r.h, l: r.l, c: r.c,
          v: r.v !== undefined ? r.v : r.vol !== undefined ? r.vol : 0,
        }));
      } else {
        arr = parseCSV(fs.readFileSync(path.join(DATA_FOLDER, f), "utf8"));
      }
      arr.sort((a, b) => a.t - b.t);
      const candles = arr.filter((c) => c.t && c.h >= c.l);
      if (candles.length >= 40) return candles;
    } catch {
      /* try next file */
    }
  }
  return null;
}

// ------------------------------------------------------------- Yahoo cross
async function yahooFetch(sym, interval, range) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) return null;
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
  if (!q) return null;
  const map = {};
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some((v) => v === null || v === undefined || !isFinite(v))) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    map[r.timestamp[i]] = { t: Number(r.timestamp[i]) * 1000, o, h, l, c, v: Math.round(q.volume ? q.volume[i] || 0 : 0) };
  }
  return map;
}

async function getYahooCandles(tf, bars) {
  const ms = TF_MS[tf] || 15 * 60e3;
  const interval = YAHOO_INTERVAL[tf];
  if (!interval) return null;
  let range = pickRange(Math.ceil((bars * ms) / 60000) + 240);
  let gx = await yahooFetch("XAUUSD=X", interval, range);
  let ge = await yahooFetch("EURUSD=X", interval, range);
  if (!gx) {
    gx = await yahooFetch("GC=F", interval, range);
    if (gx) range = pickRange(1e12);
  }
  if (!gx || !ge) {
    ge = await yahooFetch("EURUSD=X", interval, pickRange(1e12));
  }
  if (!gx || !ge) return { candles: null, eurUsd: null };
  const keys = [];
  const tick = Math.min(...Object.keys(gx).map((k) => gx[k].t));
  for (const k of Object.keys(ge)) {
    if (!ge[k]) continue;
    const b = (ge[k].t / ms) * ms;
    if (b <= tick) continue;
    const gxk = Object.keys(gx).find((k2) => gx[k2] && Math.abs(gx[k2].t - ge[k].t) < 5000);
    if (!gxk || !gx[gxk]) continue;
    keys.push([gxk, k]);
  }
  if (!keys.length) return { candles: null, eurUsd: null };
  const candles = keys.map(([kx, ke]) => {
    const x = gx[kx];
    const e = ge[ke];
    const t = Math.round(x.t / ms) * ms;
    return { t, o: x.o / e.o, h: x.h / e.h, l: x.l / e.l, c: x.c / e.c, v: x.v };
  }).filter((m) => m.h >= m.l && m.o > 0 && m.c > 0 && m.h > 0).sort((a, b) => a.t - b.t).slice(-bars);
  const eurBackup = Object.values(ge).filter(Boolean);
  const eurUsd = eurBackup.length ? eurBackup[eurBackup.length - 1].c : 1.09;
  return { candles, eurUsd };
}

// ------------------------------------------------------------- Synthetic (EUR)
function getSynthetic(bars) {
  const candles = [];
  let price = 4050;
  const start = Date.now() - (bars - 1) * 15 * 60e3;
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let vol = 0.00042;
  for (let i = 0; i < bars; i++) {
    vol = vol * 0.99 + (rnd() - 0.5) * 0.00005;
    vol = Math.max(0.0002, Math.min(0.0018, vol));
    const o = price;
    const c = o * (1 + (rnd() - 0.5) * 0.00006 * 4 + (rnd() + rnd() + rnd() - 1.5) * vol * 2);
    const hi = Math.max(o, c) * (1 + rnd() * vol);
    const lo = Math.min(o, c) * (1 - rnd() * vol);
    candles.push({ t: start + i * 15 * 60e3, o, h: hi, l: lo, c, v: Math.round(180 + rnd() * 300) });
    price = c;
  }
  return candles;
}

// ------------------------------------------------------------- Main
async function getCandles(tf = "M15", bars = 500) {
  const key = `${(tf || "M15").toUpperCase()}|${bars}|cross`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 20000) return hit.data;

  const mt5 = getMt5Candles(tf);
  if (mt5) {
    const out = {
      candles: mt5.slice(-bars), source: "mt5", label: "XM MT5 bridge (XAUEUR)",
      note: "Reading real XAUEUR history from data/mt5.", eurUsd: 1.09, generatedAt: Date.now(),
    };
    cache.set(key, { t: Date.now(), data: out });
    return out;
  }

  const y = await getYahooCandles(tf, bars);
  if (y && y.candles && y.candles.length >= 40) {
    const out = {
      candles: y.candles, source: "yahoo-cross", label: "Yahoo cross  XAUUSD/EURUSD",
      note: "XAUEUR built as EUR-per-oz = XAUUSD(USD/oz) / EURUSD(USD/EUR).", eurUsd: y.eurUsd, generatedAt: Date.now(),
    };
    cache.set(key, { t: Date.now(), data: out });
    return out;
  }

  const out = {
    candles: getSynthetic(bars), source: "demo", label: "DEMO (synthetic EUR) - no live feed",
    note: "No MT5 XAUEUR files and Yahoo cross failed. Clearly-labelled synthetic film only.", eurUsd: 1.09, generatedAt: Date.now(),
  };
  cache.set(key, { t: Date.now(), data: out });
  return out;
}

module.exports = { getCandles, listMt5Files, TF_MS, parseCSV };