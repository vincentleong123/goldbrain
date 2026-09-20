"use strict";
// REVERSE engine.
//
// Core idea (the reverse of the textbook trade):
//  * Retail/naive setups (momentum chases, hold-with-no-stop) are opened as a
//    CONTINUOUS virtual 0.01-lot book and watched trial-and-error.
//  * From history + accumulated trials we learn the "D-certain" distance: the
//    point where these trades are (almost) certainly negative by d EUR
//    (recovery probability collapses to ~0).
//  * When a live naive trade reaches that liquidation zone, we take the
//    OPPOSITE side of the SETUP (buy where longs were liquidated, sell where
//    shorts died) and HOLD it back to the crowd's break-even - a long-horizon,
//    high-RR mean-reversion trade. No stops until the flush extends beyond the
//    certain-negative floor.
const { ema, rsi, atr, bollinger, macd, vwap } = require("../../src/indicators");
const { marketStructure } = require("../../src/patterns");

const TF_LABEL = { M5: "5m", M15: "15m", H1: "1h", H4: "4h", D1: "1d" };
const MIN_SIM = 20;      // bars of forward path required to resolve a trial
const MAX_SIM = 200;     // forward horizon for a trial
const BURNOUT = 90;      // cap on trials kept on disk

function pct(arrAsc, q) {
  if (!arrAsc.length) return 0;
  const i = Math.min(arrAsc.length - 1, Math.max(0, Math.ceil(q * arrAsc.length) - 1));
  return arrAsc[i];
}

function nice(v, d = 2) {
  return v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(d);
}

// ------------------------------------------------------------------ indicators
function makeInds(candles) {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const m = macd(closes, 12, 26, 9);
  const vw = vwap(candles);
  const lastFin = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
    return NaN;
  };
  return {
    closes, highs, lows, e20, e50, r, a, bb, macdHist: m.hist, macdLine: m.line, macdSig: m.signal, vw,
    atrNow: lastFin(a), rsiNow: lastFin(r), e20Now: lastFin(e20), e50Now: lastFin(e50), vwNow: lastFin(vw),
  };
}

// --------------------------------------------------------- naive victim setups
// Momentum chases + no-stop holds are what retail gets liquidated on. Generate
// a regular stream of them (both sides) so the book can trial them non-stop.
function naiveChases(candles, inds) {
  const a = inds.a, c = inds.closes;
  const out = [];
  let lastI = -99;
  for (let i = 30; i < candles.length - 1; i++) {
    const fast2 = Math.abs(c[i] - c[i - 2]);
    const fast3 = Math.abs(c[i] - c[i - 3]);
    const at = isFinite(a[i]) ? a[i] : 1;
    const strong = fast2 >= 1.2 * at || fast3 >= 1.5 * at;
    if (!strong) continue;
    if (i - lastI < 8) continue;
    const side = c[i] - c[i - 2] >= 0 ? "L" : "S";
    out.push({ i, t: candles[i].t, e: c[i], side });
    lastI = i;
  }
  return out;
}

function forwardPath(candles, entryI, side) {
  const n = candles.length;
  const H = Math.min(MAX_SIM, n - entryI - 1);
  if (H < MIN_SIM) return null;
  let minF = Infinity, maxF = -Infinity;
  const e = candles[entryI].c;
  for (let k = entryI + 1; k <= entryI + H; k++) {
    const f = side === "L" ? candles[k].c - e : e - candles[k].c;
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
  }
  return { d: -minF, rec: maxF, H }; // d positive = worst adverse distance (EUR per 1 oz)
}

// D-certain curve: for each distance d, what fraction of naive trades that ever
// reached -d later recovered to +d. Where that collapses to ~0 is the point of
// "certain negative" - the liquidation floor used for the reverse hold.
function learnCurve(arr) {
  const ds = arr.map((x) => x.d).filter((v) => v > 0).sort((x, y) => x - y);
  const out = [];
  if (ds.length < 4) {
    return { curve: out, stats: { n: 0 }, dCertain: null, dZero: null };
  }
  const maxD = pct(ds, 0.99);
  const nBins = 30;
  const step = maxD / nBins || 0.001;
  for (let b = 1; b <= nBins; b++) {
    const d = b * step;
    const grp = arr.filter((x) => x.d >= d);
    if (!grp.length) continue;
    const rec = grp.filter((x) => x.rec >= d).length;
    out.push({ d: +d.toFixed(2), n: grp.length, pRecover: +(rec / grp.length).toFixed(3) });
  }
  let dCertain = null;
  let dZero = null;
  let lastN = 0;
  for (const g of out) {
    if (g.n >= 6 && g.pRecover <= 0.11 && dCertain === null) dCertain = g.d;
    if (g.n >= 3 && g.pRecover === 0 && dZero === null) dZero = g.d;
    lastN = g.n;
  }
  if (dCertain === null && out.length) dCertain = pct(ds, 0.95);
  if (dZero === null && out.length) dZero = maxD * 1.15;
  const med = pct(ds, 0.5), p75 = pct(ds, 0.75), p90 = pct(ds, 0.9), p95 = pct(ds, 0.95), p99 = pct(ds, 0.99);
  return {
    curve: out,
    stats: { n: ds.length, median: med, p75, p90, p95, p99, max: maxD },
    dCertain, dZero,
  };
}

// ------------------------------------------------------------ careful strategies
function simExit(candles, i, side, stopDist, tgtDist, maxBars) {
  const e = candles[i].c;
  for (let k = i + 1; k <= Math.min(candles.length - 1, i + maxBars); k++) {
    const h = candles[k].h, l = candles[k].l;
    if (side === "L") {
      if (l <= e - stopDist) return { k, pnl: -stopDist };
      if (h >= e + tgtDist) return { k, pnl: tgtDist };
    } else {
      if (h >= e + stopDist) return { k, pnl: -stopDist };
      if (l <= e - tgtDist) return { k, pnl: tgtDist };
    }
  }
  const end = candles[Math.min(candles.length - 1, i + maxBars)].c;
  return { k: Math.min(candles.length - 1, i + maxBars), pnl: side === "L" ? end - e : e - end };
}

function detectStrategies(candles, inds) {
  const a = inds.a, bb = inds.bb, r = inds.r, c = inds.closes, hi = inds.highs, lo = inds.lows;
  const v = candles.map((x) => x.v || 0);
  const volAvg = (at) => {
    let s = 0; const st = Math.max(0, at - 19);
    for (let k = st; k <= at; k++) s += v[k];
    return s / (at - st + 1) || 1;
  };
  const entries = []; // {strat, side, i}
  const maxBars = 45;
  const gap = new Map();
  for (let i = 40; i < candles.length - 1; i++) {
    const at = isFinite(a[i]) ? a[i] : 2;
    const open = candles[i].o;
    // trend: ema20 x ema50 + momentum + vwap confirmation
    const crossUp = isFinite(inds.e20[i]) && isFinite(inds.e50[i]) && inds.e20[i - 1] <= inds.e50[i - 1] && inds.e20[i] > inds.e50[i];
    const crossDn = isFinite(inds.e20[i]) && isFinite(inds.e50[i]) && inds.e20[i - 1] >= inds.e50[i - 1] && inds.e20[i] < inds.e50[i];
    if (crossUp && isFinite(r[i]) && r[i] > 55 && c[i] > inds.vw[i]) entries.push({ strat: "trend", side: "L", i });
    if (crossDn && isFinite(r[i]) && r[i] < 45 && c[i] < inds.vw[i]) entries.push({ strat: "trend", side: "S", i });
    // meanrevert: touches lower band + RSI panic + reversal candle
    const bullRev = c[i] > open && candles[i - 1].c < candles[i - 1].o;
    if (lo[i] <= bb.lower[i] && isFinite(r[i]) && r[i] < 32 && (bullRev || candles[i].h - c[i] > 0.4 * (hi[i] - lo[i]))) entries.push({ strat: "meanrev", side: "L", i });
    const bearRev = c[i] < open && candles[i - 1].c > candles[i - 1].o;
    if (hi[i] >= bb.upper[i] && isFinite(r[i]) && r[i] > 68 && (bearRev || c[i] - lo[i] > 0.4 * (hi[i] - lo[i]))) entries.push({ strat: "meanrev", side: "S", i });
    // breakout: compact range then close beyond 20-bar extreme on volume
    const st = Math.max(0, i - 21);
    const rH = Math.max(...hi.slice(st, i));
    const rL = Math.min(...lo.slice(st, i));
    const compact = (rH - rL) < 2.4 * at;
    if (compact && c[i] > rH && v[i] > 0.8 * volAvg(i)) entries.push({ strat: "breakout", side: "L", i });
    if (compact && c[i] < rL && v[i] > 0.8 * volAvg(i)) entries.push({ strat: "breakout", side: "S", i });
    // fade (retail counter): deep flush + exhaustion off the 30-bar anchor
    const hi30 = Math.max(...hi.slice(Math.max(0, i - 30), i + 1));
    const lo30 = Math.min(...lo.slice(Math.max(0, i - 30), i + 1));
    const pierce = lo30 - c[i];
    const exhaustedL = bullRev || candles[i].h - c[i] > 0.5 * (hi[i] - lo[i]) || pierce > 0.7 * at;
    const exhaustedS = bearRev || c[i] - lo[i] > 0.5 * (hi[i] - lo[i]) || pierce > 0.7 * at;
    if (pierce > 0 && isFinite(r[i]) && r[i] < 40 && exhaustedL) entries.push({ strat: "fade", side: "L", i });
    if (c[i] - hi30 > 0 && isFinite(r[i]) && r[i] > 60 && exhaustedS) entries.push({ strat: "fade", side: "S", i });
  }
  // dedupe + spacing, sim exits
  const trades = [];
  const sims = {};
  for (const e of entries) {
    const key = e.strat;
    const last = gap.get(key) || -99;
    if (e.i - last < 12) continue;
    gap.set(key, e.i);
    const at = isFinite(a[e.i]) ? a[e.i] : 2;
    const stopDist = 1.2 * at, tgtDist = 1.6 * at;
    const ex = simExit(candles, e.i, e.side, stopDist, tgtDist, maxBars);
    trades.push({
      strat: e.strat, side: e.side, i: e.i, t: candles[e.i].t,
      entry: nice(candles[e.i].c), stop: nice(e.side === "L" ? candles[e.i].c - stopDist : candles[e.i].c + stopDist),
      target: nice(e.side === "L" ? candles[e.i].c + tgtDist : candles[e.i].c - tgtDist),
      rr: +(tgtDist / stopDist).toFixed(2), pnl: nice(ex.pnl, 2),
      reason: reasonPhrase(e.strat, e.side, e.i, candles, inds),
      open: e.i >= candles.length - 4,
    });
  }
  for (const k of ["trend", "meanrev", "breakout", "fade"]) {
    const ts = trades.filter((t) => t.strat === k);
    sims[k] = {
      trades: ts.length, wins: ts.filter((t) => t.pnl > 0).length,
      losses: ts.filter((t) => t.pnl < 0).length,
      net: nice(ts.reduce((s, t) => s + t.pnl, 0)),
      winRate: ts.length ? +(ts.filter((t) => t.pnl > 0).length / ts.length).toFixed(3) : 0,
    };
  }
  return { trades, sims };
}

function reasonPhrase(strat, side, i, candles, inds) {
  const dir = side === "L" ? "long" : "short";
  const at = isFinite(inds.a[i]) ? inds.a[i].toFixed(2) : "?";
  switch (strat) {
    case "trend": return `EMA20/50 cross ${dir} with RSI ${isFinite(inds.r[i]) ? inds.r[i].toFixed(0) : "?"} confirming, price on the right side of VWAP. ATR ${at}.`;
    case "meanrev": return `Touch of the ${side === "L" ? "lower" : "upper"} Bollinger band + panic RSI ${isFinite(inds.r[i]) ? inds.r[i].toFixed(0) : "?"} + exhaustion candle. Mean-revert ${dir}.`;
    case "breakout": return `Compact range (${nice((Math.max(...inds.highs.slice(Math.max(0, i - 21), i)) - Math.min(...inds.lows.slice(Math.max(0, i - 21), i))) / at)}A) broke with rising volume. Early ${dir} breakout.`;
    default: return `Deep flush off the 30-bar anchor (>0.55 ATR) with exhaustion RSI ${isFinite(inds.r[i]) ? inds.r[i].toFixed(0) : "?"}. Counter-fade ${dir} (retail liquidation).`;
  }
}

// ------------------------------------------------------------------ main entry
function analyzeReverse(candles, state, ui) {
  const n = candles.length;
  const empty = (msg) => ({
    ok: false, note: msg, price: { last: null }, stats: { n: 0 }, dCertain: null, dZero: null,
    curve: [], strategies: { trades: [], sims: {} }, naive: { book: [], sold: [] }, reverse: null, flow: null, series: emptySeries(),
  });

  if (n < 120) return empty("Need >= ~120 bars of XAUEUR history to work.");

  const inds = makeInds(candles);
  const price = candles[n - 1].c;
  const eurUsd = ui.eurUsd || 1.09;
  const tf = ui.tf || "M15";
  const tfStepsPerDay = { M5: 288, M15: 96, H1: 24, H4: 6, D1: 1 }[tf] || 96;

  // ---- D-certain from batch simulation + accumulated trials
  const chases = naiveChases(candles, inds);
  const resolved = [];
  const unresolved = [];
  for (const ch of chases) {
    const fp = forwardPath(candles, ch.i, ch.side);
    if (fp) resolved.push({ t: ch.t, side: ch.side, ...fp });
    else unresolved.push(ch);
  }

  // ---- reconcile persisted book into trials (continuous accumulation)
  let trials = Array.isArray(state.trials) ? state.trials : [];
  const trialKey = (t, s) => `${t}|${s}`;
  const haveTrials = new Set(trials.map((x) => trialKey(x.t, x.side)));
  const book = Array.isArray(state.book) ? state.book : [];
  const newBook = [];
  for (const b of book) {
    let idx = -1;
    for (let i = 0; i < n; i++) if (candles[i].t === b.t) { idx = i; break; }
    if (idx < 0) { newBook.push(b); continue; }
    const fp = forwardPath(candles, idx, b.side);
    if (fp) {
      if (!haveTrials.has(trialKey(b.t, b.side))) {
        trials.push({ t: b.t, side: b.side, ...fp });
        haveTrials.add(trialKey(b.t, b.side));
      }
    } else newBook.push(b);
  }
  // new unresolved chases join the book for the next refresh
  for (const u of unresolved) {
    if (!book.some((b) => b.t === u.t && b.side === u.side) && !haveTrials.has(trialKey(u.t, u.side))) {
      newBook.push({ t: u.t, side: u.side, e: u.e });
      haveTrials.add(trialKey(u.t, u.side));
    }
  }
  for (const b of book) if (!newBook.some((x) => x.t === b.t && x.side === b.side)) newBook.push(b);
  if (trials.length > BURNOUT * 2) trials = trials.slice(-BURNOUT * 2);

  const learn = learnCurve(resolved.concat(trials));
  const dCertain = learn.dCertain;
  const dZero = learn.dZero;

  // ---- live naive book + liquidation candidates
  const live = [];
  for (const b of newBook) {
    let idx = -1;
    for (let i = 0; i < n; i++) if (candles[i].t === b.t) { idx = i; break; }
    const float = b.side === "L" ? price - b.e : b.e - price;
    live.push({
      side: b.side, t: b.t, entry: nice(b.e), float: nice(float),
      ageBars: idx >= 0 ? n - 1 - idx : null,
      depthFrac: dCertain ? nice((float < 0 ? -float : 0) / dCertain * 100, 0) : null,
    });
  }
  live.sort((x, y) => (x.float || 0) - (y.float || 0));

  const victim = live.length
    ? live.reduce((best, x) => (x.float < best.float ? x : best))
    : null;

  // ---- reverse hold plan on the worst victim (liquidation zone)
  let reverse = null;
  if (victim && dCertain && victim.float < 0 && -victim.float <= dCertain * 2) {
    let vIdx = -1;
    for (let i = 0; i < n; i++) if (candles[i].t === victim.t) { vIdx = i; break; }
    if (vIdx >= 0) {
      const bench = victim.side === "L"
        ? Math.max(...inds.highs.slice(Math.max(0, vIdx - 40), vIdx + 1))
        : Math.min(...inds.lows.slice(Math.max(0, vIdx - 40), vIdx + 1));
      const at = inds.atrNow || 2;
      const depth = victim.side === "L" ? bench - price : price - bench; // distance back to crowd entry
      const dirName = victim.side === "L" ? "BUY the liquidation, hold long" : "SELL the squeeze, hold short";
      const stopDist = dCertain * 0.8 + 1.2 * at;
      const stop = victim.side === "L" ? price - stopDist : price + stopDist;
      const rr = nice(depth / stopDist);
      const ready = depth > 0 && rr >= 1.0 && (-victim.float / dCertain) > 0.4;
      reverse = {
        active: ready, side: victim.side === "L" ? "L" : "S", dirName,
        victim: { side: victim.side, t: victim.t, entry: victim.entry, float: victim.float, depthFrac: victim.depthFrac },
        entry: nice(price), bench: nice(bench), stop: nice(stop),
        target: nice(bench), rr, depth,
        holdTo: "crowd break-even (the origin of the naive trade)",
        invalidation: `price extends past ${nice(victim.side === "L" ? price + (dCertain + 1.5 * at) : price - (dCertain + 1.5 * at))} - real news, not a flush.`,
        maxHoldBars: 6 * tfStepsPerDay,
        note: `Naive ${victim.side === "L" ? "long" : "short"} is ${nice(-victim.float)} EUR under water on 0.01 lot (${victim.depthFrac}% of D-certain ${nice(dCertain||0)}). When the crowd exits here, the opposite hold triple-back into their own stop levels.`,
      };
    }
  }

  // ---- careful strategy trades
  const stratRes = detectStrategies(candles, inds);
  const allTrades = stratRes.trades.slice(-18).map((t) => ({
    ...t, stratLabel: { trend: "Trend", meanrev: "Mean-revert", breakout: "Breakout", fade: "Fade/counter" }[t.strat] || t.strat,
    t: t.t, side: t.side, entry: t.entry, stop: t.stop, target: t.target, rr: t.rr, pnl: t.pnl, reason: t.reason, open: t.open,
  }));

  // ---- flow note (no order-book feed in this data)
  const vols = candles.map((x) => x.v || 0);
  const volAvg = vols.length ? vols.slice(-40).reduce((s, x) => s + x, 0) / 40 : 0;
  const flow = {
    available: false,
    note: "No order-flow feed (only bar volume from the source). Open-orders and stop-loss clusters can't be read - the reverse plan is built from the naive-book adverse statistics instead.",
    volNow: vols[vols.length - 1] || 0, volAvg: Math.round(volAvg) || 0,
    volRatio: volAvg ? nice((vols[vols.length - 1] || 0) / volAvg, 2) : null,
  };

  // ---- chart series (thinned)
  const thin = thinTo(candles, 600);
  const struct = marketStructure(candles, 2);

  return {
    ok: true,
    symbol: "XAUEUR", tf, tfLabel: TF_LABEL[tf] || tf, now: Date.now(),
    price: {
      last: nice(price), prev: nice(candles[n - 2].c), changePct: nice((price - candles[n - 2].c) / candles[n - 2].c, 6),
      eurUsd: nice(eurUsd, 4), ts: candles[n - 1].t,
    },
    struct: { label: struct.label, bullish: struct.bullish, bearish: struct.bearish },
    ind: {
      atr: nice(inds.atrNow), rsi: nice(inds.rsiNow), e20: nice(inds.e20Now), e50: nice(inds.e50Now),
      vwap: nice(inds.vwNow), bbPos: null,
    },
    contract: {
      lot: ui.lot, ozPerLot: ui.ozPerLot, perPointEur: nice(ui.ozPerLot * ui.lot),
      perPointUsd: nice(ui.ozPerLot * ui.lot * eurUsd),
      note: `${ui.lot} lot = ${ui.ozPerLot * ui.lot} oz -> EUR ${ui.ozPerLot * ui.lot} for every EUR 1.00 in gold price`,
    },
    dCertain: nice(dCertain), dZero: nice(dZero), curve: learn.curve,
    stats: { ...learn.stats, median: nice(learn.stats.median), p75: nice(learn.stats.p75), p90: nice(learn.stats.p90), p95: nice(learn.stats.p95), p99: nice(learn.stats.p99) },
    strategies: { trades: allTrades, sims: stratRes.sims },
    naive: { book: live.slice(0, 12), trials: trials.length },
    reverse,
    flow,
    series: { candles: thin, bench: reverse ? reverse.bench : null },
    state: { trials, book: newBook },
  };
}

function thinTo(candles, maxPts) {
  const n = candles.length;
  if (n <= maxPts) return candles.map((c) => ({ t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2), l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v || 0 }));
  const step = Math.ceil(n / maxPts);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(candles[i]);
  out[out.length - 1] = candles[n - 1];
  return out.map((c) => ({ t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2), l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v || 0 }));
}

function emptySeries() {
  return { candles: [], bench: null };
}

module.exports = { analyzeReverse, forwardPath, naiveChases, learnCurve };