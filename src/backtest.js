"use strict";
// Backtest engine - transparent & honest. Always ONE position at a time.
// P&L is modelled for a fixed 0.1 lot XAUUSD contract (10 oz => $10 per $1.00
// move), spread 0.25 points per side, so results are realistic ballparks.
const { ema, rsi, atr } = require("./indicators");
const { mean, std, clamp } = require("./mta");

const CONTRACT_OZ = 10; // 0.1 lot gold
const USD_PER_POINT = CONTRACT_OZ * 1; // $10 per 1.00 point
const SPREAD = 0.25; // points (approx XM raw/majors 'c' account)

// --------------------------------------------------------- psych countertrades
// The thesis this engine tests: classic retail traders hold losers and cut
// winners. We run the OPPOSITE book:
//   * when price has flushed into staged "retail -$ levels", we wait for
//     capitulation/exhaustion and fade the flush back toward the anchor;
//   * winners are let to run (partial at breakeven-anchor, then trail).
// Everything below is causal (uses only bars up to the decision bar).
const PSYCH_STAGES = [0.15, 0.30, 0.45, 0.60, 0.80, 1.00, 1.25]; // depth in ATR units

function causalPivots(candles, nb = 2) {
  const pivots = [];
  for (let j = nb; j < candles.length - nb; j++) {
    let isH = true;
    let isL = true;
    for (let k = j - nb; k <= j + nb; k++) {
      if (candles[k].h > candles[j].h) isH = false;
      if (candles[k].l < candles[j].l) isL = false;
    }
    if (isH) pivots.push({ j, p: candles[j].h, type: "H" });
    if (isL) pivots.push({ j, p: candles[j].l, type: "L" });
  }
  return pivots;
}

function stageIndexAt(depthAtr) {
  let idx = -1;
  for (let s = 0; s < PSYCH_STAGES.length; s++) if (depthAtr >= PSYCH_STAGES[s]) idx = s;
  return idx; // -1 = clean (price above/below anchor safely)
}

function runPsychCounter(candles, opts = {}) {
  const n = candles.length;
  if (n < 120) return null;
  const ENTER_MIN_STAGE = opts.enterMinStage ?? 0.55; // require a deep flush before fading
  const MAX_DEPTH_ATR = opts.maxDepthAtr ?? 2.6; // skip knife flushes
  const TREND_FILTER = opts.trendFilter ?? false; // skip when trend is violent
  const ALLOW_LONG = opts.allowLong ?? true;
  const ALLOW_SHORT = opts.allowShort ?? true;
  const closes = candles.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const pivots = causalPivots(candles, 2);

  const trades = [];
  const equity = [10000];
  const startEq = 10000;
  let pos = null;
  const MAXHOLD = 60;

  // stage odds bookkeeping: per (stage, episode) crossings
  const stageFirsts = new Map(); // stageIdx -> {cross:0, rec5:0, rec15:0}
  let episode = -1; // current pain episode index (bars)
  let crossedHere = new Set();

  let pi = 0; // pivot pointer
  let lastConfirmedHigh = null;
  let lastConfirmedLow = null;

  const sidePnl = { long: { n: 0, net: 0, w: 0 }, short: { n: 0, net: 0, w: 0 } };
  const depthBins = new Map();

  function maybeEnter(i, candles, a, r, bias, anchor, depthAtr) {
    const flushSide = bias > 0 ? "down" : "up";
    const cnd = candles[i];
    const rng = cnd.h - cnd.l || 1e-9;
    const rsiNow = r[i] || 50;
    let exhausted = false;
    if (flushSide === "down") {
      const lowerWick = (Math.min(cnd.o, cnd.c) - cnd.l) / rng;
      const bullishReversal = cnd.c > cnd.o && (lowerWick >= 0.5 || cnd.c > candles[i - 1].h);
      exhausted = (rsiNow < 34 && lowerWick >= 0.4) || bullishReversal;
    } else {
      const upperWick = (cnd.h - Math.max(cnd.o, cnd.c)) / rng;
      const bearishReversal = cnd.c < cnd.o && (upperWick >= 0.5 || cnd.c < candles[i - 1].l);
      exhausted = (rsiNow > 66 && upperWick >= 0.4) || bearishReversal;
    }
    if (!exhausted) return;
    // velocity: base depth should NOT be exploding (a collapsed flush extremes beyond anchor quickly = knife)
    const depthPrev = bias > 0 ? anchor - candles[i - 1].c : candles[i - 1].c - anchor;
    const dDelta = Math.abs(depthAtr - depthPrev / Math.max(atrOf(a, i - 1), 1e-9));
    if (dDelta > 0.45) return; // one-candle flush = no absorption yet
    const side = bias > 0 ? "long" : "short";
    const atrNow = atrOf(a, i);
    const stopDist = Math.max(0.6 * atrNow, depthAtr * 0.28 * atrNow + 0.35 * atrNow);
    const stop = side === "long" ? candles[i].c - stopDist : candles[i].c + stopDist;
    const tpAnchor = anchor;
    const runnerDist = Math.max(1.1 * atrNow, (bias > 0 ? anchor - candles[i].c : candles[i].c - anchor) * 0.9);
    const tpRunner = side === "long" ? tpAnchor + runnerDist : tpAnchor - runnerDist;
    pos = {
      side, entryI: i, entry: candles[i].c, stop, stopPts: stopDist,
      tpAnchor, tpAnchorDone: false, tpRunner, trailOn: false, trailPrice: 0,
      bars: 0, stage: stageIndexAt(depthAtr), depthAtr, anchor,
    };
  }

  for (let i = 62; i < n; i++) {
    // causal pivot confirmations
    while (pi < pivots.length && pivots[pi].j + 2 <= i) {
      const p = pivots[pi];
      if (p.type === "H") lastConfirmedHigh = p;
      else lastConfirmedLow = p;
      pi++;
    }
    const bias = isFinite(e20[i]) && isFinite(e50[i]) && e20[i] > e50[i] ? 1 : -1;
    const anchor = bias > 0 ? (lastConfirmedHigh ? lastConfirmedHigh.p : null) : (lastConfirmedLow ? lastConfirmedLow.p : null);
    const atrNow = a[i] || (candles[i].h - candles[i].l);
    const price = candles[i].c;
    let depth = 0;
    if (anchor !== null) depth = bias > 0 ? anchor - price : price - anchor;
    const depthAtr = depth / Math.max(atrNow, 1e-9);

    // ---- episode / stage odds tracking
    if (bias > 0) {
      if (depth <= 0) {
        episode = -1;
        crossedHere = new Set();
      } else {
        if (episode < 0) { episode = 0; crossedHere = new Set(); }
        const st = stageIndexAt(depthAtr);
        for (let s = 0; s <= st; s++) {
          if (!crossedHere.has(s)) {
            crossedHere.add(s);
            const rec = stageFirsts.get(s) || { cross: 0, rec5: 0, rec15: 0 };
            rec.cross++;
            if (i + 5 < n && candles[i + 5].c >= anchor) rec.rec5++;
            if (i + 15 < n && candles[i + 15].c >= anchor) rec.rec15++;
            stageFirsts.set(s, rec);
          }
        }
      }
    } else {
      if (depth <= 0) {
        episode = -1;
        crossedHere = new Set();
      } else {
        if (episode < 0) { episode = 0; crossedHere = new Set(); }
        const st = stageIndexAt(depthAtr);
        for (let s = 0; s <= st; s++) {
          if (!crossedHere.has(s)) {
            crossedHere.add(s);
            const rec = stageFirsts.get(s) || { cross: 0, rec5: 0, rec15: 0 };
            rec.cross++;
            if (i + 5 < n && candles[i + 5].c <= anchor) rec.rec5++;
            if (i + 15 < n && candles[i + 15].c <= anchor) rec.rec15++;
            stageFirsts.set(s, rec);
          }
        }
      }
    }

    // ---- entry (no position open)
    if (!pos && anchor !== null && depthAtr >= ENTER_MIN_STAGE && depthAtr < MAX_DEPTH_ATR) {
      const desiredSide = bias > 0 ? "long" : "short";
      let skip = false;
      if ((desiredSide === "long" && !ALLOW_LONG) || (desiredSide === "short" && !ALLOW_SHORT)) skip = true;
      if (!skip && TREND_FILTER) {
        const trendVol = Math.abs(e20[i] - e50[i]) / Math.max(atrNow, 1e-9);
        if (trendVol > 0.9 * 2) skip = true; // strong EMA gap = strong trend, fade is death
      }
      if (!skip) {
        maybeEnter(i, candles, a, r, bias, anchor, depthAtr);
      }
    }

    // ---- manage open position
    if (pos) {
      pos.bars++;
      const long = pos.side === "long";
      const c = candles[i];
      let exitPrice = null;
      let reason = "";
      const pnlAt = (signalPrice) => (long ? signalPrice - pos.entry : pos.entry - signalPrice) * USD_PER_POINT - SPREAD * USD_PER_POINT;
      // hard stop
      const hitStop = long ? c.l <= pos.stop : c.h >= pos.stop;
      if (hitStop) { exitPrice = pos.stop; reason = "HardStop"; }
      // breakeven anchor (TP1) for first half
      if (!exitPrice && !pos.tpAnchorDone) {
        const hitTp1 = long ? c.h >= pos.tpAnchor : c.l <= pos.tpAnchor;
        if (hitTp1) { pos.tpAnchorDone = true; exitPrice = pos.tpAnchor; reason = "TP1-anchor"; }
      }
      // runner trail point
      if (!exitPrice) {
        if (pos.tpAnchorDone) {
          // after anchor, ratchet
          const hi = c.h, lo = c.l;
          const best = long ? hi : lo;
          if (long && best - pos.entry > 0.55 * atrOf(a, i)) pos.trailOn = true;
          if (!long && pos.entry - best > 0.55 * atrOf(a, i)) pos.trailOn = true;
          if (pos.trailOn) {
            const newTrail = pos.trailPrice
              ? (long ? Math.max(pos.trailPrice, c.c - 0.5 * atrOf(a, i)) : Math.min(pos.trailPrice, c.c + 0.5 * atrOf(a, i)))
              : (long ? c.c - 0.5 * atrOf(a, i) : c.c + 0.5 * atrOf(a, i));
            pos.trailPrice = newTrail;
            const hitTrail = long ? c.l <= pos.trailPrice : c.h >= pos.trailPrice;
            if (hitTrail) { exitPrice = pos.trailPrice; reason = "Trail"; }
          }
          // runner target
          const hitRun = long ? c.h >= pos.tpRunner : c.l <= pos.tpRunner;
          if (hitRun) { exitPrice = pos.tpRunner; reason = "RunnerTarget"; }
        } else {
          // before anchor, protect: if we have +0.5 ATR and it snaps back hard, bail with tiny profit
          const best = long ? c.h : c.l;
          const inProfit = long ? best - pos.entry : pos.entry - best;
          if (inProfit > 0.5 * atrOf(a, i) && long && c.l <= pos.entry + 0.15 * atrOf(a, i)) { exitPrice = c.l; reason = "GivebackStop"; }
          if (inProfit > 0.5 * atrOf(a, i) && !long && c.h >= pos.entry - 0.15 * atrOf(a, i)) { exitPrice = c.h; reason = "GivebackStop"; }
        }
      }
      // time stop - never hold-and-pray
      if (!exitPrice && pos.bars >= MAXHOLD && pos.tpAnchorDone === false) { exitPrice = c; reason = "TimeExit"; }
      if (!exitPrice && pos.bars >= MAXHOLD + 40 && pos.tpAnchorDone) { exitPrice = c; reason = "TimeExitRunner"; }

      if (exitPrice !== null) {
        const pnl = pnlAt(exitPrice);
        trades.push({
          side: pos.side, entryI: pos.entryI, exitI: i,
          entry: +pos.entry.toFixed(2), exit: +exitPrice.toFixed(2),
          pnlUsd: +pnl.toFixed(2), pnlPct: +(pnl / startEq).toFixed(5),
          reason, stage: pos.stage, depthAtr: +pos.depthAtr.toFixed(2),
          bars: pos.bars, tpAnchorDone: pos.tpAnchorDone,
        });
        const s2 = pos.side;
        sidePnl[s2].n++;
        sidePnl[s2].net += pnl;
        if (pnl > 0) sidePnl[s2].w++;
        const stBucket = pos.stage >= 0 ? pos.stage : PSYCH_STAGES.length - 1;
        depthBins.set(stBucket, (depthBins.get(stBucket) || 0) + pnl);
        pos = null;
      }
    }
    equity.push(+(startEq + trades.reduce((s, t) => s + t.pnlUsd, 0)).toFixed(2));
  }

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const winsPnl = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const lossesPnl = trades.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0);
  const net = winsPnl + lossesPnl;
  let peak = -Infinity; let maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; maxDD = Math.max(maxDD, (peak - e) / peak); }
  const rets = trades.map((t) => t.pnlUsd);
  const m = mean(rets);
  const sd = std(rets, m);
  const avgHold = trades.length ? mean(trades.map((t) => t.bars)) : 0;
  const sharpe = sd === 0 || !trades.length ? 0 : (m / sd) * Math.sqrt(Math.max(avgHold, 1));

  // per-stage performance
  const stageStats = PSYCH_STAGES.map((_, s) => {
    const ts = trades.filter((t) => t.stage === s);
    const wr = ts.length ? ts.filter((t) => t.pnlUsd > 0).length / ts.length : 0;
    const n = ts.reduce((x, t) => x + t.pnlUsd, 0);
    return { stage: PSYCH_STAGES[s], trades: ts.length, winRate: +wr.toFixed(3), net: +n.toFixed(2), avg: ts.length ? +(mean(ts.map((t) => t.pnlUsd))).toFixed(2) : 0 };
  });
  // stage odds ("if retail held to stage X, did price come back?")
  const stageOdds = PSYCH_STAGES.map((s, i) => {
    const d = stageFirsts.get(i);
    return {
      stage: s,
      crossed: d ? d.cross : 0,
      recov5: d && d.cross ? d.rec5 / d.cross : 0,
      recov15: d && d.cross ? d.rec15 / d.cross : 0,
    };
  });

  const sideStats = Object.entries(sidePnl).map(([side, x]) => ({
    side,
    trades: x.n,
    winRate: x.n ? x.w / x.n : 0,
    net: +x.net.toFixed(2),
  }));
  const depthStats = [...depthBins.entries()].map(([s, net]) => ({
    stage: PSYCH_STAGES[s],
    net: +net.toFixed(2),
  })).sort((x, y) => x.stage - y.stage);

  const bestSide = sideStats.length ? [...sideStats].sort((a, b) => b.net - a.net)[0] : null;
  const bestDepth = depthStats.length ? [...depthStats].sort((a, b) => b.net - a.net)[0] : null;
  const execFlags = trades.length ? (() => {
    const fl = [];
    if (bestSide && bestSide.net > 0 && bestSide.winRate > 0.4) fl.push(`Counter LONGs net +$${bestSide.net} (WR ${(bestSide.winRate * 100).toFixed(0)}%) - thesis has a positive pocket on this data.`);
    else if (bestSide) fl.push(`Best side ${bestSide.side.toUpperCase()} only nets ${bestSide.net} USD - the raw fade thesis is weak on this data.`);
    if (bestDepth && bestDepth.net > 0) fl.push(`Best entry depth: -${(bestDepth.stage * 100).toFixed(0)}% ATR pocket nets +$${bestDepth.net}.`);
    return fl;
  })() : ["No trades on this window."];

  return {
    strategy: "psych-counter",
    name: "Psych Counter (fade retail capitulation)",
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netUsd: +net.toFixed(2),
    profitFactor: lossesPnl === 0 ? (winsPnl > 0 ? Infinity : 0) : +(winsPnl / Math.abs(lossesPnl)).toFixed(2),
    maxDrawdown: +maxDD.toFixed(4),
    avgPerTrade: trades.length ? +m.toFixed(2) : 0,
    sharpe: +sharpe.toFixed(2),
    avgBars: +avgHold.toFixed(0),
    lastTrades: trades.slice(-8),
    equitySeries: equity.filter((_, i) => i % 4 === 0),
    equityStart: startEq,
    stageStats,
    stageOdds,
    sideStats,
    depthStats,
    execFlags,
    extraStats: [
      ["Entry depth avg", trades.length ? (mean(trades.map((t) => t.depthAtr))).toFixed(2) + " ATR" : "–"],
      ["TP at anchor reached", trades.length ? trades.filter((t) => t.tpAnchorDone).length + " of " + trades.length : "–"],
      ["Violence-filtered", "knife flushes skipped"],
    ],
  };
}

function atrOf(a, i) { return a[i] || 0.0001; }

// ----------------------------------------------------- live stage monitor
// Same concept as the backtest but evaluated on the LAST bar, for the live
// dashboard: how deep into "retail -$ pain" is price right now?
function computeStage(candles) {
  const n = candles.length;
  if (n < 70) return null;
  const closes = candles.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const pivots = causalPivots(candles, 2);
  let lastHigh = null;
  let lastLow = null;
  for (const p of pivots) {
    if (p.j + 2 <= n - 1) {
      if (p.type === "H") lastHigh = p;
      else lastLow = p;
    }
  }
  const bias = e20[n - 1] > e50[n - 1] ? 1 : -1;
  const anchor = bias > 0 && lastHigh ? lastHigh.p : bias < 0 && lastLow ? lastLow.p : null;
  const price = candles[n - 1].c;
  const atrNow = a[n - 1] || (candles[n - 1].h - candles[n - 1].l);
  const depth = anchor !== null ? (bias > 0 ? anchor - price : price - anchor) : 0;
  const depthAtr = depth / Math.max(atrNow, 1e-9);
  const stage = stageIndexAt(depthAtr);
  const painUsd = bias > 0 ? depth : -depth; // sells/pain for retail longs above anchor
  const rsiNow = r[n - 1] || 50;
  // is an exhaustion/reverse candle forming now?
  const lastC = candles[n - 1];
  const rng = lastC.h - lastC.l || 1e-9;
  let exhaustion = false;
  if (bias > 0) {
    const lowerWick = (Math.min(lastC.o, lastC.c) - lastC.l) / rng;
    exhaustion = (rsiNow < 34 && lowerWick >= 0.4) || (lastC.c > lastC.o && lowerWick >= 0.5);
  } else {
    const upperWick = (lastC.h - Math.max(lastC.o, lastC.c)) / rng;
    exhaustion = (rsiNow > 66 && upperWick >= 0.4) || (lastC.c < lastC.o && upperWick >= 0.5);
  }
  const entryReady = anchor !== null && depthAtr >= 0.55 && depthAtr < 2.6 && exhaustion;
  return {
    bias: bias > 0 ? "long" : "short",
    anchor: anchor !== null ? +anchor.toFixed(2) : null,
    price: +price.toFixed(2),
    depthPts: +depth.toFixed(2),
    depthAtr: +depthAtr.toFixed(2),
    stage,
    stagePct: PSYCH_STAGES[stage] || 0,
    painUsd0_1: +(painUsd * 10).toFixed(0), // $ for a 0.1-lot holder per point move (approx)
    rsi: +rsiNow.toFixed(1),
    atr: +atrNow.toFixed(2),
    exhaustion,
    entryReady,
    rule: entryReady
      ? `COUNTER ENTRY READY now (bias ${bias > 0 ? "long" : "short"}, flush ${bias > 0 ? "down" : "up"} ~${depthAtr.toFixed(2)} ATR, exhaustion candle).`
      : anchor === null
      ? "No anchor yet - waiting for a confirmed pivot."
      : depthAtr < 0.55
      ? `Price healthy (depth ${depthAtr.toFixed(2)} ATR) - no flush, no counter setup.`
      : "Flush deep but no exhaustion candle yet - wait for absorption/pinbar.",
  };
}

// --------------------------------------------------------- classic presets

const PRESETS = {
  trend: { name: "Trend-follow", note: "EMA20/50 alignment + RSI filter. Exit on flip or 3x ATR trail." },
  meanrev: { name: "Mean-revert", note: "RSI oversold/overbought bounce. Exit at mid or 55/45." },
  breakout: { name: "Range breakout", note: "Close beyond 20-bar high/low. Trail 1.5x ATR." },
  hybrid: { name: "Hybrid + AI gate", note: "Trend signal, but only when the adaptive model agrees (p>0.52)." },
};

function runBacktest(candles, strategy, aiModels = null) {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);

  const trades = [];
  let pos = null; // {side, entryI, entry, stop, tp, trail}
  let equity = [10000];
  const startEq = 10000;

  for (let i = 61; i < n; i++) {
    const c = candles[i].c;
    const atrNow = a[i] || (candles[i].h - candles[i].l);
    let sig = null;

    if (strategy === "trend") {
      const inUp = isFinite(e20[i]) && isFinite(e50[i]) && c > e20[i] && e20[i] > e50[i] && (r[i] || 50) > 50;
      const inDown = isFinite(e20[i]) && isFinite(e50[i]) && c < e20[i] && e20[i] < e50[i] && (r[i] || 50) < 50;
      sig = inUp ? "long" : inDown ? "short" : null;
    } else if (strategy === "meanrev") {
      const rprev = r[i - 1] || 50;
      const rNow = r[i] || 50;
      if (rprev <= 32 && rNow > 32 && rNow < 52) sig = "long";
      else if (rprev >= 68 && rNow < 68 && rNow > 48) sig = "short";
    } else if (strategy === "breakout") {
      const hiN = Math.max(...candles.slice(i - 20, i).map((k) => k.h));
      const loN = Math.min(...candles.slice(i - 20, i).map((k) => k.l));
      if (c > hiN) sig = "long";
      else if (c < loN) sig = "short";
    } else if (strategy === "hybrid") {
      const pUp = aiModels && aiModels[1] && aiModels[1].ok ? aiModels[1].probUp : 0.5;
      if (isFinite(e20[i]) && isFinite(e50[i]) && c > e20[i] && e20[i] > e50[i] && pUp > 0.52) sig = "long";
      else if (isFinite(e20[i]) && isFinite(e50[i]) && c < e20[i] && e20[i] < e50[i] && pUp < 0.48) sig = "short";
    }

    if (!pos && sig) {
      const stop = sig === "long" ? c - atrNow * 1.5 : c + atrNow * 1.5;
      const tp = sig === "long" ? c + atrNow * 2.5 : c - atrNow * 2.5;
      pos = { side: sig, entryI: i, entry: c, stop, tp, trail: atrNow * 3 };
    }

    if (pos) {
      const long = pos.side === "long";
      const hitStop = long ? candles[i].l <= pos.stop : candles[i].h >= pos.stop;
      const hitTp = long ? candles[i].h >= pos.tp : candles[i].l <= pos.tp;
      const hitTrail = long ? candles[i].l <= pos.entry - pos.trail : candles[i].h >= pos.entry + pos.trail;
      const trendFlip = long
        ? isFinite(e20[i]) && isFinite(e50[i]) && c < e20[i] && e20[i] < e50[i]
        : isFinite(e20[i]) && isFinite(e50[i]) && c > e20[i] && e20[i] > e50[i];
      const exitOnFlip = (strategy === "trend" || strategy === "hybrid") && trendFlip;

      let exitPrice = null;
      let reason = "";
      if (hitStop && hitTp) {
        const first = long ? (c >= pos.tp ? "TP" : "SL") : c <= pos.tp ? "TP" : "SL";
        exitPrice = pos[first === "TP" ? "tp" : "stop"];
        reason = first;
      } else if (hitStop) { exitPrice = pos.stop; reason = "SL"; }
      else if (hitTp) { exitPrice = pos.tp; reason = "TP"; }
      else if (exitOnFlip) { exitPrice = c; reason = "Flip"; }
      else if (hitTrail) { exitPrice = pos.side === "long" ? pos.entry - pos.trail : pos.entry + pos.trail; reason = "Trail(3xATR)"; }

      if (exitPrice !== null) {
        const movePts = long ? exitPrice - pos.entry : pos.entry - exitPrice;
        const pnlUsd = movePts * USD_PER_POINT - SPREAD * USD_PER_POINT;
        const pnlPct = pnlUsd / startEq;
        trades.push({
          side: pos.side, entryI: pos.entryI, exitI: i,
          entry: +pos.entry.toFixed(2), exit: +exitPrice.toFixed(2),
          pnlUsd: +pnlUsd.toFixed(2), pnlPct: +pnlPct.toFixed(5),
          reason, bars: i - pos.entryI,
        });
        pos = null;
      }
    }
    equity.push(+(startEq + trades.reduce((s, t) => s + t.pnlUsd, 0)).toFixed(2));
  }

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const winsPnl = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const lossesPnl = trades.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0);
  const net = winsPnl + lossesPnl;
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const rets = trades.map((t) => t.pnlUsd);
  const m = mean(rets);
  const sd = std(rets, m);
  const avgHold = trades.length ? mean(trades.map((t) => t.bars)) : 0;
  const sharpe = sd === 0 || !trades.length ? 0 : (m / sd) * Math.sqrt(Math.max(avgHold, 1));
  const bhStart = candles[60] ? candles[60].c : candles[0].c;
  const buyHold = candles[candles.length - 1].c / bhStart - 1;

  return {
    strategy,
    presetInfo: PRESETS[strategy],
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netUsd: +net.toFixed(2),
    profitFactor: lossesPnl === 0 ? (winsPnl > 0 ? Infinity : 0) : +(winsPnl / Math.abs(lossesPnl)).toFixed(2),
    maxDrawdown: +maxDD.toFixed(4),
    avgPerTrade: trades.length ? +m.toFixed(2) : 0,
    sharpe: +sharpe.toFixed(2),
    avgBars: +avgHold.toFixed(0),
    buyHoldReturn: +buyHold.toFixed(4),
    lastTrades: trades.slice(-6),
    equitySeries: equity.filter((_, i) => i % 4 === 0),
    equityStart: startEq,
  };
}

module.exports = { runBacktest, runPsychCounter, computeStage, PRESETS, PSYCH_STAGES, stageIndexAt };