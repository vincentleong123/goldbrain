"use strict";
// Two-model duel engine.
//   CROWD  = the "normal" retail trader (your described style): enters on the
//            3 obvious signs (EMA trend + RSI momentum + breakout), doubles
//            down on -0.45 ATR of drawdown, triples down deeper, holds with
//            NO hard stop, banks tiny winners fast, and gets liquidated when
//            the flush runs ~1 ATR past their average - that liquidation is
//            the stop-loss-hunt grab: "precisely grab my money and stop".
//   FADE   = the opposite-psychology engine (src/backtest.js runPsychCounter):
//            waits for that exact deep flush + exhaustion candle, fades it
//            with a hard stop, banks half at the crowd's anchor (breakeven),
//            trails the runner. No hold-and-pray ever.
// runDuel   runs both over the SAME history and names a winner.
// walkDuel  does a rolling walk-forward over the backward history so you can
//           see if the pattern-recognition edge is consistent over time.
const { ema, rsi, atr } = require("./indicators");
const { mean, std, clamp } = require("./mta");
const { runPsychCounter } = require("./backtest");

const USD_PER_POINT = 10; // $10 per $1.00 move per 0.1-lot unit
const SPREAD_PTS = 0.25;  // approx XM raw commission-equivalent per side

// ------------------------------------------------------------- CROWD MODEL
function runCrowd(candles, opts = {}) {
  const n = candles.length;
  if (n < 70) return null;
  const closes = candles.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);

  const LIQ_ATR = opts.liqAtr ?? 1.0;     // liquidation at this ATR past average
  const ADD_GAP = opts.addGap ?? 0.45;    // ATR drawdown from average to add again
  const PROFIT_CUT = opts.profitCut ?? 0.3; // crowd banks winners this early

  const trades = [];
  const equity = [10000];
  const startEq = 10000;
  let pos = null;
  let net = 0;

  function exitStack(i, price, reason, atrNow) {
    const exitP = price;
    const tickets = pos.adds + 2; // base entry + adds + exit
    const pnl = (exitP - pos.avgCost) * pos.sideSign * pos.units * USD_PER_POINT
                 - tickets * SPREAD_PTS * USD_PER_POINT;
    const drawAtExit = (Math.abs(exitP - pos.avgCost)) / Math.max(atrNow || a[i], 1e-9);
    trades.push({
      side: pos.side, entryBar: pos.entryBar, exitBar: i,
      initialEntry: +pos.initialEntry.toFixed(2),
      entry: +pos.avgCost.toFixed(2), exit: +exitP.toFixed(2),
      units: pos.units, adds: pos.adds,
      pnlUsd: +pnl.toFixed(2), pnlPct: +(pnl / startEq).toFixed(5),
      reason, bars: i - pos.entryBar, drawAtr: +drawAtExit.toFixed(2),
    });
    net += pnl;
    pos = null;
  }

  for (let i = 70; i < n; i++) {
    const c = candles[i].c;
    const atrNow = a[i] || (candles[i].h - candles[i].l) || 1e-9;
    const hi20 = Math.max(...candles.slice(i - 20, i).map((k) => k.h));
    const lo20 = Math.min(...candles.slice(i - 20, i).map((k) => k.l));

    // --- fresh entry: the crowd's "3 obvious signs" -------------------------
    if (!pos) {
      const inUp = c > e20[i] && e20[i] > e50[i] && (r[i] || 50) > 55 && c > hi20;
      const inDown = c < e20[i] && e20[i] < e50[i] && (r[i] || 50) < 45 && c < lo20;
      if (inUp || inDown) {
        const side = inUp ? "long" : "short";
        pos = {
          side, sideSign: side === "long" ? 1 : -1,
          initialEntry: c, avgCost: c, units: 1, adds: 0, entryBar: i,
        };
      }
      equity.push(+(startEq + net).toFixed(2));
      continue;
    }

    // --- management: add / profit-cut / liquidation -------------------------
    const dr = (pos.side === "long" ? (pos.avgCost - c) : (c - pos.avgCost)) / atrNow;
    if (dr >= ADD_GAP && pos.adds === 0) {
      pos.units += 2;
      pos.avgCost = (pos.avgCost * (pos.units - 2) + c * 2) / pos.units;
      pos.adds = 1;
    } else if (dr >= ADD_GAP * 2 && pos.adds === 1) {
      pos.units += 3;
      pos.avgCost = (pos.avgCost * (pos.units - 3) + c * 3) / pos.units;
      pos.adds = 2;
    }

    const fav = pos.side === "long" ? (c - pos.avgCost) : (pos.avgCost - c);
    if (fav / atrNow >= PROFIT_CUT) {
      exitStack(i, c, "ProfitCut", atrNow);
      equity.push(+(startEq + net).toFixed(2));
      continue;
    }

    const liqLevel = pos.side === "long"
      ? pos.avgCost - LIQ_ATR * atrNow
      : pos.avgCost + LIQ_ATR * atrNow;
    const hitLiq = pos.side === "long" ? candles[i].l <= liqLevel : candles[i].h >= liqLevel;
    if (hitLiq) {
      exitStack(i, liqLevel, "Liquidated", atrNow);
      equity.push(+(startEq + net).toFixed(2));
      continue;
    }
    equity.push(+(startEq + net).toFixed(2));
  }
  if (pos) exitStack(n - 1, candles[n - 1].c, "TimeUp", a[n - 1] || 1e-9);

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const liq = trades.filter((t) => t.reason === "Liquidated");
  const liqPnl = liq.reduce((s, t) => s + t.pnlUsd, 0);
  const liqAvg = liq.length ? liqPnl / liq.length : 0;
  const winsPnl = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const lossesPnl = trades.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0);
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; maxDD = Math.max(maxDD, (peak - e) / peak); }
  const rets = trades.map((t) => t.pnlUsd);
  const m = mean(rets);
  const sd = std(rets, m);
  const avgHold = trades.length ? mean(trades.map((t) => t.bars)) : 0;
  const sharpe = sd === 0 || !trades.length ? 0 : (m / sd) * Math.sqrt(Math.max(avgHold, 1));

  return {
    strategy: "crowd",
    name: "Crowd / normal trader (3 obvious signs + averaging down + no stop)",
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
    liqCount: liq.length,
    liqLoss: +liqPnl.toFixed(2),
    liqAvgLoss: liq.length ? +(liqPnl / liq.length).toFixed(2) : 0,
    avgUnitsAtExit: trades.length ? +(mean(trades.map((t) => t.units))).toFixed(1) : 0,
    lastTrades: trades.slice(-8),
    equitySeries: equity.filter((_, i) => i % 4 === 0),
    equityStart: startEq,
    ...(opts.detail ? { fullTrades: trades } : {}),
    extraStats: [
      ["Liquidations (stop-hunts)", liq.length + " of " + trades.length + " stacks"],
      ["Stop-hunt grab", liq.length ? "avg $" + Math.abs(liqAvg).toFixed(0) + " / grab" : "none on window"],
      ["Avg stack at exit", trades.length ? mean(trades.map((t) => t.units)).toFixed(2) + "x lot" : "–"],
      ["Add (double/triple) rate", trades.length ? (trades.filter((t) => t.adds).length / trades.length * 100).toFixed(0) + "%" : "–"],
    ],
  };
}

// ------------------------------------------------------------- DUEL
function runDuel(candles, opts = {}) {
  const crowd = runCrowd(candles, opts);
  const fade = runPsychCounter(candles, opts);
  let verdict = null;
  if (crowd && fade) {
    const fadeWins = fade.netUsd > crowd.netUsd;
    const edge = Math.abs(fade.netUsd - crowd.netUsd);
    verdict = {
      winner: fadeWins ? "fade" : "crowd",
      winnerName: fadeWins ? "Opposite (fade)" : "Crowd (normal)",
      fadeNet: +fade.netUsd.toFixed(2),
      crowdNet: +crowd.netUsd.toFixed(2),
      edgeUsd: +edge.toFixed(2),
      liqCount: crowd.liqCount || 0,
      note: fadeWins
        ? `The fade book took ${fade.trades} counter entries while the crowd bled $${Math.abs(Math.round(crowd.netUsd))} across ${crowd.trades} "obvious" trades (${crowd.liqCount} liquidated) - the edge lives by fading exactly those grabs.`
        : `On this history the crowd's naive book beat the counter fade by $${Math.round(edge)} - the pattern-recognition edge did NOT pay here; shrink the fade, stay disciplined, look at more windows.`,
    };
  } else if (fade) {
    verdict = { winner: "fade", fadeNet: +fade.netUsd.toFixed(2), crowdNet: 0, edgeUsd: 0, liqCount: 0, note: "No crowd trades formed on this window." };
  }
  return { crowd, fade, verdict };
}

// ------------------------------------------------------------- WALK-FORWARD
function walkDuel(candles, opts = {}) {
  const WINDOW = opts.window ?? 1200;
  const STEP = opts.step ?? 250;
  const n = candles.length;
  const rows = [];
  if (n < WINDOW) return { done: 0, fadeWins: 0, crowdWins: 0, fadeWinRate: 0, avgFadeNet: 0, avgCrowdNet: 0, liqTotal: 0, rows: [] };
  let liqTotal = 0;
  for (let s = 0; s + WINDOW <= n; s += STEP) {
    const seg = candles.slice(s, s + WINDOW);
    if (seg.length < Math.min(500, WINDOW)) continue;
    const cw = runCrowd(seg, opts);
    const fd = runPsychCounter(seg, opts);
    if (!cw || !fd) continue;
    rows.push({
      start: new Date(seg[0].t).toISOString(),
      end: new Date(seg[seg.length - 1].t).toISOString(),
      crowdNet: Math.round(cw.netUsd), fadeNet: Math.round(fd.netUsd),
      crowdTrades: cw.trades, fadeTrades: fd.trades, liq: cw.liqCount || 0,
      winner: fd.netUsd > cw.netUsd ? "fade" : "crowd",
    });
    liqTotal += cw.liqCount || 0;
  }
  const done = rows.length;
  const fadeWins = rows.filter((x) => x.winner === "fade").length;
  const avgFade = done ? mean(rows.map((x) => x.fadeNet)) : 0;
  const avgCrowd = done ? mean(rows.map((x) => x.crowdNet)) : 0;
  return {
    done,
    fadeWins,
    crowdWins: done - fadeWins,
    fadeWinRate: done ? +(fadeWins / done).toFixed(3) : 0,
    avgFadeNet: +avgFade.toFixed(0),
    avgCrowdNet: +avgCrowd.toFixed(0),
    liqTotal,
    rows,
  };
}

module.exports = { runCrowd, runDuel, walkDuel, USD_PER_POINT, SPREAD_PTS };