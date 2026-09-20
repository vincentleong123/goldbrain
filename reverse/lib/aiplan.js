"use strict";
// REVERSE strategies - the AI writer.
//
// Deliberately NOT textbook setups. The model is the exact opposite:
//  * find the setup that RETALL/naive traders lose on systematically
//    (momentum chases, hold-with-no-stop, add-ons at a loss),
//  * learn where those trades are CERTAIN to be negative (the D-certain floor),
//  * when a live naive position is liquidated there, the counter holds the
//    OPPOSITE side back to the crowd's break-even as a LONG-TERM high-RR trade.
//
// The LLM only narrates the plan built from those numbers; it never invents
// an indicator. If no key/provider answers, a local narrator writes it.
const { configStatus } = require("../../src/reasoner");

let llmCache = {}; // `${sym}|${tf}` -> plan (so re-opens are instant)

function fmt(v, d = 2) {
  return v === null || v === undefined || !isFinite(v) ? "–" : Number(v).toFixed(d);
}

function numeric(e, key) {
  const v = e && e[key];
  return v === null || v === undefined || !isFinite(v) ? "–" : v;
}

// ------------------------------------------------ local (free) narrator
function buildLocalPlan(e, params) {
  const stats = e.stats || {};
  const dc = numeric(e, "dCertain");
  const dz = numeric(e, "dZero");
  const sims = (e.strategies && e.strategies.sims) || {};
  const flow = e.flow || {};
  const price = e.price || {};

  const stratLines = Object.keys(sims).map((k) => {
    const s = sims[k];
    return `${k}: ${s.trades} trades, ${s.wins}W/${s.losses}L (${fmt(s.winRate * 100, 0)}%), net ${fmt(s.net)} EUR`;
  }).join(" | ");

  let idea = "Wait. Do not buy the strong candle, do not sell the weak one.";
  let hold = "";
  let bracket = "";
  let invalidation = "";
  let story = "";

  if (e.reverse && e.reverse.active) {
    const r = e.reverse;
    idea = `The naive ${r.victim.side === "L" ? "long" : "short"} is ${fmt(-r.victim.float)} EUR underwater on 0.01 lot. That is exactly the spot where the crowd stops out (depth ${r.victim.depthFrac}% of D-certain ${dc} EUR). Enter the OPPOSITE setup: ${r.dirName}.`;
    hold = `Hold until gold returns to the crowd's break-even at ${fmt(r.bench)} (target). No fixed exit clock - the trade is "long-term" by construction (horizon up to ${r.maxHoldBars} bars). One position, no add-ons.`;
    bracket = `Entry ${fmt(r.entry)} | Buffer stop ${fmt(r.stop)} (below D-certain + 1.2 ATR) | Target = crowd break-even ${fmt(r.bench)} (R/R ${fmt(r.rr)}).`;
    invalidation = r.invalidation;
    story = `A trapped ${r.victim.side === "L" ? "buyer" : "seller"} got in near ${fmt(r.victim.entry)} and is now ${fmt(-r.victim.float)} EUR negative. The D-certain study says such trades stop recovering beyond roughly ${fmt(dc)} EUR of adverse move - ${fmt(dz)} EUR and practically none ever come back. We read that floor as the crowd's stop zone: price came to it, so the crowd will be closing. Our counter buys the same panic at ${fmt(r.entry)}, and instead of chasing a 1:1 scalp we hold for the whole trip back to the origin (${fmt(r.bench)}) - the reverse of the losing trade is a patient, high-yield one.`;
  } else {
    const worst = (e.naive && e.naive.book && e.naive.book[0]) || null;
    idea = worst
      ? `Still waiting. The current worst naive trade (${worst.side === "L" ? "long" : "short"} from ${new Date(worst.t).toISOString().slice(5, 16)}) is only ${fmt(worst.float)} EUR, ${worst.depthFrac ?? "–"}% of D-certain ${fmt(dc)} EUR. No liquidation zone yet - no counter.`
      : `Still waiting. No naive trade is deep enough to count as a liquidation yet - the counter only fires at the D-certain floor (${fmt(dc)} EUR adverse on 0.01).`;
    hold = "When a naive position reaches ~40-100% of D-certain, take the opposite side of that setup (not of price) and hold to the crowd's break-even. Reward comes from the round trip, not from flipping candles.";
    bracket = `No live bracket yet. Reference stop = price ${fmt(dc)} EUR away; reference target = the origin (crowd break-even) of the worst naive trade.`;
    invalidation = "Only if price breaks the D-certain floor PLUS the flush continues (real news) does the fade idea die - then re-assess, do not revenge-hold.";
    story = `For a stream of naive ${fmt((e.naive && e.naive.trials) || 0, 0)} trial trades, adverse-run medians are ${fmt(stats.median)} EUR (p90 ${fmt(stats.p90)}, p99 ${fmt(stats.p99)}). The D-certain point (${fmt(dc)} EUR) marks where their recovery rate collapses - that is the invalidation floor of the flush and the entry gate for the reverse hold. We are parked below it, waiting for a victim to walk into the kill zone.`;
  }

  return {
    ok: true, configured: configStatus().configured, source: "local",
    idea, hold, bracket, invalidation, story,
    metrics: {
      price: fmt(price.last),
      dCertain: fmt(dc), dZero: fmt(dz),
      medianAdverse: fmt(stats.median), p90Adverse: fmt(stats.p90),
      nTrials: (e.stats && e.stats.n) || (e.naive && e.naive.trials) || 0,
      strategies: stratLines,
      flow: `${flow.volRatio ? "volume " + flow.volRatio + "x normal" : "volume n/a"} - ${flow.available ? "order-flow available" : "no order-flow feed, using bar volume + adverse stats"}`,
    },
  };
}

// ------------------------------------------------ LLM writer (optional)
async function callLLM(cfg, system, user, timeoutMs = 30000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (cfg.provider === "anthropic") {
      const res = await fetch(`${cfg.baseURL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, max_tokens: 800, system, messages: [{ role: "user", content: user }] }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const j = await res.json();
      return (j.content || []).map((b) => b.text || "").join("\n").trim();
    }
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, temperature: 0.3, max_tokens: 800, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error("Empty");
    return String(text).trim();
  } finally {
    clearTimeout(to);
  }
}

function parsePlanText(text) {
  const grab = (label) => {
    const m = text.match(new RegExp("^[ \\t]*" + label + "[:\\-][ \\t]*([^\\n]+)", "im"));
    return m ? m[1].trim() : null;
  };
  return {
    idea: grab("IDEA") || grab("PLAN") || (text.split("\n")[0] || text).slice(0, 160),
    hold: grab("HOLD") || null,
    bracket: grab("BRACKET") || grab("Bracket") || null,
    invalidation: grab("INVALID") || null,
    story: text.length > 240 ? text.slice(-2000) : text,
  };
}

const SYSTEM = `You are the REVERSE strategist in a gold trading tool. You work from OPPOSITE assumptions to every textbook: momentum chases and hold-with-no-stop are the LOSING trades; you find where they are certainly negative and then hold the counter-side for a long time. Rules: never invent indicators or numbers not given; probabilities are opinions not predictions; the plan is advisory only; one position at a time; always demo-first. Answer in plain English with these exact lines:
IDEA: <one line, what to do now>
HOLD: <why we hold long-term, the expected round trip>
BRACKET: <entry | stop | target | R/R>
INVALID: <exact level or event that proves the fade wrong>
STORY: <2-4 sentences, vivid plain-English narration of how the plan formed>`;

function buildUserPrompt(e) {
  const stats = e.stats || {};
  const sims = (e.strategies && e.strategies.sims) || {};
  const stratLines = Object.keys(sims).map((k) => `${k}: net ${fmt(sims[k].net)} EUR, ${sims[k].wins}W/${sims[k].losses}L`).join(" | ");
  const rev = e.reverse;
  const worst = (e.naive && e.naive.book && e.naive.book[0]) || null;
  const flow = e.flow || {};
  return JSON.stringify({
    instrument: "XAUEUR (gold in EUR), " + (e.tfLabel || e.tf),
    price_now: fmt(e.price && e.price.last),
    session_structure: (e.struct && e.struct.label) || "?",
    atr: fmt(e.ind && e.ind.atr), rsi: fmt(e.ind && e.ind.rsi),
    contract_0_01_lot: `${fmt(e.contract && e.contract.perPointEur)} EUR per EUR 1.00 move`,
    learned_adverse_stats_eur_on_0_01: {
      median: fmt(stats.median), p75: fmt(stats.p75), p90: fmt(stats.p90), p99: fmt(stats.p99), trials: (e.naive && e.naive.trials) || stats.n || 0,
    },
    d_certain_eur: fmt(e.dCertain), d_zero_eur: fmt(e.dZero),
    live_victim_book: worst ? [{ side: worst.side, entry: worst.entry, float_eur: worst.float, depth_pct_of_d_certain: worst.depthFrac }] : [],
    reverse_counter: rev ? {
      active: rev.active, side: rev.side, action: rev.dirName,
      entry: rev.entry, bench: rev.bench, stop: rev.stop, target: rev.target, rr: rev.rr,
      invalidation: rev.invalidation,
    } : "none active yet",
    careful_strategy_sims_on_same_data: stratLines || "none",
    order_flow: flow.available ? "some" : "none (bar volume only: " + (flow.volRatio ? flow.volRatio + "x" : "n/a") + ")",
  }, null, 1);
}

// ---------------------------------------------------------------- entry point
async function aiPlan(e, params) {
  const key = `${e.symbol || "XAUEUR"}|${e.tf || ""}`;
  const local = buildLocalPlan(e, params);

  const wantAI = !!params.ai && configStatus().configured;
  if (!wantAI || llmCache[key]) {
    if (llmCache[key]) return { ...local, source: "llm", ...llmCache[key] };
    return local;
  }

  const cfg = { provider: configStatus().provider, baseURL: configStatus().baseURL, model: configStatus().model, apiKey: null };
  // key is loaded privately inside configStatus? It returns no key; we need the key.
  const fs = require("fs");
  const path = require("path");
  let apiKey = process.env.REASONER_API_KEY || "";
  try {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "config.json"), "utf8"));
    apiKey = apiKey || file.apiKey || "";
  } catch { /* env only */ }
  if (!apiKey) return local;
  cfg.apiKey = apiKey;

  try {
    const text = await callLLM(cfg, SYSTEM, buildUserPrompt(e), 30000);
    const parsed = parsePlanText(text);
    llmCache[key] = parsed;
    return { ...local, ok: true, configured: true, source: "llm", ...parsed };
  } catch (err) {
    return { ...local, configured: true, llmError: String(err && err.message || err) };
  }
}

module.exports = { aiPlan, configStatusLazy: configStatus };