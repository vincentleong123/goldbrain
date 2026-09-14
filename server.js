"use strict";
// GoldBrain local server. Binds to 127.0.0.1 only. Zero API keys.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { getCandles, putUpload, listMt5Files } = require("./src/data");
const { analyze } = require("./src/analyze");

const PORT = 8765;
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");

const MIME = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  mq5: "text/plain; charset=utf-8",
};

const cache = new Map(); // key -> {t, data}
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const data = fn();
  cache.set(key, { t: Date.now(), data });
  return data;
}
const TTL_ANALYSIS = 25000;

const SYMBOLS = ["XAUUSD", "XAUUSDm", "GOLD"];
const TFS = ["M1", "M5", "M15", "H1", "H4", "D1"];

function paramsOf(req, urlObj) {
  const q = urlObj.searchParams;
  const symbol = (q.get("symbol") || "XAUUSD").toUpperCase();
  const tf = (q.get("tf") || "M1").toUpperCase();
  const bars = Math.min(Math.max(parseInt(q.get("bars") || "300", 10), 40), 5000);
  const fresh = q.get("fresh") === "1";
  const ui = {
    balance: parseFloat(q.get("balance")) || 1000,
    riskPct: clamp1(parseFloat(q.get("riskPct")), 0.05, 5) || 1,
    leverage: clamp1(parseFloat(q.get("leverage")), 20, 1000) || 500,
  };
  const useSym = SYMBOLS.includes(symbol) ? symbol : "XAUUSD";
  const useTf = TFS.includes(tf) ? tf : "M1";
  return { symbol: useSym, tf: useTf, bars, fresh, ui };
}
function clamp1(v, lo, hi) { return v ? Math.min(Math.max(v, lo), hi) : null; }

async function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": MIME.json, "Cache-Control": "no-store", ...extraHeaders, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const p = urlObj.pathname;

    if (p === "/" || p === "/index.html") {
      return serveStatic("index.html", res);
    }
    if (p.startsWith("/static/")) {
      return serveStatic(urlObj.pathname.slice("/static/".length), res);
    }

    if (p === "/api/sources") {
      const files = listMt5Files();
      return sendJSON(res, 200, {
        mt5: files.length > 0,
        mt5Files: files.slice(0, 20),
        yahoo: true, // availability tested lazily at analysis time
        csvUploads: 0,
        now: Date.now(),
      });
    }

    if (p === "/api/analysis" && req.method === "GET") {
      const { symbol, tf, bars, fresh, ui } = paramsOf(req, urlObj);
      const key = `${symbol}|${tf}|${bars}`;
      const fn = async () => {
        const dataRes = await getCandles(symbol, tf, bars);
        const out = analyze(
          dataRes.candles,
          symbol,
          tf,
          bars,
          ui
        );
        out.source = dataRes.source;
        out.sourceLabel = dataRes.label;
        out.dataNote = dataRes.note || "";
        out.generatedAt = dataRes.generatedAt || Date.now();
        out.account = ui;
        return out;
      };
      if (fresh) {
        const out = await fn();
        cache.set(key, { t: Date.now(), data: out });
        return sendJSON(res, 200, out);
      }
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < TTL_ANALYSIS) {
        return sendJSON(res, 200, hit.data);
      }
      const out = await fn();
      cache.set(key, { t: Date.now(), data: out });
      return sendJSON(res, 200, out);
    }

    if (p === "/api/upload" && req.method === "POST") {
      const q = urlObj.searchParams;
      const symbol = (q.get("symbol") || "XAUUSD").toUpperCase();
      const tf = (q.get("tf") || "M1").toUpperCase();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const r = putUpload(symbol, tf, text);
      if (r.ok) {
        cache.delete(`${symbol}|${tf}|*`);
        return sendJSON(res, 200, { ok: true, ...r });
      }
      return sendJSON(res, 400, { ok: false, reason: r.reason });
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

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  GOLDBRAIN - local XAUUSD intelligence dashboard");
  console.log(`  http://${HOST}:${PORT}`);
  console.log("  Close window to stop. Local only - nothing leaves this machine.");
  console.log("");
  if (process.platform === "win32") {
    try {
      require("child_process").exec(`start http://${HOST}:${PORT}`);
    } catch {
      /* window opening is best-effort */
    }
  }
});