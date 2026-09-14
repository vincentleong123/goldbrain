"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    symbol: "XAUUSD",
    tf: "M1",
    bars: 300,
    mode: "expert",
    strat: "psych",
    running: false,
  };
  let analysis = null;
  let autoTimer = null;

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  const fmt = (n, d) => (n === null || n === undefined || !isFinite(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d ?? 2 }));
  const money = (n) => "$" + fmt(Math.round(n * 100) / 100);
  function pct(n, d) { return (n * 100).toFixed(d ?? 1) + "%"; }

  function persist(prefix) {
    try { localStorage[prefix + ":" + JSON.stringify(state[prefix])] = 1; } catch { /* noop */ }
  }
  function saveAccount() {
    const bal = parseFloat($("inpBal").value) || 1000;
    const rk = parseFloat($("inpRisk").value) || 1;
    const lv = parseFloat($("inpLev").value) || 500;
    try { localStorage.setItem("gb.account", JSON.stringify({ bal, rk, lv })); } catch {}
    return { bal, rk, lv };
  }
  function loadAccount() {
    try {
      const a = JSON.parse(localStorage.getItem("gb.account") || "null");
      if (a) {
        $("inpBal").value = a.bal;
        $("inpRisk").value = a.rk;
        $("inpLev").value = a.lv;
      }
    } catch {}
  }

  function qs() {
    const a = saveAccount();
    return `symbol=${state.symbol}&tf=${state.tf}&bars=${state.bars}&balance=${a.bal}&riskPct=${a.rk}&leverage=${a.lv}`;
  }

  async function load() {
    if (state.running) return;
    state.running = true;
    $("btnRefresh").disabled = true;
    document.body.style.cursor = "progress";
    try {
      const res = await fetch("/api/analysis?" + qs() + "&fresh=1");
      if (!res.ok) throw new Error("Server error " + res.status);
      analysis = await res.json();
      render();
    } catch (e) {
      alert("Load failed: " + e.message);
    } finally {
      state.running = false;
      $("btnRefresh").disabled = false;
      document.body.style.cursor = "";
    }
  }

  function render() {
    if (!analysis) return;
    renderTicker();
    renderModeTab();
    renderBacktest();
    GBChart.setData(analysis);
    const badge = $("srcBadge");
    badge.className = "badge " + (analysis.source === "demo" ? "warn" : analysis.source === "mt5" ? "ok" : "");
    badge.textContent = analysis.sourceLabel || analysis.source;
    let note = analysis.dataNote || (analysis.source === "yahoo-futures" ? "GC=F futures ~ tracks spot" : analysis.source === "demo" ? "DEMO - not real data" : "");
    $("updated").textContent = "refreshed " + new Date(analysis.generatedAt || Date.now()).toLocaleTimeString() + " · " + analysis.bars + " bars · model retrained";
    $("sess").textContent = note ? ` · ${analysis.session.name} (${analysis.session.note})` : analysis.session.name;
    $("sess").title = analysis.session.note;
  }

  function renderTicker() {
    const c = analysis.contract;
    $("px").textContent = fmt(c.price, 2);
    const chg = $("chg");
    chg.textContent = (c.changePct >= 0 ? "+" : "") + c.changePct.toFixed(3) + "%";
    chg.className = "chg " + (c.changePct > 0 ? "up" : c.changePct < 0 ? "down" : "flat");
    $("px").title = `Last bar: ${new Date(c.ts).toLocaleString()}\nPrev close: ${c.prevClose}`;
  }

  // ------------------------------------------------------------- modes UI
  const tabs = document.querySelectorAll(".mode-tab");
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      state.mode = t.dataset.mode;
      renderModeTab();
    })
  );

  const SENT_LABEL = { bullish: "up", bearish: "down", neutral: "side", warning: "warn", info: "info" };

  function renderModeTab() {
    const m = analysis && analysis.modes[state.mode];
    if (!m) { $("verdict").innerHTML = "<div class='v-summary'>Loading…</div>"; return; }
    const tone = SENT_LABEL[m.sentiment] || "info";
    let html = `<div class="v-title">${esc(m.title || state.mode)}</div>`;
    html += `<div class="v-headline ${tone}">${esc(m.headline)}</div>`;
    if (m.summary) html += `<div class="v-summary">${esc(m.summary)}</div>`;
    if (m.cards && m.cards.length) {
      html += '<div class="v-cards">';
      for (const c of m.cards) {
        html += `<div class="v-card"><div class="lbl">${esc(c.label)}</div><div class="val">${esc(c.value)}</div><div class="hint">${esc(c.hint || "")}</div></div>`;
      }
      html += "</div>";
    }
    if (m.bullets && m.bullets.length) {
      html += '<div class="v-bullets">';
      for (const b of m.bullets) {
        const d = { up: "up", down: "down", side: "side", info: "info", warn: "warn" }[b.tone] || "info";
        html += `<div class="v-bullet"><span class="dot ${d}"></span><span>${esc(b.text)}</span></div>`;
      }
      html += "</div>";
    }
    if (m.code) html += `<div class="v-code">${esc(m.code)}</div>`;
    if (m.levels) {
      const lv = Object.values(m.levels);
      if (lv.length) {
        html += '<div class="v-levels">';
        for (const l of lv) html += `<span class="level-chip">${esc(l.label)} <b>${fmt(l.price, 2)}</b></span>`;
        html += "</div>";
      }
    }
    if (m.warnings && m.warnings.length) {
      html += '<div class="v-warnings">';
      for (const w of m.warnings) html += `<div class="v-warning">⚠ ${esc(w)}</div>`;
      html += "</div>";
    }
    $("verdict").innerHTML = html;
  }

  // ------------------------------------------------------------- backtest
  function renderBacktest() {
    const bt = analysis && analysis.backtests && analysis.backtests[state.strat];
    if (!bt) return;
    const rows = [
      ["Trades", bt.trades],
      ["Win rate", pct(bt.winRate, 0)],
      ["Net P&L (0.1 lot)", money(bt.netUsd)],
      ["Profit factor", fmt(bt.profitFactor === Infinity ? "∞" : bt.profitFactor, 2)],
      ["Max drawdown", bt.maxDrawdown ? Math.round(bt.maxDrawdown * 100) + "%" : "0%"],
      ["Per trade avg", money(bt.avgPerTrade)],
      ["Avg hold", bt.avgBars + " bars"],
      ["Sharpe", fmt(bt.sharpe, 2)],
      ["Buy&hold", pct(bt.buyHoldReturn !== undefined ? bt.buyHoldReturn : 0, 1)],
    ];
    let html = rows.map(([l, v]) => `<div class="row"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join("");
    if (bt.extraStats && bt.extraStats.length) {
      for (const [l, v] of bt.extraStats) html += `<div class="row"><span>${esc(l)}</span><span>${esc(v)}</span></div>`;
    }
    if (bt.stageStats && bt.stageStats.length) {
      html += '<div class="row"><span style="color:var(--gold)">PER-STAGE RESULTS</span><span></span></div>';
      for (const s of bt.stageStats) {
        html += `<div class="row"><span>stage -${(s.stage * 100).toFixed(0)}% ATR</span><span>${s.trades} tr · WR ${(s.winRate * 100).toFixed(0)}% · $${s.net}</span></div>`;
      }
    }
    if (bt.sideStats && bt.sideStats.length) {
      html += '<div class="row"><span style="color:var(--gold)">PER-SIDE</span><span></span></div>';
      for (const s of bt.sideStats) {
        html += `<div class="row"><span>${esc(s.side)}</span><span>${s.trades} tr · WR ${Math.round(s.winRate * 100)}% · $${s.net}</span></div>`;
      }
    }
    if (bt.stageOdds && bt.stageOdds.length) {
      html += '<div class="row"><span style="color:var(--gold)">RECOVERY ODDS (held to stage)</span><span></span></div>';
      for (const s of bt.stageOdds) {
        if (!s.crossed) continue;
        html += `<div class="row"><span>$-stage ${(s.stage * 100).toFixed(0)}</span><span>${s.crossed} events · back to anchor: ${(s.recov5 * 100).toFixed(0)}%/5bar · ${(s.recov15 * 100).toFixed(0)}%/15bar</span></div>`;
      }
    }
    if (bt.lastTrades && bt.lastTrades.length) {
      html += '<div class="row"><span>Last trades</span><span>' +
        bt.lastTrades.map((t) => `${t.side[0].toUpperCase()}`).join(" · ") + '</span></div>';
    }
    html += `<div class="row"><span style="color:var(--dim)">${esc(bt.name || (bt.presetInfo ? bt.presetInfo.note : ""))}</span><span></span></div>`;
    $("eqStats").innerHTML = html;
    GBChart.setStrat(state.strat);
  }

  document.querySelectorAll(".strat-btns button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".strat-btns button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.strat = b.dataset.strat;
      renderBacktest();
    })
  );

  // ------------------------------------------------------------- controls
  ["selSymbol", "selTf", "selBars"].forEach((id) => {
    $(id).addEventListener("change", () => {
      state.symbol = $("selSymbol").value;
      state.tf = $("selTf").value;
      state.bars = parseInt($("selBars").value, 10) || 300;
      load();
    });
  });
  $("btnRefresh").addEventListener("click", load);
  $("btnAuto").addEventListener("click", () => {
    const on = $("btnAuto").classList.toggle("on");
    if (on) {
      autoTimer = setInterval(() => load(), 30000);
      $("btnAuto").textContent = "Auto live";
    } else {
      clearInterval(autoTimer);
      autoTimer = null;
      $("btnAuto").textContent = "Auto live";
    }
  });
  $("btnClearCache").addEventListener("click", async () => {
    await fetch("/api/analysis?" + qs() + "&fresh=1"); // warm the new cache
    load();
  });

  // CSV upload
  $("btnUpload").addEventListener("click", () => {
    $("csvModal").hidden = false;
  });
  $("btnCsvClose").addEventListener("click", () => { $("csvModal").hidden = true; });
  $("fileCsv").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("csvText").value = await f.text();
  });
  $("btnCsvGo").addEventListener("click", async () => {
    const text = $("csvText").value.trim();
    if (text.length < 50) { alert("Paste some CSV lines first."); return; }
    const res = await fetch(`/api/upload?symbol=${state.symbol}&tf=${state.tf}`, { method: "POST", body: text });
    const r = await res.json();
    if (r.ok) {
      alert(`Loaded ${r.bars} bars (${new Date(r.from).toLocaleDateString()} → ${new Date(r.to).toLocaleDateString()}). Now using uploaded CSV for ${state.symbol} ${state.tf}.`);
      $("csvModal").hidden = true;
      load();
    } else alert("CSV error: " + r.reason);
  });

  // ------------------------------------------------------------- boot
  loadAccount();
  GBChart.init($("chart"), $("indChart"), $("eqChart"));

  // pull latest spot quote every 10s while page open (cheap, no re-analysis)
  setInterval(async () => {
    if (!analysis || analysis.source === "csv" || analysis.source === "demo") return;
    if (document.hidden) return;
    try {
      const r = await fetch("/api/analysis?" + qs() + "&fresh=0");
      if (r.ok) {
        const a = await r.json();
        if (a.contract && a.contract.ts !== analysis.contract.ts) {
          analysis = a;
          render();
        }
      }
    } catch {}
  }, 10000);

  load();
})();