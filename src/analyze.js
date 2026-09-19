"use strict";
// Orchestrates the whole analysis for one request: data -> indicators ->
// patterns -> AI -> backtests -> 8 modes.
const { ema, rsi, atr, macd, bollinger, vwap, lastFinite } = require("./indicators");
const { supportResistance, marketStructure, candlePatterns, earlyMove, session } = require("./patterns");
const { trainAndPredict } = require("./ai");
const { runBacktest, runPsychCounter, computeStage } = require("./backtest");
const { modes } = require("./modes");
require("./personas"); // mounts psychicPower / superman / thinkTank / keepGoing / jiaYou
const { clamp } = require("./mta");

const TF_LABEL = { M1: "1 min", M5: "5 min", M15: "15 min", H1: "1 hour", H4: "4 hours", D1: "daily" };

function thinSeries(maxPoints, ...series) {
  const n = series[0].length;
  if (n <= maxPoints) return series.map((s) => s);
  const step = Math.ceil(n / maxPoints);
  const idxs = [];
  for (let i = 0; i < n; i += step) idxs.push(i);
  idxs[idxs.length - 1] = n - 1;
  return series.map((s) => idxs.map((i) => s[i]));
}

function analyze(candlesRaw, symbol, tf, bars, ui) {
  const candles = candlesRaw.slice(-Math.min(candlesRaw.length, bars));
  const n = candles.length;
  const closes = candles.map((c) => c.c);

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const macdRes = macd(closes, 12, 26, 9);
  const vw = vwap(candles);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const changePct = (last.c - prev.c) / prev.c;
  const price = last.c;
  const bf = (arr) => { const x = lastFinite(arr); return x.v; };
  const bfi = (arr) => lastFinite(arr).i;

  const rsiNow = bf(r);
  const atrNow = bf(a);
  const bbPos = isFinite(bb.upper[bfi(bb.upper)]) ? clamp((last.c - bb.lower[bfi(bb.lower)]) / ((bb.upper[bfi(bb.upper)] - bb.lower[bfi(bb.lower)]) || 1e-9), 0, 1) : 0.5;
  const macdHistNow = bf(macdRes.hist);
  const e20Now = bf(e20);
  const e50Now = bf(e50);
  const emaSpeed = (e20Now - e50Now) / e50Now;
  const vwapNow = bf(vw);
  const hi20 = Math.max(...candles.slice(-20).map((c) => c.h));
  const lo20 = Math.min(...candles.slice(-20).map((c) => c.l));

  const sr = supportResistance(candles, a, price);
  const struct = marketStructure(candles, 2);
  const patt = candlePatterns(candles, a);
  const early = earlyMove(candles, candles.length >= 80 ? (tf === "M1" ? 16 : 24) : 12);
  const sess = session(last.t);

  const ai = trainAndPredict(candles, Math.min(1800, candles.length));

  const backtests = {};
  for (const strat of ["trend", "meanrev", "breakout", "hybrid"]) {
    backtests[strat] = runBacktest(candles, strat, ai.ok && ai.horizons ? ai.horizons : null);
  }
  const psych = runPsychCounter(candles);
  if (psych) backtests["psych"] = psych;
  const stage = computeStage(candles);

  const [cS, e20S, e50S, bbUS, bbLS, vwS] = thinSeries(
    620, candles, e20, e50, bb.upper, bb.lower, vw
  );
  const [, , macdLS, macdS, histS] = thinSeries(620, candles, e20, macdRes.line, macdRes.signal, macdRes.hist);
  const [, rsiS] = thinSeries(620, candles, e20, r);

  const aiTrace = (ai.trace || []).slice(-300).map((t) => ({ t: t.t, p: +t.p.toFixed(3) }));

  const aiCtx = ai.ok && ai.horizons
    ? ai
    : { ok: false, verdict: null, horizons: { 1: null, 3: null, 6: null } };
  const modeCtx = {
    symbol, tf, bars: n, source: "", label: "",
    candles, price, prevClose: prev.c, changePct,
    session: sess,
    ind: { rsi: rsiNow, atr: atrNow, bbPos, macdHist: macdHistNow, emaSpeed, vwap: vwapNow, hi20, lo20, e20: e20Now, e50: e50Now },
    sr, struct, patt, early, ai: aiCtx,
    stage,
    btSummary: {
      psych: psych
        ? { trades: psych.trades, winRate: psych.winRate, netUsd: psych.netUsd, sideStats: psych.sideStats, profitFactor: psych.profitFactor }
        : null,
      best: bestStrategy(backtests),
    },
  };

  const modeResult = {};
  for (const key of Object.keys(modes)) {
    try {
      modeResult[key] = modes[key](modeCtx, ui);
    } catch (e) {
      modeResult[key] = { title: key, headline: "Mode failed to load", summary: String(e.message || e), sentiment: "warn", cards: [] };
    }
  }

  return {
    symbol, tf, tfLabel: TF_LABEL[tf], bars: n, now: Date.now(),
    contract: { price: +price.toFixed(2), changePct: +changePct.toFixed(5), ts: last.t, prevClose: +prev.c.toFixed(2) },
    ind: {
      rsi: +rsiNow.toFixed(1), atr: +atrNow.toFixed(2), bbPos: +bbPos.toFixed(2),
      macdHist: +macdHistNow.toFixed(4), emaSpeed: +emaSpeed.toFixed(6),
      vwap: +vwapNow.toFixed(2), hi20, lo20, e20: +e20Now.toFixed(2), e50: +e50Now.toFixed(2),
    },
    session: sess,
    sr: {
      supports: sr.support.slice(0, 4), resistances: sr.resistance.slice(0, 4),
      nearestSupport: sr.nearestSupport, nearestResistance: sr.nearestResistance,
    },
    struct: { label: struct.label, bullish: struct.bullish, bearish: struct.bearish },
    patterns: {
      recent: patt.recent.map((p) => ({ name: p.name, dir: p.dir, strength: +p.strength.toFixed(2), i: p.i, t: candles[p.i].t })),
      strongestUp: patt.strongestUp, strongestDown: patt.strongestDown, pull: +patt.pull.toFixed(2),
    },
    early: { ignition: early.ignition, strength: +early.strength.toFixed(2), note: early.note, rangeHigh: early.rangeHigh, rangeLow: early.rangeLow },
    ai: {
      ok: ai.ok,
      verdict: ai.verdict || null,
      horizons: {
        1: ai.horizons && ai.horizons[1] ? { probUp: +(ai.horizons[1].probUp || 0).toFixed(3), fwdAccuracy: +(ai.horizons[1].fwdAccuracy || 0.5).toFixed(3), fwdSize: ai.horizons[1].fwdSize || 0, samples: ai.horizons[1].samples || 0 } : null,
        3: ai.horizons && ai.horizons[3] ? { probUp: +(ai.horizons[3].probUp || 0).toFixed(3), fwdAccuracy: +(ai.horizons[3].fwdAccuracy || 0.5).toFixed(3) } : null,
        6: ai.horizons && ai.horizons[6] ? { probUp: +(ai.horizons[6].probUp || 0).toFixed(3), fwdAccuracy: +(ai.horizons[6].fwdAccuracy || 0.5).toFixed(3) } : null,
      },
      trace: aiTrace,
      dir: ai.verdict ? ai.verdict.dir : "side",
    },
    stage: stage
      ? {
          bias: stage.bias, anchor: stage.anchor, depthPts: stage.depthPts,
          depthAtr: stage.depthAtr, stage: stage.stage, stagePct: stage.stagePct,
          painUsd0_1: stage.painUsd0_1, rsi: stage.rsi, atr: stage.atr,
          exhaustion: stage.exhaustion, entryReady: stage.entryReady, rule: stage.rule,
        }
      : null,
    backtests,
    series: {
      candles: cS,
      ema20: e20S.map((v) => (isFinite(v) ? +v.toFixed(2) : null)),
      ema50: e50S.map((v) => (isFinite(v) ? +v.toFixed(2) : null)),
      bbUpper: bbUS.map((v) => (isFinite(v) ? +v.toFixed(2) : null)),
      bbLower: bbLS.map((v) => (isFinite(v) ? +v.toFixed(2) : null)),
      vwap: vwS.map((v) => (isFinite(v) ? +v.toFixed(2) : null)),
      macdLine: macdLS.map((v) => (isFinite(v) ? +v.toFixed(4) : null)),
      macdSignal: macdS.map((v) => (isFinite(v) ? +v.toFixed(4) : null)),
      macdHist: histS.map((v) => (isFinite(v) ? +v.toFixed(4) : null)),
      rsi: rsiS.map((v) => (isFinite(v) ? +v.toFixed(1) : null)),
    },
    modes: modeResult,
  };
}

module.exports = { analyze, TF_LABEL };

function bestStrategy(backtests) {
  let best = null;
  for (const [k, v] of Object.entries(backtests)) {
    if (!v || !v.trades) continue;
    if (!best || v.netUsd > best.netUsd) best = { key: k, name: v.name || v.presetInfo?.name || k, netUsd: v.netUsd, winRate: v.winRate, trades: v.trades };
  }
  return best;
}