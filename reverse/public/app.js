"use strict";
/* GoldBrain REVERSE - minimal dashboard. Zero dependencies. */
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct0 = (v) => (v === null || v === undefined || !isFinite(v) ? "–" : Math.round(v * 100) + "%");
const timeStr = (t) => {
  if (!t) return "–";
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let data = null;
let timer = null;

init();

function init() {
  $("refresh").onclick = () => load(true, false);
  $("aiplan").onclick = () => { $("aiplan").disabled = true; load(true, true).finally(() => { $("aiplan").disabled = false; }); };
  $("keys").onclick = () => { $("keyModal").hidden = false; };
  $("closeKey").onclick = () => { $("keyModal").hidden = true; };
  $("saveKey").onclick = async () => {
    try {
      const r = await fetch("/api/config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: $("llmKey").value, baseURL: $("llmBase").value, model: $("llmModel").value }),
      });
      const j = await r.json();
      $("saveKey").textContent = j.ok ? "Saved" : "Error";
      setTimeout(() => { $("saveKey").textContent = "Save"; $("keyModal").hidden = true; }, 900);
    } catch (e) { $("saveKey").textContent = "Failed"; }
  };
  for (const el of [$("tf"), $("bars"), $("balance"), $("risk")]) el.onchange = () => load(true, false);
  load(false, false);
  timer = setInterval(() => load(false, false), 45000);
}

async function load(force, wantAI) {
  try {
    const tf = $("tf").value, bars = $("bars").value;
    const q = `tf=${tf}&bars=${bars}&balance=${$("balance").value || 1000}&riskPct=${$("risk").value || 1}` + (force ? "&fresh=1" : "") + (wantAI || $("aiplan").dataset.ai === "1" ? "&ai=1" : "");
    if (wantAI) $("aiplan").dataset.ai = "1";
    const r = await fetch("/api/analysis?" + q);
    if (!r.ok) throw new Error((await r.json()).reason || r.status);
    data = await r.json();
    render();
  } catch (e) {
    $("updated").textContent = "error: " + String(e.message || e);
  }
}

function render() {
  if (!data) return;
  const d = data;
  $("px").textContent = fmt(d.price.last);
  const chg = d.price.changePct;
  $("chg").textContent = (chg >= 0 ? "+" : "") + fmt(chg * 100, 2) + "%";
  $("chg").style.color = chg >= 0 ? "var(--up)" : "var(--dn)";
  $("src").textContent = d.sourceLabel || d.source;
  $("struct").textContent = (d.struct && d.struct.label) ? "structure: " + d.struct.label : "";
  $("meta").textContent = `EURUSD ${fmt(d.price.eurUsd, 4)} · ATR ${fmt(d.ind.atr)} · RSI ${fmt(d.ind.rsi, 0)} · ${d.contract.note}`;
  $("updated").textContent = "updated " + new Date(d.generatedAt).toLocaleTimeString();

  drawChart(d);
  drawCurve(d);
  renderDstats(d);
  renderReverse(d);
  renderPlan(d);
  renderStrats(d);
  renderBook(d);
  prefillKeys();
}

function drawChart(d) {
  const cv = $("chart");
  const ctx = cv.getContext("2d");
  const cssW = cv.clientWidth || 800;
  const cssH = 340;
  cv.width = cssW * devicePixelRatio;
  cv.height = cssH * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cs = d.series.candles || [];
  if (cs.length < 2) return;
  let min = Infinity, max = -Infinity;
  for (const c of cs) { if (c.l < min) min = c.l; if (c.h > max) max = c.h; }
  const levels = [d.series.bench, d.reverse && d.reverse.entry, d.reverse && d.reverse.stop, d.reverse && d.reverse.target].filter((v) => isFinite(v));
  for (const l of levels) { min = Math.min(min, l); max = Math.max(max, l); }
  const pad = (max - min) * 0.08 || 1;
  min -= pad; max += pad;
  const w = cssW, h = cssH, L = 8;
  const X = (i) => L + (i / (cs.length - 1)) * (w - L - 46);
  const Y = (v) => h - 8 - ((v - min) / (max - min)) * (h - 16);
  const cw = Math.max(1.2, (w - L - 46) / cs.length * 0.6);

  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const up = c.c >= c.o;
    ctx.strokeStyle = up ? "#4ec07e" : "#e06a5a";
    ctx.fillStyle = up ? "rgba(78,192,126,.18)" : "rgba(224,106,90,.18)";
    const x = X(i);
    ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
    ctx.fillRect(x - cw / 2, Y(Math.max(c.o, c.c)), cw, Math.max(1.2, Math.abs(Y(c.o) - Y(c.c))));
  }

  // naive book markers (the victims)
  ctx.font = "11px monospace";
  for (const b of (d.naive.book || [])) {
    const idx = cs.findIndex((c) => c.t === b.t);
    const x = idx >= 0 ? X(idx) : X(cs.length - 1);
    const y = b.side === "L" ? Y(b.entry) + 4 : Y(b.entry) - 4;
    ctx.fillStyle = b.side === "L" ? "#5aa7e0" : "#c48a3c";
    ctx.fillText(b.side === "L" ? "▲" : "▼", x - 5, y);
  }

  // reverse bracket lines
  const rv = d.reverse;
  if (rv && rv.active) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#e0b45c"; ctx.lineWidth = 1.2;
    const mkV = (v, lbl) => { const y = Y(v); ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(w - 46, y); ctx.stroke(); ctx.fillStyle = "#e0b45c"; ctx.fillText(lbl, w - 42, y - 3); };
    mkV(rv.entry, "e"); mkV(rv.target, "T"); mkV(rv.stop, "S");
    ctx.setLineDash([]);
  }

  // right axis
  ctx.fillStyle = "#8b96a5"; ctx.font = "11px monospace";
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const v = min + ((max - min) * i) / steps;
    ctx.fillText(fmt(v), w - 40, Y(v) + 3);
    ctx.strokeStyle = "rgba(35,44,56,.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - 46, Y(v)); ctx.stroke();
  }
}

function drawCurve(d) {
  const cv = $("curve");
  const ctx = cv.getContext("2d");
  const cssW = cv.clientWidth || 400, cssH = 120;
  cv.width = cssW * devicePixelRatio;
  cv.height = cssH * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const curve = d.curve || [];
  if (!curve.length) {
    ctx.fillStyle = "#8b96a5"; ctx.fillText("collecting trials…", 10, 30); return;
  }
  const maxD = Math.max(...curve.map((g) => g.d));
  const X = (v) => 46 + (v / maxD) * (cssW - 70);
  const Y = (p) => cssH - 18 - p * (cssH - 24);
  ctx.strokeStyle = "#232c38";
  ctx.beginPath(); ctx.moveTo(46, Y(0)); ctx.lineTo(cssW - 24, Y(0)); ctx.stroke();
  // shaded risk zone
  if (isFinite(d.dCertain)) {
    const x = X(d.dCertain);
    ctx.fillStyle = "rgba(224,106,90,.10)";
    ctx.fillRect(x, 0, cssW - x, cssH);
    ctx.strokeStyle = "#e06a5a"; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#e06a5a"; ctx.font = "10px monospace";
    ctx.fillText("D-certain " + fmt(d.dCertain), x + 3, 12);
  }
  ctx.strokeStyle = "#5aa7e0"; ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((g, i) => { const x = X(g.d), y = Y(g.pRecover); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = "#8b96a5"; ctx.font = "10px monospace";
  ctx.fillText("recovery%", 6, 14);
  ctx.fillText(String(maxD) + "€", cssW - 34, cssH - 6);
}

function renderDstats(d) {
  const s = d.stats || {};
  const html = [
    ["median adv.", fmt(s.median) + "€", "dn"],
    ["p90 adv.", fmt(s.p90) + "€", "dn"],
    ["D-certain", fmt(d.dCertain) + "€", "acc"],
    ["D-100%", fmt(d.dZero) + "€", "acc"],
  ].map(([k, v, cls]) => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`).join("");
  $("dstats").innerHTML = html;
  $("dtrials").textContent = `${s.n || 0} resolved trial trades`;
  $("dnote").textContent = `0.01 lot = 1 oz, so €1 of loss = €1 of price move. The blue line = % of naive trades that get BACK to +d after hitting -d. After the D-certain floor it collapses.`;
}

function renderReverse(d) {
  $("rhState").textContent = d.reverse && d.reverse.active ? "ACTIVE" : "WAITING";
  const box = $("reverse");
  if (!d.reverse) {
    box.innerHTML = `<p class="wait">No naive trade has reached the liquidation zone yet. The reverse holds until a victim walks into it.</p>`;
    return;
  }
  const r = d.reverse;
  const frac = Math.min(100, r.victim.depthFrac || 0);
  const rows = `
    <div class="revrow"><span class="lbl">Action</span><span class="val ${r.active ? "flash" : ""}">${r.dirName}${r.active ? "" : " (not triggered)"}</span></div>
    <div class="revrow"><span class="lbl">Victim</span><span class="val"><span class="side-${r.victim.side}">${r.victim.side === "L" ? "LONG" : "SHORT"}</span> from ${timeStr(r.victim.t)} @ ${fmt(r.victim.entry)} · now ${fmt(r.victim.float)}€</span></div>
    <div class="revrow"><span class="lbl">Entry</span><span class="val">${fmt(r.entry)}</span><span class="lbl">→ Target / bench</span><span class="val">${fmt(r.target)}</span></div>
    <div class="revrow"><span class="lbl">Buffer stop</span><span class="val">${fmt(r.stop)}</span><span class="lbl">R/R</span><span class="val">${fmt(r.rr)}</span></div>
    <div class="revrow"><span class="lbl">Depth vs D-certain</span><span class="val">${frac}%</span></div>
  `;
  box.innerHTML = rows + `<div class="meter"><div style="width:${frac}%;${frac >= 40 ? "background:linear-gradient(90deg,#e0b45c,#e06a5a)" : ""}"></div></div>` + `<p class="tiny">${r.note}<br/><br/>Invalidation: ${r.invalidation}</p>`;
}

function renderPlan(d) {
  const p = d.aiPlan || {};
  $("planSrc").textContent = p.source === "llm" ? "LLM" : "local";
  const box = $("aiplan");
  if (!p.ok) { box.innerHTML = `<p class="wait">plan unavailable</p>`; return; }
  box.innerHTML = `
    <p><span class="tag">IDEA ·</span> ${p.idea}</p>
    <p><span class="tag">HOLD ·</span> ${p.hold}</p>
    <p><span class="tag">BRACKET ·</span> ${p.bracket}</p>
    <p><span class="tag">INVALID ·</span> ${p.invalidation}</p>
    <p class="story">${p.story}</p>
    <p class="metrics">${p.metrics ? p.metrics.strategies : "-"}\n${p.metrics ? p.metrics.flow : ""}</p>
  `;
}

function renderStrats(d) {
  const trades = (d.strategies && d.strategies.trades) || [];
  const sims = (d.strategies && d.strategies.sims) || {};
  const sum = Object.keys(sims).map((k) => `${k} ${sims[k].trades}t · ${pct0(sims[k].winRate)} · ${fmt(sims[k].net)}€`).join("   ");
  $("stratSim").textContent = sum;
  const head = `<tr><th>Strat</th><th>Dir</th><th>Open</th><th>Entry €</th><th>Stop</th><th>Target</th><th>R</th><th>Est €</th></tr>`;
  const rows = trades.map((t) => `
    <tr>
      <td>${t.stratLabel}</td>
      <td class="side-${t.side}">${t.side}</td>
      <td>${timeStr(t.t)}</td>
      <td>${fmt(t.entry)}</td><td>${fmt(t.stop)}</td><td>${fmt(t.target)}</td><td>${fmt(t.rr)}</td>
      <td class="pnl${t.pnl > 0 ? "P" : t.pnl < 0 ? "N" : "F"}">${t.pnl > 0 ? "+" : ""}${fmt(t.pnl)}</td>
    </tr>
    <tr><td colspan="8" class="reason">${t.reason}</td></tr>`).join("");
  $("stratTable").innerHTML = head + rows;
}

function renderBook(d) {
  const book = (d.naive && d.naive.book) || [];
  const head = `<tr><th>Side</th><th>Opened</th><th>Entry €</th><th>Float €</th><th>% of D</th></tr>`;
  const rows = book.map((b) => `
    <tr>
      <td class="side-${b.side}">${b.side}</td>
      <td>${timeStr(b.t)}</td>
      <td>${fmt(b.entry)}</td>
      <td class="pnl${b.float > 0 ? "P" : b.float < 0 ? "N" : "F"}">${b.float > 0 ? "+" : ""}${fmt(b.float)}</td>
      <td>${b.depthFrac !== null && b.depthFrac !== undefined ? b.depthFrac + "%" : "–"}</td>
    </tr>`).join("");
  $("bookTable").innerHTML = head + rows + (book.length ? "" : `<tr><td colspan="5" class="tiny">no active naive trades yet (needs price to move ≥1.2 ATR in 2-3 bars)</td></tr>`);
}

async function prefillKeys() {
  if ($("llmKey").value) return;
  try {
    const r = await fetch("/api/config");
    const j = await r.json();
    if (j.llm && j.llm.configured) {
      $("llmKey").placeholder = "key stored (current: " + (j.llm.model || "?") + ")";
    }
  } catch { /* ignore */ }
}