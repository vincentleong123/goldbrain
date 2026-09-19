"use strict";
// Continuous crowd-vs-fade duel runner over backward history.
// Re-runs the two-model pattern-recognition duel on every cycle, writes
// data\duel-latest.json (current) and appends data\duel-log.jsonl (history),
// so results accumulate over a long time without any action from you.
//
//   node run-duel.js                     loop every 10 minutes (default)
//   node run-duel.js --once              run a single cycle and exit
//   node run-duel.js --every 900         loop every 15 minutes
//   node run-duel.js --tf M1,M2,M5,H1    pick timeframes
//   node run-duel.js --bars 2000         bars per timeframe
const { getCandles } = require("./src/data");
const { runDuel, walkDuel } = require("./src/duel");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");
const LATEST = path.join(DATA, "duel-latest.json");
const LOG = path.join(DATA, "duel-log.jsonl");

function arg(v, d) { const i = process.argv.indexOf(v); return i >= 0 ? process.argv[i + 1] : d; }
const once = process.argv.includes("--once");
const every = parseInt(arg("--every", "600"), 10) * 1000;
const tfs = (arg("--tf", "M1,M2,M5,H1") || "M1,M2,M5,H1").split(",").map((s) => s.trim().toUpperCase());
const bars = parseInt(arg("--bars", "2000"), 10) || 2000;
const symbol = (arg("--symbol", "XAUUSD") || "XAUUSD").toUpperCase();

function slim(res) {
  return res
    ? {
        name: res.name,
        trades: res.trades, wins: res.wins, losses: res.losses,
        winRate: +res.winRate.toFixed(3),
        netUsd: +res.netUsd.toFixed(2),
        profitFactor: res.profitFactor === Infinity ? "inf" : +res.profitFactor.toFixed(2),
        maxDrawdown: +res.maxDrawdown.toFixed(4),
        avgPerTrade: +res.avgPerTrade.toFixed(2),
        sharpe: res.sharpe,
        avgBars: res.avgBars,
        liqCount: res.liqCount ?? 0,
        liqLoss: +(res.liqLoss ?? 0).toFixed(2),
        avgUnitsAtExit: res.avgUnitsAtExit ?? 0,
        stageOdds: (res.stageOdds || []).slice(-6),
        sideStats: (res.sideStats || []).map((s) => ({ side: s.side, trades: s.trades, winRate: +s.winRate.toFixed(3), net: +s.net.toFixed(2) })),
        lastTrades: (res.lastTrades || []).slice(-4).map((t) => ({ side: t.side, reason: t.reason, pnlUsd: t.pnlUsd, depthAtr: t.depthAtr })),
      }
    : null;
}

async function cycle() {
  const rows = [];
  for (const tf of tfs) {
    try {
      const d = await getCandles(symbol, tf, bars);
      const duel = runDuel(d.candles, {});
      const walk = walkDuel(d.candles, {});
      rows.push({
        at: Date.now(),
        symbol, tf, bars: d.candles.length,
        source: d.source, label: d.label, note: d.note || "",
        price: d.candles.length ? +d.candles[d.candles.length - 1].c.toFixed(2) : 0,
        crowd: slim(duel.crowd),
        fade: slim(duel.fade),
        verdict: duel.verdict,
        walk,
      });
    } catch (e) {
      rows.push({ at: Date.now(), symbol, tf, error: String((e && e.message) || e) });
    }
  }
  const report = { at: Date.now(), generatedAt: Date.now(), command: process.argv.join(" "), tfs: rows };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LATEST, JSON.stringify(report, null, 2));
  fs.appendFileSync(LOG, JSON.stringify({ at: report.at, tfs: rows.map((r) => ({
    tf: r.tf, source: r.source, price: r.price,
    crowdNet: r.crowd && r.crowd.netUsd, fadeNet: r.fade && r.fade.netUsd,
    crowdTrades: r.crowd && r.crowd.trades, fadeTrades: r.fade && r.fade.trades,
    liq: r.crowd && r.crowd.liqCount,
    winner: r.verdict && r.verdict.winner,
    walkDone: r.walk && r.walk.done, walkFadeRate: r.walk && r.walk.fadeWinRate,
  })) }) + "\n");
  console.log("== duel cycle", new Date().toLocaleString(), "==");
  for (const r of rows) {
    if (r.error) { console.log("  " + r.tf.padEnd(4) + " ERROR " + r.error); continue; }
    const w = r.verdict ? r.verdict.winner : "?";
    const liq = r.crowd ? r.crowd.liqCount : "-";
    console.log(`  ${r.tf.padEnd(4)} ${r.source.padEnd(13)} px ${r.price}  crowd $${(r.crowd && r.crowd.netUsd) ?? 0} (${r.crowd && r.crowd.trades}tr, ${liq}liq)  fade $${(r.fade && r.fade.netUsd) ?? 0} (${r.fade && r.fade.trades}tr)  WINNER=${w}  walkFadeWR=${r.walk ? r.walk.fadeWinRate : "-"} (${r.walk ? r.walk.done : 0} windows)`);
  }
}

async function main() {
  await cycle();
  if (once) { console.log("once done."); process.exit(0); }
  console.log("looping every " + Math.round(every / 1000) + "s. Writes: " + LATEST + "\n");
  const iv = setInterval(cycle, every);
  iv.unref();
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { clearInterval(iv); console.log("duel loop stopped."); process.exit(0); });
}

main();