"use strict";
// Free news headline collection - no API keys. Google News RSS + Yahoo Finance
// RSS feeds, keyword filtered, deduped, cached. Used ONLY as factual context for
// the Reasoner. Headlines are unverified scrapes - the LLM is told so.
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "..", "data", "news-cache.json");
const CACHE_MAX_MS = 20 * 60 * 1000; // 20 minutes
const QUIET_CACHE_MAX_MS = 10 * 60 * 1000; // graceful if network down

const QUERIES = [
  "gold price",
  "XAUUSD",
  "precious metals market",
];

const YAHOO_FEEDS = [
  { sym: "GC=F", label: "Gold Futures" },
  { sym: "XAUUSD=X", label: "Gold Spot" },
];

const KEYWORDS = [
  "gold", "xau", "ounce", "precious metal", "bullion", "fed", "fomc", "pivot",
  "rate cut", "rate hike", "rate decision", "treasury", "yield", "inflation",
  "cpi", "pce", "nonfarm", "nfp", "jobs report", "dollar", "usd", "greenback",
  "silver", "pv/ds", "safe haven", "haven", "geopolit", "ukraine", "gaza",
  "russia", "tariff", "recession", "stagnation", "liquidity", "rally", "plunge",
  "slump", "surge", "record", "all-time", "dxy", "metals",
];

// Tiny RSS/XML parser using regex. Good enough for <item>/<entry> feeds.
function parseRss(xml) {
  const entries = [];
  const itemRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const grab = (tag) => {
      const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const g = rx.exec(block);
      return g ? g[1].trim() : "";
    };
    const strip = (s) =>
      String(s || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    const title = strip(grab("title"));
    const desc = strip(grab("description") || grab("summary"));
    const link = grab("link").trim();
    const pub = parsePub(grab("pubDate") || grab("published") || grab("updated"));
    if (!title) continue;
    entries.push({ title, desc, link, pub, source: strip(grab("source")) });
  }
  return entries;
}

function parsePub(s) {
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  // google news pubDate like "Sun, 20 Sep 2026 03:00:00 GMT"
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const gm = /(\d{1,2}) (\w{3}) (\d{4}) (\d{1,2}):(\d{2})/.exec(s);
  if (gm) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    return Date.UTC(+gm[3], months[gm[2].toLowerCase()], +gm[1], +gm[4], +gm[5]);
  }
  return 0;
}

async function fetchText(url, timeoutMs = 6000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0 (GoldBrain/1.0)" } });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(to);
  }
}

async function fetchGoogle(existing) {
  let out = existing || [];
  for (const q of QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}%20when:3d&hl=en-US&gl=US&ceid=US:en`;
    const xml = await fetchText(url);
    if (!xml) continue;
    out = out.concat(parseRss(xml).map((e) => ({ ...e, src: "Google News" })));
  }
  return out;
}

async function fetchYahoo(existing) {
  let out = existing || [];
  for (const f of YAHOO_FEEDS) {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(f.sym)}&region=US&lang=en-US`;
    const xml = await fetchText(url);
    if (!xml) continue;
    out = out.concat(parseRss(xml).map((e) => ({ ...e, src: "Yahoo " + f.label })));
  }
  return out;
}

function relevance(title, desc) {
  const text = (title + " " + desc).toLowerCase();
  let hits = 0;
  for (const k of KEYWORDS) if (text.includes(k)) hits++;
  return hits;
}

function freshSorted(list) {
  const now = Date.now();
  const seen = new Set();
  const out = [];
  for (const e of [...list].sort((a, b) => (b.pub || 0) - (a.pub || 0))) {
    const key = ((e.title || "").toLowerCase().replace(/\s+/g, " ")).slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rel = relevance(e.title, e.desc);
    // keep only items that actually look gold/macro related.
    // Yahoo feeds are broad business news - require strong signal there;
    // Google News queries are already gold-specific so relevance >=1 suffices.
    const age = now - (e.pub || 0);
    const yahoo = /^Yahoo/i.test(e.src);
    const keep = yahoo ? rel >= 2 || (rel >= 1 && age < 30 * 60 * 1000) : rel >= 1;
    if (keep) out.push(e);
    if (out.length >= 16) break;
  }
  return out;
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!c.items || !c.t) return null;
    if (Date.now() - c.t > CACHE_MAX_MS) return null;
    return c.items;
  } catch {
    return null;
  }
}

function writeCache(items) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ t: Date.now(), items }));
  } catch {
    /* cache is best-effort */
  }
}

// Public: getNews() -> { items, fromCache, ok, note, at }
async function getNews() {
  const cached = readCache();
  if (cached) return { items: freshSorted(cached), fromCache: true, ok: true, note: "cached", at: Date.now() };

  let items = [];
  items = await fetchYahoo(items);
  items = await fetchGoogle(items);
  items = freshSorted(items);

  if (items.length >= 2) {
    writeCache(items);
    return { items, fromCache: false, ok: true, note: "live", at: Date.now() };
  }

  // network failed - reuse a stale cache if any exists within a day
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (c.items && c.items.length && Date.now() - c.t < 24 * 3600 * 1000) {
        return { items: freshSorted(c.items), fromCache: true, ok: true, note: "stale-cache", at: Date.now() };
      }
    }
  } catch { /* noop */ }

  return { items: [], fromCache: false, ok: false, note: "unavailable", at: Date.now() };
}

module.exports = { getNews };