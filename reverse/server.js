"use strict";
// GoldBrain REVERSE - minimal local dashboard for XAUEUR (XM demo, 0.01 lot).
// New app, port 8766, nothing leaves the machine except Yahoo chart fetches.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { getCandles, listMt5Files } = require("./lib/datax");
const { analyzeReverse } = require("./lib/engine");
const { aiPlan } = require("./lib/aiplan");
const { configStatus, saveConfig } = require("../src/reasoner");

const PORT = 8766;
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const STATE_FILE = path.join(__dirname, "..", "data", "reverse-state.json");

const MIME = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", ico: "image/x-icon" };
const TFS = ["M5", "M15", "H1", "D1"];
const TTL = 20000;

let stateCache = null;
function loadState() {
  if (stateCache) return stateCache;
  try {
    stateCache = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    stateCache = { trials: [], book: [] };
  }
  return stateCache;
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s), "utf8");
    stateCache = s;
  } catch (e) {
    console.error("state save failed:", String(e.message || e));
  }
}

const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const data = fn();
  cache.set(key, { t: Date.now(), data });
  return data;
}

function paramsOf(urlObj) {
  const q = urlObj.searchParams;
  const tf = TFS.includes((q.get("tf") || "M15").toUpperCase()) ? q.get("tf").toUpperCase() : "M15";
  const bars = Math.min(Math.max(parseInt(q.get("bars") || "500", 10), 150), 3000);
  const fresh = q.get("fresh") === "1" || q.get("force") === "1";
  const wantAI = q.get("ai") === "1";
  return {
    tf, bars, fresh, wantAI,
    ui: {
      tf,
      balance: parseFloat(q.get("balance")) || 1000,
      riskPct: parseFloat(q.get("riskPct")) || 1,
      lot: 0.01, ozPerLot: 100, eurUsd: 1.09,
    },
  };
}

function sendJSON(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": MIME.json, "Cache-Control": "no-store", ...extra, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function analysis(tf, bars, ui, wantAI) {
  const dataRes = await getCandles(tf, bars);
  ui.eurUsd = dataRes.eurUsd || ui.eurUsd;
  const state = loadState();
  const e = analyzeReverse(dataRes.candles, state, { ...ui, symbol: "XAUEUR" });
  e.source = dataRes.source;
  e.sourceLabel = dataRes.label;
  e.dataNote = dataRes.note || "";
  e.generatedAt = dataRes.generatedAt || Date.now();
  // persist accumulated trials/book (continuous trial & error survives restarts)
  if (e.state) saveState(e.state);
  const plan = await aiPlan(e, { ai: wantAI, tf, symbol: "XAUEUR" });
  e.aiPlan = plan;
  e.generatedAt = Date.now();
  delete e.state; // the live-trials log stays on disk, not in the page payload
  return e;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const p = urlObj.pathname;

    if (p === "/" || p === "/index.html") return serveStatic("index.html", res);
    if (p.startsWith("/static/")) return serveStatic(urlObj.pathname.slice("/static/".length), res);

    if (p === "/api/meta") {
      return sendJSON(res, 200, {
        symbol: "XAUEUR", tfs: TFS, port: PORT,
        llm: configStatus(),
        mt5Files: listMt5Files().filter((f) => /xaueur/i.test(f)),
        contract: "0.01 lot = 1 oz of gold (EUR 1 per EUR 1.00 price move)",
        now: Date.now(),
      });
    }

    if (p === "/api/analysis") {
      const { tf, bars, fresh, wantAI, ui } = paramsOf(urlObj);
      const key = `a|${tf}|${bars}|${wantAI ? "ai" : "no"}`;
      let out;
      if (fresh) {
        out = await analysis(tf, bars, ui, wantAI);
        cache.set(key, { t: Date.now(), data: out });
      } else {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.t < TTL) out = hit.data;
        else {
          out = await analysis(tf, bars, ui, wantAI);
          cache.set(key, { t: Date.now(), data: out });
        }
      }
      return sendJSON(res, 200, out);
    }

    if (p === "/api/config" && req.method === "POST") {
      const chunks = [];
      for await (const ck of req) chunks.push(ck);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return sendJSON(res, 400, { ok: false, reason: "bad JSON" }); }
      const r = saveConfig({ apiKey: body.apiKey, baseURL: body.baseURL, model: body.model, mt5Files: "" });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    if (p === "/api/ht") {
      // basic health: prove the reverse engine runs on the CURRENT window
      const { tf, bars, ui } = paramsOf(urlObj);
      const dataRes = await getCandles(tf, bars);
      return sendJSON(res, 200, { ok: true, source: dataRes.source, bars: dataRes.candles.length, last: dataRes.candles[dataRes.candles.length - 1] });
    }

    return sendJSON(res, 404, { ok: false, reason: "not found" });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, reason: String((e && e.message) || e) });
  }
});

function serveStatic(file, res) {
  const rel = file.replace(/^\.\.(\/|\\)/g, "").replace(/[\\/]+/g, path.sep);
  const fp = path.join(PUBLIC, rel);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const ext = path.extname(fp).slice(1);
  const body = fs.readFileSync(fp);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-cache" });
  res.end(body);
}

// ----------------------------------------------------- continuous trial & error
let lastTick = 0;
async function tick() {
  try {
    const { tf, bars, ui } = paramsOf(new URL("http://x/api/analysis?tf=M15&bars=600"));
    const dataRes = await getCandles(tf, bars);
    ui.eurUsd = dataRes.eurUsd || ui.eurUsd;
    const e = analyzeReverse(dataRes.candles, loadState(), { ...ui, symbol: "XAUEUR" });
    if (e.state) saveState(e.state);
    lastTick = Date.now();
    console.log(`[reverse-tick] ${new Date(lastTick).toISOString()} bars=${dataRes.candles.length} trials=${e.naive ? e.naive.trials : "?"} book=${e.naive ? e.naive.book.length : "?"}`);
    for (const key of [...cache.keys()]) cache.delete(key); // invalidate analysis cache after background state update
  } catch (e0) {
    console.error("[reverse-tick] error:", String((e0 && e0.message) || e0));
  }
}
setInterval(tick, 60000);
setTimeout(tick, 3000);

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  GOLDBRAIN REVERSE - XAUEUR 0.01-lot counter / long-hold dashboard");
  console.log(`  http://${HOST}:${PORT}`);
  console.log("  Continuous trial&error book is running in the background.");
  console.log("  Close window to stop. Local only.");
  console.log("");
  if (process.platform === "win32") {
    try { require("child_process").exec(`start http://${HOST}:${PORT}`); } catch { /* best-effort */ }
  }
});

process.on("exit", () => { try { saveState(loadState()); } catch { /* noop */ } });