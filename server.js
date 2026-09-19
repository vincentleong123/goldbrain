"use strict";
// GoldBrain local server. Binds to 127.0.0.1 only. Zero API keys.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { getCandles, putUpload, listMt5Files, TF_MS } = require("./src/data");
const { analyze } = require("./src/analyze");
const { getNews } = require("./src/news");
const { runReasoner, configStatus, saveConfig, chatReasoner } = require("./src/reasoner");
const { renderMovie, replayMeta } = require("./src/replay");

const TF_LABEL = { M1: "1m", M2: "2m", M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "1d" };

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
const TFS = ["M1", "M2", "M5", "M15", "M30", "H1", "H4", "D1"];

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
      let accountFile = null;
      try {
        const accPath = path.join(__dirname, "data", "mt5", "account.json");
        if (fs.existsSync(accPath)) accountFile = JSON.parse(fs.readFileSync(accPath, "utf8"));
      } catch { accountFile = null; }
      return sendJSON(res, 200, {
        mt5: files.length > 0,
        mt5Files: files.slice(0, 20),
        account: accountFile,
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

    if (p === "/api/playback") {
      const { trainAndPredict } = require("./src/ai");
      const { runBacktest, runPsychCounter } = require("./src/backtest");
      const { runCrowd } = require("./src/duel");
      const { ema } = require("./src/indicators");
      const q = urlObj.searchParams;
      const symbol = (q.get("symbol") || "XAUUSD").toUpperCase();
      const tf = (q.get("tf") || "M5").toUpperCase();
      const stratRaw = (q.get("strat") || "crowd").toLowerCase();
      const years = parseFloat(q.get("years") || "0");
      const barsArg = parseInt(q.get("bars") || "0", 10) || 0;
      const useSym = SYMBOLS.includes(symbol) ? symbol : "XAUUSD";
      const useTf = TFS.includes(tf) ? tf : "M5";
      const strats = ["crowd", "psych", "trend", "meanrev", "breakout", "hybrid"];
      const strat = strats.includes(stratRaw) ? stratRaw : "crowd";
      let bars = barsArg > 0 ? barsArg : years > 0 ? Math.ceil((years * 365 * 86400e3) / TF_MS[useTf]) : 3000;
      bars = Math.max(120, Math.min(bars, 20000));
      const t0 = Date.now();
      const dataRes = await getCandles(useSym, useTf, bars, { allowBig: true });
      const candles = dataRes.candles;
      const engineOpts = { detail: true };
      let engineRes;
      if (strat === "crowd") engineRes = runCrowd(candles, engineOpts);
      else if (strat === "psych") engineRes = runPsychCounter(candles, engineOpts);
      else {
        let aiModels = null;
        if (strat === "hybrid") aiModels = trainAndPredict(candles, Math.min(1800, candles.length)).horizons;
        engineRes = runBacktest(candles, strat, aiModels, engineOpts);
      }
      const all = (engineRes && engineRes.fullTrades || [])
        .map((t) => ({
          side: t.side,
          entryBar: t.entryBar !== undefined ? t.entryBar : t.entryI,
          exitBar: t.exitBar !== undefined ? t.exitBar : t.exitI,
          entry: t.entry, exit: t.exit, pnlUsd: t.pnlUsd, reason: t.reason,
          units: t.units || 1, adds: t.adds || 0, drawAtr: t.drawAtr || 0,
        }))
        .filter((t) => isFinite(t.exitBar) && isFinite(t.entryBar));
      const startEq = 10000;
      const eqPts = [{ bar: 0, eq: startEq }];
      let run = startEq;
      for (const t of all) { run += t.pnlUsd; eqPts.push({ bar: t.exitBar, eq: +run.toFixed(2) }); }
      const closes = candles.map((c) => c.c);
      const e20 = ema(closes, 20);
      const e50 = ema(closes, 50);
      const round = (v) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(2));
      const cl = candles.map((c) => ({ t: c.t, o: round(c.o), h: round(c.h), l: round(c.l), c: round(c.c), v: c.v || 0 }));
      const winsRes = all.filter((t) => t.pnlUsd > 0);
      const lossesRes = all.filter((t) => t.pnlUsd <= 0);
      const netUsd = +(engineRes && engineRes.netUsd || 0).toFixed(2);
      return sendJSON(res, 200, {
        ok: true, symbol: useSym, tf: useTf, tfLabel: TF_LABEL[useTf], strat,
        engineName: (engineRes && (engineRes.presetInfo && engineRes.presetInfo.name || engineRes.name)) || strat,
        source: dataRes.source, sourceLabel: dataRes.label, dataNote: dataRes.note || "",
        bars: cl.length, startTime: cl[0] && cl[0].t, endTime: cl[cl.length - 1] && cl[cl.length - 1].t,
        equityStart: startEq, tradeCount: all.length,
        wins: winsRes.length, losses: lossesRes.length,
        winRate: all.length ? winsRes.length / all.length : 0,
        finalPnl: netUsd, finalEquity: +(startEq + netUsd).toFixed(2),
        maxDrawdown: engineRes ? engineRes.maxDrawdown : 0,
        profitFactor: engineRes ? engineRes.profitFactor : 0,
        computeMs: Date.now() - t0,
        candles: cl,
        ema20: e20.slice(-cl.length).map(round),
        ema50: e50.slice(-cl.length).map(round),
        equityPts: eqPts,
        trades: all,
      });
    }

    // ------------------------------------------------ Reasoner (AI thinking)
    if (p === "/api/reasoner" && req.method === "GET") {
      const { symbol, tf, bars, fresh, ui } = paramsOf(req, urlObj);
      const force = req.url.includes("force=1") || fresh;
      const key = `reasoner|${symbol}|${tf}|${bars}`;
      const fn = async () => {
        const dataRes = await getCandles(symbol, tf, bars);
        const out = analyze(dataRes.candles, symbol, tf, bars, ui);
        out.source = dataRes.source;
        out.sourceLabel = dataRes.label;
        out.dataNote = dataRes.note || "";
        out.generatedAt = dataRes.generatedAt || Date.now();
        out.account = ui;
        let news = null;
        try {
          const n = await getNews();
          news = n.items || [];
        } catch {
          news = [];
        }
        const rez = await runReasoner(out, { ui, news });
        return { ...rez, symbol, tf };
      };
      if (force) {
        const out = await fn();
        cache.set(key, { t: Date.now(), data: out });
        return sendJSON(res, 200, out);
      }
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < TTL_ANALYSIS * 3) {
        return sendJSON(res, 200, hit.data);
      }
      const out = await fn();
      cache.set(key, { t: Date.now(), data: out });
      return sendJSON(res, 200, out);
    }

    if (p === "/api/reasoner/config" && req.method === "GET") {
      return sendJSON(res, 200, configStatus());
    }

    if (p === "/api/reasoner/config" && req.method === "POST") {
      const chunks = [];
      for await (const ck of req) chunks.push(ck);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJSON(res, 400, { ok: false, reason: "bad JSON body" });
      }
      const r = saveConfig({ apiKey: body.apiKey, baseURL: body.baseURL, model: body.model, mt5Files: body.mt5Files });
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // Discovery chat - educational/entertaining lens, streamed to the browser.
    if (p === "/api/reasoner/chat" && req.method === "POST") {
      const chunks = [];
      for await (const ck of req) chunks.push(ck);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJSON(res, 400, { ok: false, reason: "bad JSON body" });
      }
      const question = String(body.q || "").slice(0, 500).trim();
      if (!question) return sendJSON(res, 400, { ok: false, reason: "no question" });
      const { symbol, tf, bars, ui } = paramsOf(req, urlObj);
      if (!configStatus().configured) {
        return sendJSON(res, 400, { ok: false, reason: "not-configured" });
      }
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.writeHead(200);
      try {
        const dataRes = await getCandles(symbol, tf, bars);
        const out = analyze(dataRes.candles, symbol, tf, bars, ui);
        out.source = dataRes.source;
        out.sourceLabel = dataRes.label || "";
        out.dataNote = dataRes.note || "";
        out.generatedAt = dataRes.generatedAt || Date.now();
        out.account = ui;
        let news = [];
        try {
          const n = await getNews();
          news = n.items || [];
        } catch { news = []; }
        await chatReasoner(out, news, question, { ui }, (tok) => {
          if (!res.destroyed) res.write(tok);
        });
      } catch (e) {
        res.write(`\n[reasoner chat error: ${String((e && e.message) || e)}]`);
      }
      if (!res.destroyed) res.end();
      return;
    }

    // ------------------------------------------------ Theatre (replay movie)
    if (p === "/api/replay/meta" && req.method === "GET") {
      try {
        const q = urlObj.searchParams;
        const symbol = q.get("symbol") || "XAUUSD";
        const tf = q.get("tf") || "M15";
        const start = Math.max(1, parseInt(q.get("start") || String(Date.now() - 30 * 864e5), 10));
        const end = Math.max(start, parseInt(q.get("end") || String(Date.now()), 10));
        const m = await replayMeta(symbol, tf, start, end);
        return sendJSON(res, 200, { ok: true, ...m, requestedStart: start, requestedEnd: end });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, reason: String((e && e.message) || e) });
      }
    }

    if (p === "/api/replay/render" && req.method === "GET") {
      const q = urlObj.searchParams;
      const symbol = q.get("symbol") || "XAUUSD";
      const tf = q.get("tf") || "M15";
      const start = Math.max(1, parseInt(q.get("start") || String(Date.now() - 30 * 864e5), 10));
      const end = Math.max(start, parseInt(q.get("end") || String(Date.now()), 10));
      const useReasoner = q.get("ai") === "1";
      const sparks = parseInt(q.get("sparks") || "6", 10);
      const riskPct = parseFloat(q.get("risk") || "1") || 1;
      const rrTarget = parseFloat(q.get("rr") || "1.5") || 1.5;
      const balance = parseFloat(q.get("balance") || "1000") || 1000;

      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.writeHead(200);
      try {
        const film = await renderMovie(symbol, tf, start, end, { useReasoner, sparks, riskPct, rrTarget, balance }, {
          onProgress(p, msg) {
            if (!res.destroyed) res.write(JSON.stringify({ p: +(p * 100).toFixed(0), msg: String(msg || "") }) + "\n");
          },
        });
        if (!res.destroyed) res.write(JSON.stringify({ done: true, film }) + "\n");
      } catch (e) {
        if (!res.destroyed) res.write(JSON.stringify({ error: String((e && e.message) || e) }) + "\n");
      }
      if (!res.destroyed) res.end();
      return;
    }

    if (p === "/api/duel") {
      try {
        const fp = path.join(__dirname, "data", "duel-latest.json");
        if (!fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, reason: "no duel run yet - start run-duel.js" });
        return sendJSON(res, 200, JSON.parse(fs.readFileSync(fp, "utf8")));
      } catch (e) {
        return sendJSON(res, 500, { ok: false, reason: String((e && e.message) || e) });
      }
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