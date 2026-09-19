"use strict";
// The six operating personas: expert, psychicPower, superman, thinkTank,
// keepGoing, jiaYou (加油). Mounted onto the shared modes object so the
// dashboard can render them like any other mode.
const { modes, blend, tradePlan, levelsMap } = require("./modes");
const { clamp } = require("./mta");

const money0 = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(Math.round(v));
const pct0 = (v) => Math.round(v * 100) + "%";

// ------------------------------------------------------------- PSYCHIC POWER
modes.psychicPower = function psychicPower(ctx) {
  const h1 = ctx.ai.horizons[1];
  const h3 = ctx.ai.horizons[3];
  const h6 = ctx.ai.horizons[6];
  const f = (x) => (x && x.ok ? (x.probUp * 100).toFixed(0) + "%" : "-");
  const st = ctx.stage;
  const acc = h1 && h1.ok ? Math.round(h1.fwdAccuracy * 100) : null;
  const unit = ctx.tf === "M1" ? "minutes" : ctx.tf === "H1" ? "hours" : "bars";
  const oddsLine = st
    ? `Counter lens: price is ${st.depthAtr.toFixed(2)} ATR into ${st.bias === "long" ? "a dip (longs losing)" : "a rip (shorts losing)"} - pain stage ${st.stage >= 0 ? st.stagePct.toFixed(2) : "clean"}${st.exhaustion ? ", exhaustion candle SEEN" : ""}.`
    : "Stage monitor needs more bars.";
  return {
    title: "Psychic power forecast (probability, not prophecy)",
    headline: `1/3/6-bar up-odds: ${f(h1)} / ${f(h3)} / ${f(h6)}. ` + (
      h1 && h1.probUp > 0.55 ? "Bullish pulse." : h1 && h1.probUp < 0.45 ? "Bearish pulse." : "Coin-flip zone - the 'psychic' is honest here."
    ),
    sentiment: h1 && h1.probUp > 0.55 ? "bullish" : h1 && h1.probUp < 0.45 ? "bearish" : "neutral",
    summary: `${oddsLine} Confidence decays fast past a few ${unit}. Self-reported accuracy on unseen bars: ${acc === null ? "n/a" : acc + "%"}.`,
    cards: [
      { label: "1-bar up-odds", value: f(h1), hint: "immediate" },
      { label: "3-bar up-odds", value: f(h3), hint: "short" },
      { label: "6-bar up-odds", value: f(h6), hint: "swing" },
      { label: "Forward accuracy", value: acc === null ? "-" : acc + "%", hint: "self-report" },
      { label: "Pain stage", value: st ? st.stagePct.toFixed(2) + " ATR" : "-", hint: st && st.exhaustion ? "exhaustion near" : "no flush" },
    ],
    bullets: [
      { text: `If forward accuracy sits near 50%, treat every call as a coin toss and rely on the bracket (stop/TP), never the 'vision'.`, tone: "warn" },
      { text: `Give-me-a-reason line: a close ${ctx.price.toFixed(2)} ${h1 && h1.probUp > 0.5 ? "below" : "above"} ${ctx.sr.nearestSupport || ctx.sr.nearestResistance || "the key level"} resets these odds.`, tone: "info" },
      { text: "It retrains every refresh - the 'power' is that it updates the present, not that it knows the future.", tone: "info" },
    ],
    levels: levelsMap(ctx),
  };
};

// ------------------------------------------------------------- SUPERMAN
modes.superman = function superman(ctx, ui) {
  const st = ctx.stage;
  const ready = !!(st && st.entryReady);
  const plan = tradePlan(ctx, ui);
  const b = blend(ctx);
  const agree = !!st && ((b.score > 0 && st.bias === "long") || (b.score < 0 && st.bias === "short"));
  if (ready) {
    return {
      title: "Superman execution mode",
      headline: `Superman has a MISSION: ${st.bias === "long" ? "BUY the dip" : "SELL the rip"} right now.`,
      sentiment: st.bias === "long" ? "bullish" : "bearish",
      summary: `Flush depth ${st.depthAtr.toFixed(2)} ATR, exhaustion candle present, hard stop pre-planned. Execute, bracket, then monitor only.`,
      cards: [
        { label: "Action", value: st.bias === "long" ? "BUY" : "SELL", hint: "counter-flush" },
        { label: "Entry", value: st.price, hint: "current" },
        { label: "Stop", value: plan.stop, hint: "hard, non-negotiable" },
        { label: "Target", value: plan.target, hint: "RR " + plan.rr },
        { label: "Size", value: plan.lots + " lots", hint: "$" + plan.riskDollars + " risk" },
        { label: "Blend check", value: agree ? "ALIGNED" : "CONFLICT", hint: agree ? "full size" : "halve size" },
      ],
      bullets: [
        { text: `If it hits stop: cut immediately, zero hesitation. Superman does not hold losers to 'maybe'.`, tone: "warn" },
        { text: `If it works: half out at anchor ${st.anchor}, runner trails. That is 'maximize positives'.`, tone: "info" },
        { text: agree ? "Indicators align - conviction high." : "Blend disagrees with counter bias - SUP disciplines to half size. Discipline beats heroics.", tone: agree ? "up" : "warn" },
        { text: "Time-capped in-market (TimeExit) - holding and praying is banned.", tone: "info" },
      ],
      levels: {
        anchor: { price: st.anchor, label: "Anchor TP1" },
        stop: { price: plan.stop, label: "Hard stop" },
        target: { price: plan.target, label: "Target" },
      },
    };
  }
  const nextLine = st
    ? st.depthAtr < 0.55
      ? `Price hasn't flushed yet (${st.depthAtr.toFixed(2)} ATR from anchor). Superman WAITS - waiting is winning.`
      : st.depthAtr >= 2.6
      ? "This is a KNIFE flush. Superman does NOT catch knives."
      : "Flush deep but no exhaustion candle yet - standing by for absorption/pinbar."
    : "Stage monitor warming up.";
  return {
    title: "Superman execution mode",
    headline: "Superman is patient: no forced heroics today.",
    sentiment: "info",
    summary: `${nextLine} When conditions align the plan appears here automatically. Until then: flat = full strength.`,
    cards: [
      { label: "Counter setup", value: st ? (st.entryReady ? "READY" : "waiting") : "boot", hint: st ? st.rule : "" },
      { label: "Pain depth", value: st ? st.depthAtr.toFixed(2) + " ATR" : "-", hint: "needs >=0.55" },
      { label: "Blend", value: (b.score * 100).toFixed(0), hint: "read score" },
      { label: "Best backtest", value: ctx.btSummary.best ? ctx.btSummary.best.name : "-", hint: ctx.btSummary.best ? "+$" + ctx.btSummary.best.netUsd : "" },
    ],
    bullets: [
      { text: "No setup ready = strongest position is cash.", tone: "info" },
      { text: "Missions only fire when Psych-Counter + AI + structure agree. No mission = no trade.", tone: "info" },
      { text: "Every mission is sized to fixed risk% and bracketed; Superman is never trapped holding.", tone: "info" },
    ],
  };
};

// ------------------------------------------------------------- THINK TANK
modes.thinkTank = function thinkTank(ctx, ui) {
  const pUp = ctx.ai.verdict ? ctx.ai.verdict.probUp : 0.5;
  const b = blend(ctx);
  const s = ctx.sr;
  const srClose = s.nearestSupport || +(ctx.price - ctx.ind.atr * 1.2).toFixed(2);
  const rsClose = s.nearestResistance || +(ctx.price + ctx.ind.atr * 1.2).toFixed(2);
  const baseUp = clamp(pUp + b.score * 0.15, 0.05, 0.95);
  const bull = clamp(baseUp + 0.15, 0.1, 0.95);
  const bear = clamp(baseUp - 0.15, 0.05, 0.9);
  const plan = tradePlan(ctx, ui);
  const st = ctx.stage;
  const counterNote = st && st.entryReady
    ? `Counter play LIVE: ${st.bias} into flush (Superman mode has the execution plan).`
    : st
    ? `Counter plays on standby (flush ${st.depthAtr.toFixed(2)} ATR${st.exhaustion ? ", exhaustion near" : ""}).`
    : "Counter monitor warming.";
  return {
    title: "Think tank scenario room",
    headline: `Scenario odds: bull ${(bull * 100).toFixed(0)}% / base ${(baseUp * 100).toFixed(0)}% / bear ${(bear * 100).toFixed(0)}%`,
    sentiment: bull >= 0.55 ? "bullish" : bear >= 0.55 ? "bearish" : "neutral",
    summary: `Both sides argued on purpose. ${counterNote}`,
    cards: [
      { label: "Bull trigger", value: "+" + rsClose, hint: "break & hold" },
      { label: "Bear trigger", value: "-" + srClose, hint: "break & hold" },
      { label: "Structure", value: ctx.struct.label, hint: "" },
      { label: "AI / blend", value: pct0(pUp) + " / " + (b.score * 100).toFixed(0), hint: "two brains" },
    ],
    bullets: [
      { text: `BULL: clearing ${rsClose} fuels retail FOMO - trend-follow longs can run toward a measured move.`, tone: "up" },
      { text: `BEAR: losing ${srClose} dumps the staged-loss crowd's stops - flush THEN counter near the deep stage, not into it.`, tone: "down" },
      { text: `BASE: chop between ${srClose} and ${rsClose} - tiny size, this is the no-edge zone.`, tone: "side" },
      { text: "Kill-argument check: 'what would falsify this thesis?' Ask it for every direction.", tone: "info" },
      { text: `If you must act in any scenario, bracket it: ${plan.entry} / ${plan.stop} / ${plan.target} (RR ${plan.rr}).`, tone: "info" },
    ],
    levels: levelsMap(ctx),
    warnings: ["Scenarios are structured thinking, not endorsements. Backtest each one on this data before trading it."],
  };
};

// ------------------------------------------------------------- KEEP GOING
modes.keepGoing = function keepGoing(ctx, ui) {
  const bt = ctx.btSummary.psych;
  const best = ctx.btSummary.best;
  const st = ctx.stage;
  let edgeLine;
  if (!bt || !bt.trades) edgeLine = "No psych-counter trades yet on this window - let the engine accumulate history.";
  else if (bt.netUsd > 0) edgeLine = `Keep going: the counter book is net +$${bt.netUsd} here (${bt.trades} trades, WR ${pct0(bt.winRate)}). Process is the point.`;
  else if (bt.netUsd < 0) edgeLine = `Keep going means keep the DISCIPLINE, not the losing trades: counter book net ${money0(bt.netUsd)} this window - that's data, so we shrink size and change pocket, never inflate lots.`;
  else edgeLine = "Flat window - keep watching, keep recording.";
  const bestSide = bt && bt.sideStats && bt.sideStats.length
    ? [...bt.sideStats].sort((a, b) => b.net - a.net)[0]
    : null;
  return {
    title: "Keep going engine",
    headline: ctx.ai.verdict && ctx.ai.verdict.dir === "side" ? "Nothing to force. Keep going on the routine." : "Keep going - one staged decision at a time.",
    sentiment: "info",
    summary: edgeLine,
    cards: [
      { label: "Counter net", value: bt ? money0(bt.netUsd) : "-", hint: bt ? bt.trades + " trades" : "warming" },
      { label: "Counter WR", value: bt ? pct0(bt.winRate) : "-", hint: "win rate" },
      { label: "Best engine", value: best ? best.name : "-", hint: best ? "+$" + best.netUsd + " " + best.trades + "tr" : "" },
      { label: "Current stage", value: st ? st.stagePct.toFixed(2) + " ATR" : "-", hint: st && st.exhaustion ? "exhaustion near" : "monitoring" },
    ],
    bullets: [
      ...(bestSide && bestSide.net > 0
        ? [{ text: `Keep-watered side on history: ${bestSide.side.toUpperCase()}s net +$${bestSide.net} (WR ${pct0(bestSide.winRate)}). Lean size there, shrink elsewhere.`, tone: "up" }]
        : []),
      { text: "Semistop: after 3 red days, halt new ideas for a week. Persistence is a schedule, not a gambler's loop.", tone: "info" },
      { text: "Journal every trade (entry, stage, exit, feeling) - the journal is your compounding edge.", tone: "info" },
      { text: `Today ${ctx.session.name}: ${ctx.session.active ? "healthy action hours - run the setup list." : "dead liquidity - setup-only, no entries."}`, tone: ctx.session.active ? "up" : "warn" },
      { text: best ? `Strongest engine on history: ${best.name} (+$${best.netUsd}). Put attention there; treat novelty as smaller risk.` : "More history = more signal. Grow the bars/window and let the engine keep learning.", tone: "info" },
    ],
    warnings: ["'Keep going' never means 'keep ignoring the stop'. Progress = protected capital."],
  };
};

// ------------------------------------------------------------- JIA YOU (加油!)
modes.jiaYou = function jiaYou(ctx, ui) {
  const b = blend(ctx);
  const st = ctx.stage;
  const tradeNow = !!(st && st.entryReady);
  const plan = tradePlan(ctx, ui);
  const lines = [];
  if (tradeNow) lines.push(`Jia you! Counter trade is LIVE - entry ${st.price}, stop ${plan.stop}, target ${plan.target}. Execute it with a full heart.`);
  if (ctx.ai.verdict) lines.push(`AI is ${(ctx.ai.verdict.confidence * 100).toFixed(0)}% confident on ${ctx.ai.verdict.dir} - use it as one vote, not the verdict.`);
  lines.push(st ? `Pain stage ${st.depthAtr.toFixed(2)} ATR: ${st.exhaustion ? "exhaustion smell in the air - courage for the counter." : "stay patient - the flush that breaks everyone is the one we profit from."}` : "Stage monitor warming up - give it a few bars.");
  lines.push("One trade at a time. Jia you - you run the first, the engine runs the math.");
  return {
    title: "Jia you! coach",
    headline: tradeNow ? "JIA YOU! 加油! The setup is IN FRONT OF YOU - trust your bracket, not your jitters." : "JIA YOU! 加油! Stay sharp - the market will offer its shot.",
    sentiment: tradeNow ? "up" : "info",
    summary: "Short, warm, honest: the market owes you nothing, but your process owes you a chance every single day. Jia you!",
    cards: [
      { label: "Today's pulse", value: tradeNow ? "LIVE SETUP" : "monitor", hint: b.sentiment },
      { label: "Best engine", value: ctx.btSummary.best ? ctx.btSummary.best.name : "-", hint: ctx.btSummary.best ? "+$" + ctx.btSummary.best.netUsd : "" },
      { label: "Session", value: ctx.session.name, hint: ctx.session.active ? "in your window" : "avoid" },
      { label: "20-bar stretch", value: Math.max(1, Math.round((ctx.ind.hi20 - ctx.ind.lo20) / ctx.ind.atr)) + "x ATR", hint: "volatility" },
    ],
    bullets: [
      { text: lines[0], tone: tradeNow ? "up" : "info" },
      { text: lines[1], tone: "info" },
      { text: lines[2], tone: "side" },
      { text: lines[3], tone: "info" },
      { text: "Jia you is momentum you give YOURSELF: fixed risk 1-2%, place the bracket before you are scared, and never add fuel to a losing fire.", tone: "warn" },
    ],
  };
};

// ------------------------------------------------------------- ORACLE (FAST MONEY TRADER)
// Reads the probability oracle + retail-pain stages and trades FAST: in and out
// before the crowd wakes, tight stop, quick target, active-session-only, and it
// KNOWS where stop-loss hunts live (the anchor = the crowd's breakeven).
modes.oracle = function oracle(ctx, ui) {
  const h1 = ctx.ai.horizons[1], h3 = ctx.ai.horizons[3], h6 = ctx.ai.horizons[6];
  const f = (x) => (x && x.ok ? (x.probUp * 100).toFixed(0) + "%" : "-");
  const acc = h1 && h1.ok ? Math.round(h1.fwdAccuracy * 100) : null;
  const b = blend(ctx);
  const st = ctx.stage;
  const atr = ctx.ind.atr || 0.0001;
  const price = ctx.price;
  const sess = ctx.session;

  const active = !!sess.active;
  const h1Up = h1 && h1.ok ? h1.probUp : 0.5;
  const oracleBias = h1Up > 0.55 ? "long" : h1Up < 0.45 ? "short" : "side";
  const blendBias = b.score > 0.12 ? "long" : b.score < -0.12 ? "short" : "side";
  const fastSide = oracleBias === blendBias ? oracleBias : blendBias !== "side" ? blendBias : oracleBias;

  // fast-money bracket: tight stop, quick target, no holding
  function fastPlan(side) {
    const stopDist = clamp(atr * 0.6, price * 0.00035, atr * 1.0);
    const stop = side === "long" ? price - stopDist : price + stopDist;
    const tgtDist = atr * 1.0;
    const target = side === "long"
      ? Math.min(ctx.sr.nearestResistance || Infinity, price + tgtDist)
      : Math.max(ctx.sr.nearestSupport || -Infinity, price - tgtDist);
    const rr = Math.abs(target - price) / stopDist;
    const riskDol = (ui.balance || 1000) * clamp(ui.riskPct || 1, 0.05, 5) / 100;
    const lots = clamp(riskDol / (stopDist * 100), 0.01, 5);
    return { side, entry: price, stop: +stop.toFixed(2), target: +target.toFixed(2), stopPts: +stopDist.toFixed(2), rr: +rr.toFixed(2), lots: +lots.toFixed(2), riskDol: +riskDol.toFixed(2) };
  }

  // stop-hunt read: the anchor IS where the crowd's stop-losses cluster
  let huntNote;
  if (st && st.anchor) {
    huntNote = st.bias === "long"
      ? `Stop-hunt map: the crowd is underwater below the anchor ${st.anchor.toFixed(2)} - their stops cluster just under it, which is why it "grabs the money and stops" right there.`
      : `Stop-hunt map: the crowd is underwater above the anchor ${st.anchor.toFixed(2)} - their stops cluster just over it, that's the grab point.`;
  } else {
    huntNote = "Stop-hunt map: no deep retail pain right now - hunters have no obvious target, which makes fast chasing dangerous.";
  }

  const counterFire = !!(st && st.entryReady);
  const fire = active && (h1Up > 0.55 || h1Up < 0.45 || counterFire || Math.abs(b.score) > 0.18);
  if (!fire) {
    return {
      title: "Oracle - fast money trader",
      headline: "Oracle says: hold your fire. Fast money goes nowhere today.",
      sentiment: "info",
      summary: `The oracle reads ${h1Up >= 0.55 ? "up-pulse" : h1Up <= 0.45 ? "down-pulse" : "a coin-flip"} with ${h1 && h1.fwdAccuracy ? Math.round(h1.fwdAccuracy * 100) : "low"}% recent honesty${active ? " in an ACTIVE session" : ", but the session is dead"}. Blink, don't swing. ${huntNote}`,
      cards: [
        { label: "Oracle P(up) 1/3/6", value: `${f(h1)} / ${f(h3)} / ${f(h6)}`, hint: "fast / quick / swing" },
        { label: "Session", value: sess.name, hint: active ? "active = fast-friendly" : "dead - no fast money" },
        { label: "Blend", value: (b.score * 100).toFixed(0), hint: b.sentiment },
        { label: "Pain stage", value: st ? st.depthAtr.toFixed(2) + " ATR" : "-", hint: st && st.exhaustion ? "exhaustion near" : "no flush" },
        { label: "Volatility", value: Math.max(1, Math.round((ctx.ind.hi20 - ctx.ind.lo20) / atr)) + "x ATR/20b", hint: "range clamp" },
      ],
      bullets: [
        { text: `Why no fast money: ${active ? "probabilities are a coin-flip and blend is " + b.sentiment : "liquidity is dead (dead session = spread + slippage tax on every fast exit)."}`, tone: "warn" },
        { text: "Set alerts and let the hunt come to you - the oracle is paid in patience when it says wait.", tone: "info" },
        { text: `Invalidate the wait at ${ctx.sr.nearestSupport || "support"} (down) / ${ctx.sr.nearestResistance || "resistance"} (up).`, tone: "side" },
      ],
      levels: levelsMap(ctx),
      warnings: ["Oracle odds near 50% = noise. Wait, don't force. Fast money protects the account first."],
    };
  }

  const plan = fastPlan(fastSide);
  const oracleLine = `${fastSide.toUpperCase()} fast. Entry ${plan.entry.toFixed(2)}, stop ${plan.stop} (${plan.stopPts} pts), target ${plan.target} (RR ${plan.rr}).`;
  const counterLine = counterFire
    ? `CROWD IS UNDERWATER - the oracle fades the flush ${st.bias === "long" ? "long" : "short"} exactly where their stop-hunt grabs them; enter after the exhaustion pin, not into the knife.`
    : `No liquidation-stage setup right now - this is a clean-session momentum fast trade, keep the stop tight.`;
  return {
    title: "Oracle - fast money trader",
    headline: `ORACLE CALL: ${fastSide.toUpperCase()} - in and out fast, before the crowd blinks.`,
    sentiment: fastSide === "long" ? "bullish" : fastSide === "short" ? "bearish" : "neutral",
    summary: `${oracleLine} ${counterLine} ${huntNote} Confidence decays fast: this is a next-bars trade, not a thesis.`,
    cards: [
      { label: "Oracle P(up) 1/3/6", value: `${f(h1)} / ${f(h3)} / ${f(h6)}`, hint: "fast / quick / swing" },
      { label: "Fast entry", value: plan.entry.toFixed(2), hint: fastSide },
      { label: "Fast stop", value: plan.stop, hint: plan.stopPts + " pts - tight" },
      { label: "Fast target", value: plan.target, hint: "RR " + plan.rr },
      { label: "Size", value: plan.lots + " lots", hint: "$" + plan.riskDol + " risk" },
      { label: "Session", value: sess.name, hint: "active - good to run" },
      { label: "Pain stage", value: st ? st.depthAtr.toFixed(2) + " ATR" : "-", hint: st && st.exhaustion ? "pin SEEN" : "no flush" },
    ],
    bullets: [
      { text: oracleLine, tone: fastSide === "long" ? "up" : "down" },
      { text: counterLine, tone: counterFire ? "up" : "info" },
      { text: `Exit rule: gone by ${ctx.tf === "M1" ? "15-20 minutes" : ctx.tf === "M5" ? "3-4 bars" : "next session close"} - fast money never marries a position.`, tone: "warn" },
      { text: `Honesty: recent forward hit-rate is ${acc === null ? "n/a" : acc + "%"}. ${acc !== null && acc < 55 ? "Oracle is guessing now - halve size and trust the stop." : "Useable - still stop everything."}`, tone: acc !== null && acc < 55 ? "warn" : "info" },
      { text: "Spread tax: every fast round-trip pays spread twice. On a dead session that tax eats the edge - that's why we only run when it's active.", tone: "info" },
    ],
    levels: {
      stop: { price: plan.stop, label: "Fast stop" },
      target: { price: plan.target, label: "Fast target" },
      ...levelsMap(ctx),
    },
    warnings: ["Fast money = fast stops. If it's not working in a few bars, it's out. No averaging down, ever."],
  };
};

module.exports = { modes };