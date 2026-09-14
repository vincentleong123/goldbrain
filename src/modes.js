"use strict";
// The 8 "modes" = 8 different lenses. Each returns a renderable verdict.
// Honest logic shared across modes: a weighted evidence blend -> read.
const { swings } = require("./patterns");
const { clamp } = require("./mta");

// ---------------------------------------------------------------- evidence
function blend(ctx) {
  const ev = [];
  if (ctx.struct.bullish) ev.push({ name: "Structure", dir: 1, w: 0.9 });
  else if (ctx.struct.bearish) ev.push({ name: "Structure", dir: -1, w: 0.9 });

  const emaS = ctx.ind.emaSpeed;
  if (emaS > 0.0003) ev.push({ name: "Trend (EMA20/50)", dir: 1, w: 1.0 });
  else if (emaS < -0.0003) ev.push({ name: "Trend (EMA20/50)", dir: -1, w: 1.0 });

  const r = ctx.ind.rsi;
  if (r > 55) ev.push({ name: "RSI momentum", dir: 1, w: 0.5 });
  else if (r < 45) ev.push({ name: "RSI momentum", dir: -1, w: 0.5 });

  if (ctx.ind.macdHist > 0) ev.push({ name: "MACD histogram", dir: 1, w: 0.6 });
  else if (ctx.ind.macdHist < 0) ev.push({ name: "MACD histogram", dir: -1, w: 0.6 });

  const pu = ctx.patt.pull; // 0..1 toward up
  ev.push({ name: "Candles", dir: pu > 0.55 ? 1 : pu < 0.45 ? -1 : 0, w: 0.6 });

  if (ctx.ai.verdict) {
    if (ctx.ai.verdict.dir === "up") ev.push({ name: "AI probability", dir: 1, w: ctx.ai.verdict.confidence });
    else if (ctx.ai.verdict.dir === "down") ev.push({ name: "AI probability", dir: -1, w: ctx.ai.verdict.confidence });
  }
  if (ctx.early.ignition === "up") ev.push({ name: "Early-move ignition", dir: 1, w: 0.7 });
  else if (ctx.early.ignition === "down") ev.push({ name: "Early-move ignition", dir: -1, w: 0.7 });

  let num = 0;
  let den = 0;
  for (const e of ev) {
    num += e.dir * e.w;
    den += e.w;
  }
  const score = den === 0 ? 0 : num / den; // -1..1
  const strongest = [...ev].sort((a, b) => b.w - a.w).slice(0, 3);
  return { ev, score, strongest, sentiment: score > 0.18 ? "bullish" : score < -0.18 ? "bearish" : "neutral" };
}

// ------------------------------------------------------------ trade plan
function tradePlan(ctx, ui) {
  const b = blend(ctx);
  const dir = b.score >= 0 ? "long" : "short";
  const price = ctx.price;
  const atr = ctx.ind.atr;
  const stopBuffer = clamp(atr * 0.8, price * 0.0004, atr * 1.5);
  let entry = price;
  let stop;
  let target;
  if (dir === "long") {
    stop = Math.min(ctx.sr.nearestSupport ? ctx.sr.nearestSupport - atr * 0.2 : price - stopBuffer, price - stopBuffer);
    const rrTarget = entry + 1.8 * atr;
    target = ctx.sr.nearestResistance && ctx.sr.nearestResistance > entry ? Math.max(ctx.sr.nearestResistance, rrTarget) : rrTarget;
  } else {
    stop = Math.max(ctx.sr.nearestResistance ? ctx.sr.nearestResistance + atr * 0.2 : price + stopBuffer, price + stopBuffer);
    const rrTarget = entry - 1.8 * atr;
    target = ctx.sr.nearestSupport && ctx.sr.nearestSupport < entry ? Math.min(ctx.sr.nearestSupport, rrTarget) : rrTarget;
  }
  const stopPts = Math.abs(entry - stop);
  const balance = ui.balance || 1000;
  const riskPct = clamp(ui.riskPct || 1, 0.05, 5) / 100;
  const riskDol = balance * riskPct;
  const lowLotFactor = 100; // 1.00 lot = 100oz => $100 per point
  const lots = clamp(riskDol / (stopPts * lowLotFactor), 0.01, 5);
  const notional = price * 100 * lots;
  const lev = ui.leverage || 500;
  const margin = notional / lev;
  const marginPct = balance > 0 ? (margin / balance) * 100 : 0;
  const rr = Math.abs(target - entry) / stopPts;
  return {
    bias: dir,
    entry: +entry.toFixed(2),
    stop: +stop.toFixed(2),
    target: +target.toFixed(2),
    stopPts: +stopPts.toFixed(2),
    rr: +rr.toFixed(2),
    lots: +lots.toFixed(2),
    riskDollars: +riskDol.toFixed(2),
    notional: +notional.toFixed(0),
    margin: +margin.toFixed(0),
    marginPct: +marginPct.toFixed(1),
    leverageUsed: lev,
    stopBufferNote: atr * 1.5 >= stopPts ? "stop inside safe ATR width - tighten target or reduce size." : "stop wider than ATR - healthy.",
  };
}

// injects current date-ish context
function levelsMap(ctx) {
  const m = {};
  if (ctx.sr.nearestSupport) m.nearestSupport = { price: ctx.sr.nearestSupport, label: "Support" };
  if (ctx.sr.nearestResistance) m.nearestResistance = { price: ctx.sr.nearestResistance, label: "Resistance" };
  if (ctx.early.rangeHigh) m.rangeHigh = { price: ctx.early.rangeHigh, label: "Momentum high" };
  if (ctx.early.rangeLow) m.rangeLow = { price: ctx.early.rangeLow, label: "Momentum low" };
  return m;
}

// ---------------------------------------------------------------- MODES
const modes = {
  // 1. EXPERT
  expert(ctx) {
    const b = blend(ctx);
    const r = ctx.ind.rsi;
    const parts = [];
    parts.push(`${ctx.struct.label}.`);
    parts.push(ctx.ind.emaSpeed > 0 ? "Short-term trend is up (EMA20>EMA50)." : ctx.ind.emaSpeed < 0 ? "Short-term trend is down (EMA20<EMA50)." : "EMAs flat - choppy.");
    parts.push(`RSI14 ${r.toFixed(0)} (${r > 70 ? "overbought" : r < 30 ? "oversold" : "mid-zone"}).`);
    parts.push(ctx.ind.macdHist >= 0 ? "MACD histogram positive - momentum supportive." : "MACD histogram negative - momentum fading.");
    const verdict = {
      bullish: "Overall: moderately BULLISH read - correlations align.",
      bearish: "Overall: moderately BEARISH read - correlations align.",
      neutral: "Overall: NEUTRAL/choppy - correlations conflict; stand aside or trade small.",
    }[b.sentiment];
    return {
      title: "Expert read",
      headline: verdict,
      sentiment: b.sentiment,
      summary: parts.join(" "),
      cards: [
        { label: "RSI(14)", value: r.toFixed(0), hint: r > 70 ? "overbought" : r < 30 ? "oversold" : "mid" },
        { label: "EMA 20/50", value: ctx.ind.emaSpeed > 0 ? "bullish" : ctx.ind.emaSpeed < 0 ? "bearish" : "flat", hint: "trend slope" },
        { label: "ATR", value: "$" + ctx.ind.atr.toFixed(2), hint: "vol clamp" },
        { label: "MACD hist", value: ctx.ind.macdHist >= 0 ? "+" : "–", hint: "momentum" },
        { label: "BB position", value: ctx.ind.bbPos <= 0.2 ? "lower band" : ctx.ind.bbPos >= 0.8 ? "upper band" : "mid", hint: "extremes = fade risk" },
        { label: "VWAP", value: ctx.price > ctx.ind.vwap ? "above" : "below", hint: "session anchor" },
      ],
      bullets: [
        { text: `Structure: ${ctx.struct.label}.`, tone: ctx.struct.bullish ? "up" : ctx.struct.bearish ? "down" : "side" },
        { text: `Strongest drivers: ${b.strongest.map((e) => e.name).join(", ")}.`, tone: "info" },
        { text: `Session: ${ctx.session.name} - ${ctx.session.note}`, tone: ctx.session.active ? "info" : "warn" },
        { text: ctx.early.note, tone: ctx.early.ignition === "up" ? "up" : ctx.early.ignition === "down" ? "down" : "side" },
      ],
      levels: levelsMap(ctx),
    };
  },

  // 2. EXPERT ADVISOR
  ea(ctx, ui) {
    const plan = tradePlan(ctx, ui);
    const anti = ctx.sr.nearestResistance && ctx.sr.nearestSupport ? "Watch both sides; invalidate below nearest support." : "";
    const pseudocode = [
      `// GoldPal EA v1 - auto ${plan.bias.toUpperCase()} template (MQL5)`,
      `#define RISK_PCT ${clamp(ui.riskPct || 1, 0.05, 5)}`,
      `watchdir=(${plan.bias.toUpperCase()});`,
      `if(M_new_bar && cond_${plan.bias}()){`,
      `  lots=CalcLots(RISK_PCT, Entry, Stop);`,
      `  Trade.PositionOpen(${plan.bias.toUpperCase()}, lots, ${plan.entry}, Stop=${plan.stop}, Target=${plan.target});`,
      `}`,
      `on_tick(): if(drawn<0 || bar_count>=MAX_HOLD || MA20_flip()) close_all();`,
    ].join("\n");
    return {
      title: "Expert Advisor",
      headline: `${plan.bias === "long" ? "BUY" : "SELL"} setup, sized to risk ${ui.riskPct || 1}% (${plan.lots} lots).`,
      sentiment: plan.bias === "long" ? "bullish" : "bearish",
      summary: `Generated a concrete entry/stop/target rule set you could code into an EA or follow manually. ${anti}`,
      cards: [
        { label: "Bias", value: plan.bias.toUpperCase(), hint: "direction" },
        { label: "Entry", value: plan.entry, hint: "current price" },
        { label: "Stop", value: plan.stop, hint: plan.stopPts + " pts" },
        { label: "Target", value: plan.target, hint: "RR " + plan.rr },
        { label: "Size", value: plan.lots + " lots", hint: "($" + plan.riskDollars + " risk)" },
        { label: "Margin use", value: plan.marginPct + "%", hint: "of $" + (ui.balance || 1000) },
      ],
      bullets: [
        { text: `Position sizing: risk ${plan.riskDollars} total ($ = balance x ${clamp(ui.riskPct || 1, 0.05, 5)}%).`, tone: "info" },
        { text: `Notional ${plan.notional.toLocaleString("en-US")} - ${plan.marginPct > 15 ? "HIGH margin use, reduce size." : "within budget."}`, tone: plan.marginPct > 15 ? "warn" : "up" },
        { text: plan.stopBufferNote, tone: "info" },
        { text: "Do NOT let a tiny stop turn into a 5x target - if RR < 1.2, skip.", tone: "warn" },
      ],
      code: pseudocode,
      levels: levelsMap(ctx),
    };
  },

  // 3. ENTREPRENEUR
  entrepreneur(ctx, ui) {
    const plan = tradePlan(ctx, ui);
    const balance = ui.balance || 1000;
    const dailyCap = balance * 0.03;
    const weeklyCap = balance * 0.06;
    const recWins = plan.rr >= 1.5 ? 1 : plan.rr >= 1.2 ? 2 : 3;
    return {
      title: "Entrepreneur / money-plan",
      headline: `Business plan: risk $${plan.riskDollars} per trade on a $${balance.toLocaleString("en-US")} account.`,
      sentiment: "info",
      summary: "Trade like a business, not a gambler: fixed % risk, hard daily/weekly loss caps, 1 position at a time, and never add margin after a loss.",
      cards: [
        { label: "Per-trade risk", value: "1 trade x $" + plan.riskDollars, hint: (ui.riskPct || 1) + "% of balance" },
        { label: "Daily loss cap", value: "$" + dailyCap.toFixed(0), hint: "3% => stop trading after" },
        { label: "Weekly cap", value: "$" + weeklyCap.toFixed(0), hint: "6% => step back" },
        { label: "Reached plan", value: recWins + " wins/mo", hint: "RR " + plan.rr },
        { label: "Margin reserved", value: plan.marginPct + "%/trade", hint: "watch margin level >200%" },
        { label: "Leverage", value: "1:" + plan.leverageUsed, hint: "usage is what matters" },
      ],
      bullets: [
        { text: `Position size calc: size = risk$ / (stop pts x $100/point) => ${plan.lots} lots.`, tone: "info" },
        { text: "Cap daily losses at 3% and WALK AWAY. Revenge trading is how accounts die.", tone: "warn" },
        { text: "Only compound size after 3 profitable weeks, never after 1 red day.", tone: "info" },
        { text: "Keep >50% of buying power in reserve at all times (cash is a position too).", tone: "info" },
      ],
      levels: levelsMap(ctx),
    };
  },

  // 4. AI TRADE
  aiTrade(ctx, ui) {
    const plan = tradePlan(ctx, ui);
    const v = ctx.ai.verdict;
    const h1 = ctx.ai.horizons[1];
    const acc = h1 && h1.ok ? h1.fwdAccuracy : null;
    const confPct = v ? Math.round(v.confidence * 100) : 0;
    const planNote = v && v.dir === "up"
      ? "AI prob supports LONG; enter small, must exit if model flips to <0.45."
      : v && v.dir === "down"
      ? "AI prob supports SHORT; enter small, must exit if model flips to >0.55."
      : "AI is undecided - this is a NO-TRADE signal, not a guess.";
    return {
      title: "AI Trade",
      headline: v ? `AI model says ${v.dir.toUpperCase()} (${confPct}% confidence).` : "AI model needs more data.",
      sentiment: v ? (v.dir === "up" ? "bullish" : v.dir === "down" ? "bearish" : "neutral") : "neutral",
      summary: `Probability of next-bar up-move: ${h1 && h1.ok ? (h1.probUp * 100).toFixed(1) : "n/a"}%. The model retrained on the latest ${h1 ? h1.samples : 0} bars just now. ${planNote}`,
      cards: [
        { label: "P(up) next bar", value: h1 && h1.ok ? (h1.probUp * 100).toFixed(1) + "%" : "–", hint: "model odds" },
        { label: "Model honesty", value: acc === null ? "–" : Math.round(acc * 100) + "%", hint: "fwd-hit-rate on held-out data" },
        { label: "Confidence", value: confPct + "%", hint: "vs 50% coin flip" },
        { label: "Retrained", value: h1 ? h1.samples + " bars" : "–", hint: "on this refresh" },
      ],
      bullets: [
        { text: v && v.dir === "side" ? "Score near 50% = model is guessing. Walking away IS a decision." : `Direction read: ${v ? v.dir : "n/a"}.`, tone: v && v.dir === "side" ? "warn" : v && v.dir === "up" ? "up" : "down" },
        { text: `Honest check: on recent unseen bars the model hit ${acc === null ? "n/a" : Math.round(acc * 100) + "%"}. If that's near 50%, treat its calls as noise.`, tone: "info" },
        { text: "This retrains constantly ✓ - every refresh uses the newest data.", tone: "info" },
        { text: "If model prob says up but structure says down - DON'T trade (conflict = no edge).", tone: "warn" },
      ],
      levels: levelsMap(ctx),
    };
  },

  // 5. AI TRADER
  aiTrader(ctx, ui) {
    const v = ctx.ai.verdict || { dir: "side", probUp: 0.5, confidence: 0 };
    const b = blend(ctx);
    const agreement = b.score > 0 && v.probUp > 0.52 ? "yes" : b.score < 0 && v.probUp < 0.48 ? "yes" : v.probUp >= 0.52 || v.probUp <= 0.48 ? "partial" : "no";
    const h3 = ctx.ai.horizons[3], h6 = ctx.ai.horizons[6];
    const scenario = agreement === "yes" ? "AI and structure agree - highest-quality setup tier." : agreement === "partial" ? "AI and structure partially agree - trade smaller or wait." : "AI and structure CONFLICT - stay flat, this is a skip.";
    return {
      title: "AI Trader",
      headline: `${agreement === "yes" ? "Setup validated." : agreement === "partial" ? "Mixed signals." : "Conflict - stand aside."} ${scenario}`,
      sentiment: agreement === "yes" ? (v.dir === "up" ? "bullish" : "bearish") : "neutral",
      summary: `The model has a ${(v.probUp * 100).toFixed(0)}% up-bias against a structural read of ${ctx.struct.label.toLowerCase()}. My job is to tell you when it's safe to act - and today it's: ${agreement === "yes" ? "GO (manage risk)" : agreement === "partial" ? "CAUTION (half size)" : "STAY FLAT"}.`,
      cards: [
        { label: "AI prob (1 bar)", value: (v.probUp * 100).toFixed(0) + "%", hint: "vs 50%" },
        { label: "AI prob (3 bar)", value: h3 && h3.ok ? (h3.probUp * 100).toFixed(0) + "%" : "–", hint: "pulls back faster" },
        { label: "AI prob (6 bar)", value: h6 && h6.ok ? (h6.probUp * 100).toFixed(0) + "%" : "–", hint: "trend answer" },
        { label: "Agreement", value: agreement.toUpperCase(), hint: "AI vs structure" },
      ],
      bullets: [
        { text: scenario, tone: agreement === "yes" ? "up" : agreement === "partial" ? "warn" : "down" },
        { text: `If you act: ${plan_(ctx, ui)}`, tone: "info" },
        { text: "Re-read on next refresh - the model retrained itself already.", tone: "info" },
      ],
      levels: levelsMap(ctx),
    };
  },

  // 6. AI TRADER PSYCHIC - honestly framed
  psychic(ctx) {
    const h1 = ctx.ai.horizons[1], h3 = ctx.ai.horizons[3], h6 = ctx.ai.horizons[6];
    const f = (x) => (x && x.ok ? (x.probUp * 100).toFixed(0) + "%" : "–");
    const acc = h1 && h1.ok ? Math.round(h1.fwdAccuracy * 100) : null;
    const window = ctx.tf === "M1" ? "minutes" : ctx.tf === "H1" ? "hours" : "bars";
    return {
      title: "AI Psychic forecast (probabilities, not prophecies)",
      headline: `Confidence band: next 1/3/6 bars ${f(h1)} / ${f(h3)} / ${f(h6)} (up).`,
      sentiment: h1 && h1.probUp > 0.55 ? "bullish" : h1 && h1.probUp < 0.45 ? "bearish" : "neutral",
      summary: `There is no crystal ball - this is a calibrated probability band over the next few ${window}. It retrains constantly and reports its own accuracy, which is the honest version of "psychic".`,
      cards: [
        { label: "1-bar up-odds", value: f(h1), hint: "immediate" },
        { label: "3-bar up-odds", value: f(h3), hint: "short" },
        { label: "6-bar up-odds", value: f(h6), hint: "swing" },
        { label: "Self-reported accuracy", value: acc === null ? "–" : acc + "%", hint: "on last held-out bars" },
      ],
      bullets: [
        { text: `What would change my mind: a close ${h1 && h1.probUp > 0.5 ? "below" : "above"} ${ctx.sr.nearestSupport || ctx.sr.nearestResistance || "the key level"} shifts the odds.`, tone: "info" },
        { text: `Confidence decays fast - by bar ${ctx.tf === "M1" ? "8-12 minutes" : "next day"} these odds are close to meaningless.`, tone: "warn" },
        { text: acc !== null && acc < 55 ? "Honest note: recent forward accuracy is near coin-flip level - treat as probability, NOT destiny." : "Recent forward accuracy is usable - still manage risk properly.", tone: acc !== null && acc < 55 ? "warn" : "info" },
      ],
      levels: levelsMap(ctx),
    };
  },

  // 7. AI PATTERN RECOGNITION
  pattern(ctx) {
    const p = ctx.patt;
    const recent = p.recent;
    const bestName = (x) => (x ? x.name.replace(/_/g, " ") : "none");
    const dbl = detectDouble(ctx);
    const bullets = [];
    bullets.push({ text: `Structure: ${ctx.struct.label}.`, tone: ctx.struct.bullish ? "up" : ctx.struct.bearish ? "down" : "side" });
    if (recent.length) {
      bullets.push({ text: `Recent candle patterns: ${recent.filter((x) => x.dir !== "side").map((x) => x.name.replace(/_/g, " ")).slice(0, 5).join(", ") || "none decisive"}.`, tone: "info" });
    }
    bullets.push({ text: `Strong bearish form: ${bestName(p.strongestDown)}. Strong bullish form: ${bestName(p.strongestUp)}.`, tone: p.strongestUp && p.strongestDown && p.strongestUp.strength > p.strongestDown.strength ? "up" : "down" });
    if (dbl.name) bullets.push({ text: `High-level shape: ${dbl.name} ${dbl.probability > 0.6 ? "(probable)" : "(forming)"} near ${dbl.price}.`, tone: dbl.name.includes("Double top") ? "down" : "up" });
    bullets.push({ text: ctx.early.note, tone: ctx.early.ignition === "up" ? "up" : ctx.early.ignition === "down" ? "down" : "side" });
    if (ctx.tf !== "D1") bullets.push({ text: `Check the higher timeframe alignment before acting (e.g., if ${ctx.tf} says up but D1 says down, it's a counter-trend trade).`, tone: "warn" });
    return {
      title: "AI Pattern recognition",
      headline: `Pattern scan: ${recent.length ? recent.filter((x) => x.dir !== "side").length + " setup" + (recent.filter((x) => x.dir !== "side").length === 1 ? "" : "s") + " this window" : "no clean setups"} - pull ${(p.pull * 100).toFixed(0)}% toward up.`,
      sentiment: p.pull > 0.55 ? "bullish" : p.pull < 0.45 ? "bearish" : "neutral",
      summary: `Scanned candles for single/double-bar patterns, swing structure, and support/resistance clustering. ${dbl.name ? "Also flagged " + dbl.name + "." : ""}`,
      cards: [
        { label: "Bullish forms", value: recent.filter((x) => x.dir === "up").length, hint: "counts" },
        { label: "Bearish forms", value: recent.filter((x) => x.dir === "down").length, hint: "counts" },
        { label: "Nearest support", value: ctx.sr.nearestSupport !== null ? ctx.sr.nearestSupport : "–", hint: "watch hold" },
        { label: "Nearest resistance", value: ctx.sr.nearestResistance !== null ? ctx.sr.nearestResistance : "–", hint: "watch break" },
      ],
      bullets,
      levels: levelsMap(ctx),
    };
  },

  // 9. PSYCHOLOGY COUNTER-TRADE (opposite of retail behavior)
  counter(ctx, ui) {
    const st = ctx.stage;
    if (!st) {
      return { title: "Psych counter", headline: "Not enough data for stage tracking yet.", sentiment: "info", summary: "Needs ~70 bars.", cards: [] };
    }
    const side = st.bias === "long" ? "LONG back up" : "SHORT back down";
    const flushDir = st.bias === "long" ? "DOWN" : "UP";
    const b = blend(ctx);
    const deepEnough = st.depthAtr >= 0.55;
    const notKnife = st.depthAtr < 2.6;
    const agree = (b.score > 0 && st.bias === "long") || (b.score < 0 && st.bias === "short");
    const action = st.entryReady
      ? "TRADE NOW: enter counter (fade the flush) with a hard stop beyond the extreme."
      : deepEnough && !notKnife
      ? "This is a violent impulse flush - DO NOT catch the knife. Wait for absorption."
      : !deepEnough
      ? "No setup - price hasn't flushed to a counter-stage yet."
      : "Flush deep but no exhaustion candle yet - standby (alerts set).";
    const patienceNote = !agree ? "NOTE: overall indicator blend conflicts with the counter bias - either skip or size at half." : "";
    return {
      title: "Psych counter (opposite of the crowd)",
      headline: `${st.entryReady ? "LIVE COUNTER ENTRY SIGNAL" : "Monitoring retail-pain stages…"} retail now ${st.bias === "long" ? "underwater" : "in profit-flush"} ~${st.depthAtr.toFixed(2)} ATR (stage ${st.stage >= 0 ? st.stagePct.toFixed(2) : "clean"}).`,
      sentiment: st.entryReady ? (st.bias === "long" ? "bullish" : "bearish") : deepEnough ? "warning" : "neutral",
      summary: `Their psychology: traders hold losers at each -$ stage hoping for breakeven, then finally capitulate - that capitulation is where the counter-trade buys/sells back toward the anchor. ${patienceNote}`,
      cards: [
        { label: "Pain depth", value: st.depthAtr.toFixed(2) + " ATR", hint: "$" + st.painUsd0_1 + " / 0.1 lot" },
        { label: "Stage", value: st.stage >= 0 ? ("-" + (st.stagePct * 100).toFixed(0) + "% ATR") : "clean", hint: "psych level" },
        { label: "Counter bias", value: st.bias.toUpperCase(), hint: flushDir + " flush" },
        { label: "Anchor", value: st.anchor, hint: "retail breakeven zone" },
        { label: "Exhaustion", value: st.exhaustion ? "YES" : "no", hint: "pin/engulf + RSI" + st.rsi },
        { label: "Entry rdy", value: st.entryReady ? "YES" : "no", hint: notKnife ? "safe depth" : "KNIFE - skip" },
      ],
      bullets: [
        { text: action, tone: st.entryReady ? "up" : deepEnough && !notKnife ? "warn" : "side" },
        { text: `The opposite-of-holding rule: if it re-enters this trade and the flush resumes past stop, we CUT IMMEDIATELY (hard stop ${st.atr ? "0.6-1 ATR" : "as EA config"}). We never hold a loser through more stages.`, tone: "warn" },
        { text: `Winner management: take half at the anchor (${st.anchor}), then LET THE RUNNER RUN with a trailing stop. Opposite of 'cut winners early'.`, tone: "info" },
        { text: `History says recovery-to-anchor within 15 bars at deep stages: see Backtest → Psych Counter for the real odds on this data.`, tone: "info" },
      ],
      levels: st.anchor ? { anchor: { price: st.anchor, label: "Anchor (TP1)" } } : {},
      warnings: [
        agree ? "" : "Indicator blend conflicts with counter bias - treat as a 50%-size setup, not a conviction trade.",
        st.depthAtr >= 1.8 ? "Very deep flush on this timeframe - make sure you're not in a genuine news-driven regime." : "",
      ].filter(Boolean),
    };
  },

  // 8. AI MAKE MONEY HELPFUL
  makeMoney(ctx, ui) {
    const b = blend(ctx);
    const tradeable = Math.abs(b.score) > 0.18 && ctx.early.ignition !== "none";
    const acc = ctx.ai.horizons[1] && ctx.ai.horizons[1].ok ? ctx.ai.horizons[1].fwdAccuracy : null;
    const warnings = [];
    if (!tradeable) warnings.push("Current blend is neutral/choppy - the most profitable trade today may be NO trade.");
    warnings.push("XAUUSD moves hardest during London/NY overlap - entries outside those windows are lowest-quality.");
    if (ctx.source === "demo") warnings.push("Using DEMO data - connect live data (MT5 bridge or internet) or this says nothing real.");
    if (acc !== null && acc < 55) warnings.push("Model hit-rate near coin-flip right now - rely on your stop, not the signal.");
    const tips = tradeable
      ? `Today: trade ${b.score > 0 ? "long-biased" : "short-biased"} setups only, risk fixed ${clamp(ui.riskPct || 1, 0.05, 5)}%, take profit at nearest S/R, and exit by ${ctx.session.name} close.`
      : `Today: sit on your hands. ${tradeableFalseNote(ctx)} Set alerts at ${ctx.sr.nearestSupport || "support"} and ${ctx.sr.nearestResistance || "resistance"} instead.`;
    return {
      title: "AI money coach",
      headline: tradeable ? "Tradeable regime - execute the plan." : "Not a good regime - protecting capital IS profit.",
      sentiment: tradeable ? "up" : "warn",
      summary: tips,
      cards: [
        { label: "Regime", value: tradeable ? "TRADE" : "STAND ASIDE", hint: "blend:" + b.score.toFixed(2) },
        { label: "Risk per trade", value: "$" + (ui.balance || 1000) * clamp(ui.riskPct || 1, 0.05, 5) / 100 + "", hint: "1-2% sweet spot" },
        { label: "Session", value: ctx.session.name, hint: ctx.session.active ? "lively" : "dead" },
        { label: "Data source", value: ctx.label, hint: ctx.source },
      ],
      bullets: [
        { text: tips, tone: tradeable ? "up" : "warn" },
        { text: "Golden rules: fixed stops, no averaging down, no martingale, close losers fast, let winners run.", tone: "info" },
        { text: "On XM: bonus terms can trap withdrawals - only ever trade YOUR OWN money, no bonuses, no account managers.", tone: "warn" },
        { text: "Leverage 1:500+ is a weapon aimed at you. Cap effective leverage to ~10-20x via position size.", tone: "warn" },
        { text: "After 3 losing days in a row: stop for a week, review, retrain yourself before touching gold again.", tone: "info" },
      ],
      warnings,
      levels: levelsMap(ctx),
    };
  },
};

function plan_(ctx, ui) {
  const plan = tradePlan(ctx, ui);
  return `entry ${plan.entry}, stop ${plan.stop}, target ${plan.target}, size ${plan.lots} lots, risk $${plan.riskDollars}, RR ${plan.rr}.`;
}

function tradeableFalseNote(ctx) {
  return ctx.early.ignition === "none" ? "" : "Early-move is firing but overall read is mixed.";
}

// rough double-top / double-bottom / triangle detector on recent swings
function detectDouble(ctx) {
  const pv = swings(ctx.candles, 2).slice(-6);
  const atr = ctx.ind.atr;
  const tol = Math.max(atr * 1.1, ctx.price * 0.0006);
  for (let i = pv.length - 1; i >= 2 && i >= pv.length - 4; i--) {
    const a = pv[i];
    // find symmetric partner
    for (let k = i - 2; k >= Math.max(0, i - 5); k--) {
      if (a.type === pv[k].type && Math.abs(a.p - pv[k].p) < tol) {
        const mid = pv.slice(k + 1, i);
        if (mid.length) {
          if (a.type === "H") return { name: "Double top (M)", probability: 0.6 + mid.length * 0.06, price: a.p, w1: pv[k].p, w2: a.p };
          return { name: "Double bottom (W)", probability: 0.6 + mid.length * 0.06, price: a.p, w1: pv[k].p, w2: a.p };
        }
      }
      if (Math.abs(a.p - pv[k].p) > tol * 4) break;
    }
  }
  return { name: null };
}

module.exports = { modes, blend, tradePlan, levelsMap };