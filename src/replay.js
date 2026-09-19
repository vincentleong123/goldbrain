"use strict";
// GoldBrain THEATRE - renders a fast-forwarded "movie" of history where you
// watch the AI read the chart, think, and trade on a paper (demo) account.
//
// Design:
//  * One pass over the bars. Scenes (analysis checkpoints) happen roughly
//    48x/day so the film has a heartbeat without re-running heavy analysis
//    every bar.
//  * Two brains - both are shown honestly:
//      - LOCAL STRUCTURE ENGINE (free, instant): stage/Pain-engine reads,
//        level map, session note, counter-setup detection.
//      - LLM SPARK (optional, needs your API key): when a counter setup
//        fires, the Reasoner is asked to think about THIS moment; its plan
//        + story become the movie's narration and the trade that (may) open.
//  * It NEVER sends orders. All trades are paper/demo only.
//  * Idealized fills (no per-bar intrabar path), like the backtester.
const fs = require("fs");
const path = require("path");
const { getCandles, resample, TF_MS } = require("./data");
const { atr, rsi, ema } = require("./indicators");
const { supportResistance, marketStructure, earlyMove, session } = require("./patterns");
const { computeStage } = require("./backtest");
const { callLLM, parsePlan, validatePlan, loadConfig, configStatus } = require("./reasoner");

const STEP_MS = { M1: 60e3, M5: 5 * 60e3, M15: 15 * 60e3, M30: 30 * 60e3, H1: 3600e3, H4: 4 * 3600e3, D1: 86400e3 };
const USD_PER_POINT = 10; // 0.1 lot XAUUSD = 10 oz, $10 per $1 price move
const PER_POINT_LOT = 100; // $ per $1 price move, per 1.00 lot
const WINDOW = 180;        // bars analysed per scene

// ---------------------------------------------------------------- history
// Real history where available; otherwise a deterministic stylised film.
async function loadHistory(symbol, tf, startTs, endTs) {
  const ms = STEP_MS[tf] || STEP_MS.M5;
  let raw = null;
  try {
    raw = await getCandles(symbol, tf, 20000, { allowBig: true });
  } catch {
    raw = null;
  }
  const candles = ((raw && raw.candles) || [])
    .filter((c) => c.t && c.h >= c.l && c.t >= startTs && c.t <= endTs)
    .sort((a, b) => a.t - b.t);

  if (candles.length >= 90) {
    return {
      candles,
      source: raw.source,
      label: raw.label || raw.source || "history",
      note: raw.note || "",
      startTs: candles[0].t,
      endTs: candles[candles.length - 1].t,
      stepMs: ms,
      synthesized: false,
    };
  }
  // not enough history -> build a stylised film across the requested window
  const syn = synthesizeHist(startTs, endTs, ms, seedOf(symbol + tf));
  return {
    candles: syn,
    source: "demo",
    label: "Synthetic stylised data (no historical file this long)",
    note: "This is a film star, not live gold. Set the MT5 bridge / Yahoo to replay real history.",
    startTs: syn[0].t,
    endTs: syn[syn.length - 1].t,
    stepMs: ms,
    synthesized: true,
  };
}

// deterministic seeded generator: drifts, pullbacks, flushes, recoveries.
function synthesizeHist(startTs, endTs, ms, seed) {
  const out = [];
  let price = 4400;
  let t = Math.floor(startTs / ms) * ms;
  const steps = Math.max(1, Math.round((endTs - startTs) / ms));
  let phase = 0; // 0 up 1 pull 2 flush 3 recover 4 range
  let phaseLeft = 0;
  let flushDir = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < steps; i++) {
    if (t > endTs) break;
    if (phaseLeft <= 0) {
      const roll = rnd();
      phase = roll < 0.30 ? 0 : roll < 0.5 ? 1 : roll < 0.72 ? 2 : roll < 0.88 ? 3 : 4;
      phaseLeft = 6 + Math.round(rnd() * 18);
      if (phase === 2) flushDir = rnd() < 0.5 ? -1 : 1;
    }
    phaseLeft--;
    let drift = 0.0000004;
    let volB = 0.0004;
    if (phase === 0) drift = 0.00002 * (rnd() < 0.7 ? 1 : -0.4);
    else if (phase === 1) drift = -0.000012;
    else if (phase === 2) { drift = 0.000065 * flushDir; volB = 0.0016; }
    else if (phase === 3) drift = 0.000012 * -flushDir;
    else drift = (rnd() - 0.5) * 0.00002;
    const o = price;
    const c = o * (1 + drift + (rnd() + rnd() + rnd() - 1.5) * volB * 2.2);
    const hi = Math.max(o, c) * (1 + rnd() * volB * 1.4);
    const lo = Math.min(o, c) * (1 - rnd() * volB * 1.4);
    out.push({ t, o, h: hi, l: lo, c, v: Math.round(200 + rnd() * 500) });
    price = c;
    t += ms;
  }
  return out;
}

function seedOf(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return x || 1;
}

// ---------------------------------------------------------------- analysis
function analyzeWindow(window) {
  const price = window[window.length - 1].c;
  const aAll = atr(window, 14);
  const sr = supportResistance(window, aAll, price);
  const struct = marketStructure(window, 2);
  const early = earlyMove(window, 24);
  const stageMs = window.length >= 75 ? computeStage(window) : null;
  return {
    price,
    atr: aAll[aAll.length - 1] || (window[window.length - 1].h - window[window.length - 1].l),
    sr,
    struct,
    early,
    stage: stageMs,
  };
}

// ---------------------------------------------------------------- trade math
function bracketFor(stage, atr, price, rrTarget) {
  const stopDist = Math.max(0.8 * atr, Math.max(0.35 * (stage.depthPts || 0), atr * 0.5));
  const dir = stage.bias === "long" ? 1 : -1;
  let entry = price;
  let stop = price - dir * stopDist;
  let target = price + dir * stopDist * rrTarget;
  if (stage.anchor && dir === 1) stop = Math.min(stop, stage.anchor - atr * 0.25);
  if (stage.anchor && dir === -1) stop = Math.max(stop, stage.anchor + atr * 0.25);
  if (dir === 1 && target < price + 0.3 * atr) target = price + 0.3 * atr;
  if (dir === -1 && target > price - 0.3 * atr) target = price - 0.3 * atr;
  return { direction: dir > 0 ? "long" : "short", entry, stop, target, rr: Math.abs(target - entry) / Math.abs(entry - stop) };
}

function sizeLots(balance, riskPct, stopDistUsd) {
  if (!stopDistUsd || stopDistUsd <= 0) return 0.1;
  const riskUsd = balance * clamp(riskPct, 0.1, 10) / 100;
  const lots = riskUsd / (stopDistUsd * PER_POINT_LOT);
  return clamp(Math.round(lots * 100) / 100, 0.1, 2);
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------- the movie
// hooks.onProgress(p, msg) called periodically during render.
async function renderMovie(symbol, tf, startTs, endTs, opts = {}, hooks = {}) {
  const useReasoner = !!opts.useReasoner;
  const maxSparks = useReasoner ? Math.max(0, Math.min(opts.sparks === undefined ? 6 : opts.sparks, 20)) : 0;
  const riskPct = opts.riskPct || 1;
  let balance = opts.balance || 1000;
  const startB = balance;
  const onProgress = hooks.onProgress || (() => {});

  const hist = await loadHistory(symbol, tf, startTs, endTs);
  const bars = hist.candles;
  const n = bars.length;
  const ms = hist.stepMs;
  const sceneStep = Math.max(1, Math.round(86400000 / (ms * 48))); // ~48 scenes/day

  const trades = [];
  const scenes = [];
  const thoughts = [];
  const eq = [];
  let open = null; // {dir, lots, entry, stop, target, i0, spark, story}
  let sparks = 0;
  let cooldownTo = 0;
  const lastSparkRef = { atr: 0, depth: 0, bar: -1 };

  const progressEvery = Math.max(sceneStep, 40);
  let lastProg = 0;

  for (let i = WINDOW; i < n; i++) {
    const c = bars[i];

    // ---- walk any open trade through this bar (idealised: whole-bar path)
    if (open) {
      const isLong = open.dir === "long";
      if (c.l <= open.stop || c.h >= open.target || c.h <= open.stop || c.l >= open.target) {
        const stopped = isLong ? c.l <= open.stop : c.h >= open.stop;
        const exit = stopped ? open.stop : open.target;
        const pnl = (exit - open.entry) * (isLong ? 1 : -1) * USD_PER_POINT * (open.lots / 0.1);
        balance += pnl;
        trades.push({ ...open, iClose: i, exit, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2), why: stopped ? "stop" : "target" });
        open = null;
        cooldownTo = i + 2 * sceneStep;
        continue;
      }
      if (i - open.i0 >= 40 * sceneStep) { // time-out
        const exit = c.c;
        const pnl = (exit - open.entry) * (isLong ? 1 : -1) * USD_PER_POINT * (open.lots / 0.1);
        balance += pnl;
        trades.push({ ...open, iClose: i, exit, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2), why: "time" });
        open = null;
        cooldownTo = i + sceneStep;
        continue;
      }
    }

    // ---- scene analysis
    if (i % sceneStep !== 0) { if (i > lastProg + progressEvery * 10) { lastProg = i; onProgress(i / n, `Rewinding to scene ${i}/${n}…`); } continue; }

    const window = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const a = analyzeWindow(window);
    const st = a.stage;

    eq.push([i, +balance.toFixed(2)]);

    const sess = session(c.t);
    const scene = {
      i,
      t: c.t,
      price: +a.price.toFixed(2),
      struct: a.struct.label,
      bullish: a.struct.bullish,
      bearish: a.struct.bearish,
      sr: {
        s: a.sr.nearestSupport !== null ? +a.sr.nearestSupport.toFixed(2) : null,
        r: a.sr.nearestResistance !== null ? +a.sr.nearestResistance.toFixed(2) : null,
      },
      ignition: a.early.ignition || "none",
      igniteNote: a.early.note || "",
      session: sess.name,
      sessNote: sess.note,
      stage: st
        ? {
            bias: st.bias, depthAtr: st.depthAtr, stage: st.stage, painUsd0_1: st.painUsd0_1,
            exhaustion: st.exhaustion, entryReady: st.entryReady, rule: st.rule, anchor: st.anchor,
          }
        : null,
    };
    scenes.push(scene);

    // ---- decisions
    const ready = !!st && st.entryReady && i >= cooldownTo && !open;
    if (ready) {
      const willSpark = useReasoner && sparks < maxSparks && configStatus().configured
        && (i - lastSparkRef.bar > 90 || sparks === 0);
      let plan = null;
      let who = "engine";
      let story = null;
      let reason = null;
      let sparkedNow = false;

      if (willSpark) {
        lastSparkRef.bar = i; lastSparkRef.atr = a.atr; lastSparkRef.depth = st.depthAtr;
        sparks++;
        sparkedNow = true;
        onProgress(i / n, "The AI is thinking about this moment…");
        try {
          const r = await sparkMoment(symbol, tf, window, a, st, sess, { balance, riskPct });
          who = "ai";
          story = r.story;
          reason = r.reason;
          if (r.plan && r.plan.ok && r.plan.direction !== "flat" && isFinite(r.plan.entry) && isFinite(r.plan.stop) && isFinite(r.plan.target)) {
            plan = r.plan;
          }
        } catch (e) {
          thoughts.push({ i, who: "system", text: "LLM spark failed (" + String((e && e.message) || e).slice(0, 80) + ") - engine takes over." });
        }
      }

      if (!plan) {
        const br = bracketFor(st, a.atr, a.price, opts.rrTarget || 1.5);
        const stopDistUsd = Math.abs(br.entry - br.stop);
        const lots = sizeLots(startB, riskPct, stopDistUsd);
        plan = {
          ok: true, direction: br.direction, conviction: 0.55, entry: br.entry, stop: br.stop,
          target: br.target, rr: +br.rr.toFixed(2), sizeNote: `${lots} x 0.1 lot`, validated: true,
        };
        if (who !== "ai") {
          story = `The ${tf} stage shows a ${st.depthAtr.toFixed(2)} ATR flush into right-of-way for the ${st.bias === "long" ? "buyers" : "sellers"} ("retail-pain"). No LLM key set, so the structure engine steps in: fade the flush with a hard stop, and the plan stays boring-on-purpose.`;
          reason = [st.rule, "hard stop, honest sizing"];
          thoughts.push({ i, who: "engine", text: "COUNTER SETUP - structure engine fades the flush (no AI key configured).", plan: plan });
        }
      } else {
        thoughts.push({ i, who: "ai", text: "THE AI IS ENGAGED - it read the flush and wrote a plan.", story, plan: plan, reason: reason });
      }

      const d = plan.direction;
      if (d === "long" || d === "short") {
        const lots = plan.sizeNote ? parseFloat(plan.sizeNote) || 0.1 : 0.1;
        open = { dir: d, lots, entry: plan.entry, stop: plan.stop, target: plan.target, i0: i, spark: who, story, reason: plan.reason || reason, look: plan.rr };
      }
      if (sparkedNow) cooldownTo = i + 8 * sceneStep;
    }

    if (i > lastProg + progressEvery) { lastProg = i; onProgress(i / n, `Scene ${i}/${n} - ${sess.name} session`); }
  }

  if (open) { const c = bars[n - 1]; const pnl = (c.c - open.entry) * (open.dir === "long" ? 1 : -1) * USD_PER_POINT * (open.lots / 0.1); balance += pnl; trades.push({ ...open, iClose: n - 1, exit: c.c, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2), why: "eod" }); }

  onProgress(1, "Popcorn ready.");
  const result = {
    meta: { symbol, tf, stepMs: ms, startTs: hist.startTs, endTs: hist.endTs, bars: n, source: hist.source, label: hist.label, synthesized: hist.synthesized, balanceEnd: +balance.toFixed(2), balanceStart: +startB.toFixed(2), trades: trades.length, sparks: thoughts.filter((t) => t.who === "ai").length, renderedMs: Date.now() },
    bars,
    scenes,
    thoughts,
    trades,
    eq,
  };
  return result;
}

// Ask the Reasoner to think about this exact moment (authentic, one plan).
async function sparkMoment(symbol, tf, window, a, st, sess, ui) {
  const cfg = loadConfig();
  if (!cfg.apiKey) return { story: null, reason: null, plan: null };
  const price = a.price;
  const levels = {
    sup: a.sr.nearestSupport ? a.sr.nearestSupport.toFixed(2) : "n/a",
    res: a.sr.nearestResistance ? a.sr.nearestResistance.toFixed(2) : "n/a",
  };
  const snapshot = `Mutable snapshot at ${new Date(window[window.length - 1].t).toISOString()}:\n` +
    `Symbol ${symbol} ${tf}. Last ${price}, ATR ${a.atr.toFixed(2)}.\n` +
    `Structure: ${a.struct.label}. Early move: ${a.early.ignition || "none"} (${a.early.note}).\n` +
    `Session: ${sess.name} - ${sess.note}.\n` +
    `Retail-pain: flush ${st.depthAtr.toFixed(2)} ATR off ${st.anchor}, painful for ${st.bias === "long" ? "long holders who bought high" : "short holders who sold low"}, ` +
    `pain per 0.1 lot $${Math.abs(st.painUsd0_1).toFixed(0)}, exhaustion candle ${st.exhaustion ? "yes" : "no"}.\n` +
    `Levels: nearest support ${levels.sup}, nearest resistance ${levels.res}.\n` +
    `A counter (fade-the-flush) setup just triggered. Your job: either approve it as a genuine plan, or honestly say flat.`;
  const system = `You are the thinking brain of a gold demo simulator. This is super-real educational theatre: you reason in public while a fast-forwarded chart plays. ` +
    `Be honest, be precise, be a little dramatic but never dishonest. Risk budget ${ui.riskPct}% of ${ui.balance}. ` +
    `OUTPUT ONLY JSON: {"direction":"long|short|flat","conviction":0..1,"entry":number,"stop":number,"target":number,"rr":number,"story":"2-4 vivid teaching sentences","reason":["2-3 short reasons"]}. ` +
    `Entry/stop/target are realistic gold prices near ${price}. Stop must be on the SAFE side of entry. If the flush is too ugly or levels kill it, say "flat" with a truthful story about why you waited.`;
  const text = await callLLM(cfg, system, snapshot, 50000);
  const plan = parsePlan(text);
  const validated = validatePlan(plan, { contract: { price }, ind: { atr: a.atr } }, ui);
  return { story: plan.story, reason: plan.reason, plan: validated };
}

async function replayMeta(symbol, tf, startTs, endTs) {
  return await loadHistory(symbol, tf, startTs, endTs);
}

module.exports = { renderMovie, replayMeta, loadHistory, STEP_MS };