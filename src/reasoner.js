"use strict";
// GoldBrain REASONER - the "AI-textbook" brain.
//
// Unlike the trained ML engine (which curve-fits the recent window), the
// Reasoner is an instruction-following language model that READS a compact,
// factual snapshot (price structure, levels, retail-pain stage, session,
// risk budget + optional live news headlines) and REASONS to a decision.
//
// SAFETY DESIGN:
//  * It never sends orders. It returns a reasoned plan (advisory only).
//  * Everything is labelled: probabilities are opinions, not predictions.
//  * No API key is stored in this repo - it lives in data/config.json (gitignored)
//    or env vars REASONER_API_KEY / REASONER_BASE_URL / REASONER_MODEL.
//  * Works with any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter,
//    Ollama, LM Studio, Groq...) plus Anthropic's native API.
const fs = require("fs");
const path = require("path");
const { clamp } = require("./mta");

const CONFIG_FILE = path.join(__dirname, "..", "data", "config.json");
const PLAN_FILE = path.join(__dirname, "..", "data", "reasoner-plan.json");

const FALLBACKS = {
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-3-5-haiku-latest" },
};

// ---------------------------------------------------------------- config
function loadConfig() {
  let file = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { file = {}; }
  const apiKey = process.env.REASONER_API_KEY || file.apiKey || "";
  let baseURL = process.env.REASONER_BASE_URL || file.baseURL || "";
  let model = process.env.REASONER_MODEL || file.model || "";
  const isAnthropic = /anthropic/i.test(baseURL) || (/^(claude-)/i.test(model) && !baseURL);
  if (!baseURL) baseURL = isAnthropic ? FALLBACKS.anthropic.baseURL : FALLBACKS.openai.baseURL;
  if (!model) model = isAnthropic ? FALLBACKS.anthropic.model : FALLBACKS.openai.model;
  return { apiKey, baseURL: baseURL.replace(/\/+$/, ""), model, provider: isAnthropic ? "anthropic" : "openai-compatible", mt5Files: String(file.mt5Files || "").trim() };
}

function configStatus() {
  const c = loadConfig();
  return { configured: !!c.apiKey, provider: c.provider, model: c.model, baseURL: c.baseURL, mt5Files: c.mt5Files || "" };
}

function saveConfig({ apiKey, baseURL, model, mt5Files }) {
  let key = String(apiKey || "").trim();
  if (key === "(keep-current-key)") {
    const cur = loadConfig();
    key = cur.apiKey || "";
  }
  if (!key) return { ok: false, reason: "API key is required." };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    apiKey: key,
    baseURL: String(baseURL || "").trim(),
    model: String(model || "").trim(),
    mt5Files: String(mt5Files || "").trim(),
  }, null, 2));
  return { ok: true, ...configStatus() };
}

// ---------------------------------------------------------------- LLM call
async function callLLM(cfg, system, user, timeoutMs = 65000) {
  const isAnthropic = cfg.provider === "anthropic";
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (isAnthropic) {
      const res = await fetch(`${cfg.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1200,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      const j = await res.json();
      const blocks = j.content || [];
      return blocks.map((b) => b.text || "").join("\n").trim();
    }
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error("Empty LLM response.");
    return String(text).trim();
  } finally {
    clearTimeout(to);
  }
}

// ---------------------------------------------------------------- LLM streaming
// Streams tokens from the provider (OpenAI-compatible NDJSON or Anthropic SSE).
// onToken(text) is called for every text slice; resolves when the reply ends.
async function callLLMStream(cfg, system, user, onToken, timeoutMs = 120000) {
  const isAnthropic = cfg.provider === "anthropic";
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const dec = new TextDecoder("utf-8");
  try {
    const payload = isAnthropic
      ? { model: cfg.model, max_tokens: 900, system, messages: [{ role: "user", content: user }], stream: true }
      : { model: cfg.model, temperature: 0.5, max_tokens: 900, stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ] };
    const res = isAnthropic
      ? await fetch(`${cfg.baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": cfg.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        })
      : await fetch(`${cfg.baseURL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    let buf = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") { done = true; break; }
          try {
            const j = JSON.parse(data);
            if (isAnthropic) {
              if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta" && j.delta.text) {
                onToken(j.delta.text);
              }
            } else {
              const dTxt = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (typeof dTxt === "string" && dTxt) onToken(dTxt);
            }
          } catch { /* skip partial frames */ }
        }
      }
    }
  } finally {
    clearTimeout(to);
  }
}

// Interactive Discovery chat - educational/entertaining lens over the SAME snapshot+news.
async function chatReasoner(analysis, news, question, opts = {}, onToken) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("not-configured");
  const ui = opts.ui || { balance: 1000, riskPct: 1 };
  const context = buildContext(analysis, opts, news);
  const full = `The live snapshot:\n\n${context}\n\nThe question you must answer:\n${question}`;
  let text = "";
  await callLLMStream(cfg, CHAT_PROMPT, full, (tok) => { text += tok; if (onToken) onToken(tok); });
  return { ok: true, text: text.trim(), model: cfg.model, provider: cfg.provider };
}

// ---------------------------------------------------------------- plan parse
function parsePlan(text) {
  if (!text) return { ok: false, reason: "empty model output" };
  let start = text.indexOf("{");
  let end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return { ok: false, reason: "no JSON object in model output" };
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    // tolerate single quotes / unquoted keys crudely
    try {
      const fixed = text
        .slice(start, end + 1)
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, "$1\"$2\":")
        .replace(/:\s*'([^']*)'/g, ':"$1"');
      obj = JSON.parse(fixed);
    } catch (e) {
      return { ok: false, reason: "model output not parseable JSON: " + e.message };
    }
  }
  const str = (a) => (typeof obj[a] === "string" ? obj[a] : typeof obj[a] === "number" ? String(obj[a]) : "");
  const arr = (a) => (Array.isArray(obj[a]) ? obj[a].filter((x) => typeof x === "string" && x.trim()) : []);
  const num = (a) => {
    const v = typeof obj[a] === "number" ? obj[a] : parseFloat(String(obj[a] || "").replace(/[$,]/g, ""));
    return isFinite(v) ? v : 0;
  };
  const obj2 = (a) => (obj[a] && typeof obj[a] === "object" ? obj[a] : null);
  const direction = (str("direction") || "").toLowerCase();
  if (!["long", "short", "flat"].includes(direction)) {
    return { ok: false, reason: "unrecognised direction: " + str("direction") };
  }
  const conviction = clamp(num("conviction"), 0, 1);
  const plan = {
    ok: true,
    direction,
    conviction,
    entry: num("entry"),
    stop: num("stop"),
    target: num("target"),
    rr: num("rr"),
    sizeNote: str("sizeNote"),
    story: str("story"),
    reason: arr("reason"),
    risks: arr("risks"),
    dominatedBy: arr("dominatedBy"),
    invalidation: str("invalidation"),
    scenarioBull: obj2("scenarioBull") || null,
    scenarioBase: obj2("scenarioBase") || null,
    scenarioBear: obj2("scenarioBear") || null,
  };
  return plan;
}

// ---------------------------------------------------------------- context
function buildContext(analysis, opts, news) {
  const o = analysis || {};
  const ui = opts.ui || { balance: 1000, riskPct: 1 };
  const L = [];
  const money = (n) => (isFinite(n) ? "$" + Number(n).toFixed(2) : "n/a");
  const pct = (n, d) => (isFinite(n) ? (n * 100).toFixed(d ?? 1) + "%" : "n/a");
  const dt = o.contract && o.contract.ts ? new Date(o.contract.ts).toISOString().replace("T", " ").slice(0, 16) : "n/a";

  L.push(`INSTRUMENT: ${o.symbol || "XAUUSD"} ${o.tf || "M1"} (${o.bars || 0} bars) - data source: ${o.sourceLabel || o.source || "?"}`);
  L.push(`Last price ${money(o.contract && o.contract.price)}, bar change ${pct(o.contract && o.contract.changePct, 3)}, bar time UTC ${dt}.`);
  L.push(`Session: ${o.session ? o.session.name + " - " + o.session.note : "n/a"}.`);

  if (o.struct) L.push(`Swing structure: ${o.struct.label}.`);
  if (o.ind) {
    L.push(
      `Indicators: RSI14 ${o.ind.rsi}, ATR ${money(o.ind.atr)} (vol clamp), MACD hist ${o.ind.macdHist}, ` +
      `EMA20/50 spread ${o.ind.emaSpeed >= 0 ? "bullish" : "bearish"}, BB position ${o.ind.bbPos.toFixed(2)} (0=lower,1=upper), VWAP ${o.price ? (o.price >= o.ind.vwap ? "above" : "below") : "?"}.`
    );
  }
  if (o.sr) {
    L.push(`Levels: nearest support ${money(o.sr.nearestSupport)}, nearest resistance ${money(o.sr.nearestResistance)}.`);
    if (o.sr.supports && o.sr.supports.length) L.push(`Support cluster: ${o.sr.supports.slice(0, 3).map((s) => money(s.price) + "(x" + s.touches + ")").join(", ")}.`);
    if (o.sr.resistances && o.sr.resistances.length) L.push(`Resistance cluster: ${o.sr.resistances.slice(0, 3).map((r) => money(r.price) + "(x" + r.touches + ")").join(", ")}.`);
  }
  if (o.early) L.push(`Early-move: ignition ${o.early.ignition}, strength ${o.early.strength.toFixed(2)}, ${o.early.note || ""}. Range hi/lo ${money(o.early.rangeHigh)} / ${money(o.early.rangeLow)}.`);

  // retail-pain stage = the genuinely informative part
  if (o.stage) {
    const st = o.stage;
    L.push(
      `RETAIL-PAIN STAGE: crowd ${st.bias === "long" ? "holding losers after a flush down" : "in a profit run-up"}, ` +
      `depth ${st.depthAtr.toFixed(2)} ATR from anchor ${money(st.anchor)}, stage ${st.stage >= 0 ? "-" + (st.stagePct * 100).toFixed(0) + "% ATR" : "clean"}, ` +
      `pain per 0.1 lot ${money(st.painUsd0_1)}, exhaustion candle ${st.exhaustion ? "YES" : "no"}, counter entry ready ${st.entryReady ? "YES" : "no"}. ` +
      `Rule: fade deep flush (0.55..2.6 ATR) with a HARD stop, bank half at anchor, trail runner.`
    );
  }

  if (o.ai && o.ai.ok) {
    const h = o.ai.horizons || {};
    const f = (x) => (x && isFinite(x.probUp) ? pct(x.probUp, 0) + (x.fwdAccuracy ? " (self-acc " + pct(x.fwdAccuracy, 0) + ")" : "") : "n/a");
    L.push(`Pattern-ML memory (trained just now, treat as weak prior): 1-bar up-odds ${f(h["1"])}, 3-bar ${f(h["3"])}, 6-bar ${f(h["6"])}. It curve-fits recent bars - do NOT treat as news-aware.`);
  }

  // idealized backtest memory
  const bt = o.backtests || {};
  const keys = ["psych", "hybrid", "trend", "meanrev", "breakout"];
  const btLines = [];
  for (const k of keys) {
    const b = bt[k];
    if (b && b.trades > 0) btLines.push(`${k}: ${b.trades} tr, WR ${pct(b.winRate, 0)}, net ${money(b.netUsd)}, PF ${isFinite(b.profitFactor) ? b.profitFactor.toFixed(2) : "inf"}`);
  }
  if (btLines.length) L.push(`Idealised backtests (no slippage, 0.1 lot, on THIS data): ${btLines.join(" | ")}. Past/self-consistent - weak evidence.`);

  L.push(`Risk budget: balance ${money(ui.balance)}, risk ${ui.riskPct}% per trade = ${money((ui.balance || 1000) * clamp(ui.riskPct || 1, 0.05, 5) / 100)} on a 0.1-lot = $10/point basis.`);

  if (news && news.length) {
    L.push("\nLIVE NEWS HEADLINES (past ~3 days, scraped from public RSS - unverified, may be noise):");
    for (let i = 0; i < Math.min(news.length, 8); i++) {
      const n = news[i];
      const t = n.pub ? "[" + new Date(n.pub).toISOString().slice(0, 10) + "] " : "";
      L.push(`- ${t}${n.title}${n.desc ? ` — ${n.desc.slice(0, 120)}` : ""}${n.src ? ` (${n.src})` : ""}`);
    }
    L.push("\nDo NOT treat headlines as fact. Weight them by source reputation and only for direction & regime, NEVER for precise levels.");
  } else {
    L.push("\nNo news feed available right now - reason from structure/stage/session only, and say so in 'dominatedBy'.");
  }

  return L.join("\n");
}

// ---------------------------------------------------------------- prompt
const SYSTEM_PROMPT = `You are the REASONER inside GoldBrain - a disciplined XAUUSD (gold) trader who thinks, not a pattern-classifier.
Your job: read a factual snapshot and REASON to a single decision. You are an advisor; you never execute.

REASONING DISCIPLINE:
1. Start from the structure and the RETAIL-PAIN stage (who is trapped and where). That is your first question: "where will forced flows collide?"
2. Weigh the NEWS by whether it describes a genuine macro impulse. If a deep flush happens BECAUSE of real news (Fed shock, war, data), do NOT fade it - news-driven moves can run through every stage. If the flush is unexplained by news, the counter/fade idea is more alive.
3. Session matters: London open / NY overlap are high-liquidity; late-night/Asia are chop - prefer smaller read then.
4. Levels must be real: entry at/near price, stop beyond the nearest structural extreme plus ATR buffer, target at nearest meaningful level with at least ~1.5R. Never invent levels.
5. Sizing must respect the risk budget given. State size in 0.1-lot units (each 0.1 lot = $10 per point).
6. Be HONEST. 'flat' is a complete and often best answer. Conviction < 0.35 or conflicting evidence => flat. Do not manufacture a trade.
7. The pattern-ML memory is a weak prior (it merely curve-fit recent bars). Discount it when it conflicts with structure, stage and news.

OUTPUT - ONLY a single JSON object, no markdown, no prose before/after:
{
  "direction": "long" | "short" | "flat",
  "conviction": 0..1,
  "entry": number,
  "stop": number,
  "target": number,
  "rr": number,
  "sizeNote": "number of 0.1-lot units given the risk budget",
  "story": "2-4 vivid sentences in plain trader English narrating HOW you reached this read - the psychology, the structure, the kicker. Make it genuinely interesting and teaching-oriented, no jargon walls. This is the human part.",
  "reason": ["3-5 short reasons, each a real causal argument"],
  "risks": ["1-3 concrete risks for THIS setup"],
  "dominatedBy": ["structure", "stage"|"news"|"session"|"levels"|"fundamentals", ...top drivers],
  "invalidation": "a concrete price condition that makes the idea wrong",
  "scenarioBull": {"trigger": "...", "target": number},
  "scenarioBase": {"trigger": "...", "target": number},
  "scenarioBear": {"trigger": "...", "target": number}
}`;

// Teaching / discovery persona for the chat. Same live snapshot, different lens:
// explain, entertain, awaken curiosity. Honest - never pretends to know the future.
const CHAT_PROMPT = `You are the EDUCATOR inside GoldBrain - a warm, vivid teacher who makes XAUUSD (gold) trading COMPREHENSIBLE and interesting.
You have the same live snapshot the Reasoner used. Answer the person's question directly and well:
- Teach: explain with plain words and a concrete analogy when it helps.
- Be honest: you are an AI that reasons over data + headlines; you do NOT see the future. Say so whenever a question implies prediction.
- Keep answers tight (under ~180 words) unless the question asks for depth. Use the actual numbers/levels/stage from the snapshot so answers feel real, not generic.
- If asked to critique the current read: give the strongest honest case against it - a teacher who only flatters teaches nothing.
- Format with short lines and dashes. No giant walls of text. No emojis.`;

function confidenceLabel(c) {
  if (c >= 0.75) return "high";
  if (c >= 0.5) return "medium";
  if (c >= 0.35) return "low";
  return "flat";
}

function validatePlan(plan, analysis, ui) {
  if (!plan || !plan.ok) return plan;
  const price = analysis && analysis.contract ? analysis.contract.price : 0;
  const atr = analysis && analysis.ind ? analysis.ind.atr : 0;
  if (plan.direction === "flat") return { ...plan, conviction: Math.min(plan.conviction, 0.35), entry: 0, stop: 0, target: 0, rr: 0, validated: true };
  if (!price || !atr || !isFinite(plan.entry) || plan.entry <= 0 || !isFinite(plan.stop) || plan.stop <= 0 || !isFinite(plan.target) || plan.target <= 0) {
    return { ...plan, ok: false, reason: "levels invalid/missing", validated: true };
  }
  const wrongSide =
    plan.direction === "long"
      ? !(plan.stop < plan.entry && plan.target > plan.entry)
      : plan.direction === "short"
      ? !(plan.stop > plan.entry && plan.target < plan.entry)
      : false;
  if (wrongSide) {
    return { ...plan, ok: false, reason: "levels on the wrong side of entry - rejected, do not trade", validated: true };
  }
  const riskPts = Math.abs(plan.entry - plan.stop);
  const rr = riskPts > 0 ? Math.abs(plan.target - plan.entry) / riskPts : 0;
  if (riskPts < atr * 0.2) {
    return { ...plan, ok: false, reason: "stop too tight (" + riskPts.toFixed(2) + " pts < 0.2 ATR) - would be noise-stopped", validated: true };
  }
  const budget = (ui.balance || 1000) * clamp(ui.riskPct || 1, 0.05, 5) / 100;
  const suggestedUnits = Math.max(0.1, Math.floor((budget / riskPts) * 10) / 10);
  return {
    ...plan,
    rr: +Math.max(plan.rr, rr).toFixed(2),
    sizeNote: plan.sizeNote || `${suggestedUnits} x 0.1-lot (risk ~${(riskPts * 0.1 * 10).toFixed(0)} pts...)`,
    validated: true,
  };
}

// ---------------------------------------------------------------- main
async function runReasoner(analysis, opts = {}) {
  const ui = opts.ui || { balance: 1000, riskPct: 1 };
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      reason: "not-configured",
      message: "No API key yet. Set one in Settings (Reasoner tab) or env REASONER_API_KEY.",
      configured: false,
      provider: cfg.provider,
      model: cfg.model,
    };
  }

  const news = opts.news || [];
  const context = buildContext(analysis, opts, news);
  const t0 = Date.now();
  let raw;
  try {
    raw = await callLLM(cfg, SYSTEM_PROMPT, context);
  } catch (e) {
    return {
      ok: false,
      reason: "llm-error",
      message: String((e && e.message) || e),
      configured: true,
      provider: cfg.provider,
      model: cfg.model,
      ms: Date.now() - t0,
      context,
    };
  }
  const plan = validatePlan(parsePlan(raw), analysis, ui);
  const ms = Date.now() - t0;
  const result = {
    ok: true,
    configured: true,
    provider: cfg.provider,
    model: cfg.model,
    ms,
    generatedAt: Date.now(),
    context,
    plan,
    confidence: confidenceLabel(plan.conviction),
    warnings: [],
    newsUsed: news.length,
    sourceLabel: analysis.sourceLabel || analysis.source || "?",
    demoData: analysis.source === "demo",
  };
  if (analysis.source === "demo") {
    result.warnings.push("Reasonable decision based on DEMO data - this tells you nothing real about live gold.");
    result.plan = { ...result.plan, direction: "flat", conviction: 0 };
  }
  if (news.length === 0) result.warnings.push("No news feed available this refresh - reason ran on structure/stage/session only.");
  // advisory plan file (for the GoldPsychoEA to read if the user enables handoff)
  const planDoc = {
    advisory: true,
    at: result.generatedAt,
    symbol: analysis.symbol,
    tf: analysis.tf,
    price: (analysis.contract && analysis.contract.price) || analysis.price || 0,
    atr: (analysis.ind && analysis.ind.atr) || analysis.atr || 0,
    plan: result.plan,
  };
  try {
    fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
    fs.writeFileSync(PLAN_FILE, JSON.stringify(planDoc, null, 2));
  } catch {
    /* plan file is best-effort */
  }
  // optional mirror into MT5's MQL5\Files\ folder so the EA picks it up live
  const mt5Dir = loadConfig().mt5Files;
  if (mt5Dir) {
    try {
      fs.mkdirSync(mt5Dir, { recursive: true });
      fs.writeFileSync(path.join(mt5Dir, "reasoner-plan.json"), JSON.stringify(planDoc, null, 2));
    } catch { /* mirror is best-effort */ }
  }
  return result;
}

module.exports = { runReasoner, buildContext, loadConfig, configStatus, saveConfig, callLLM, callLLMStream, chatReasoner, parsePlan, validatePlan, PLAN_FILE };