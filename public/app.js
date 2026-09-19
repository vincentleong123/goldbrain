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
      if (state.mode === "reasoner") {
        if (state.chatBusy) return;
        if (!state.reasoner && state.rezConfig && state.rezConfig.configured) runReasonerNow(false);
        else if (!state.reasoner && !(state.rezConfig && state.rezConfig.configured)) loadRezConfig().then(() => renderModeTab());
        else if (state.reasoner && state.rezConfig && state.rezConfig.configured && Date.now() - rezLoadedAt > 60000) runReasonerNow(false);
      }
    })
  );

  const SENT_LABEL = { bullish: "up", bearish: "down", neutral: "side", warning: "warn", info: "info" };

  function renderModeTab() {
    if (state.mode === "reasoner") { renderReasoner(); return; }
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

  // ------------------------------------------------------- Reasoner (AI thinking)
  const SENT2 = { long: "bullish", short: "bearish", flat: "neutral" };
  state.reasoner = null;
  state.rezConfig = null;
  state.rezRunning = false;
  let rezLoadedAt = 0;

  async function loadRezConfig() {
    try {
      const r = await fetch("/api/reasoner/config");
      if (r.ok) state.rezConfig = await r.json();
    } catch { state.rezConfig = null; }
  }

  function openRezModal() {
    const c = state.rezConfig || {};
    $("rezKey").value = c.configured ? "(saved)" : "";
    $("rezBase").value = c.baseURL && !/anthropic|openai/i.test(c.baseURL) ? c.baseURL : (c.baseURL || "");
    $("rezModel").value = c.model && !/gpt-4o-mini|claude-3-5-haiku/i.test(c.model) ? c.model : (c.model || "");
    $("rezMt5").value = c.mt5Files || "";
    $("rezModal").hidden = false;
  }

  function renderReasoner() {
    const rz = state.reasoner;
    const cfg = state.rezConfig;
    let html = `<div class="v-title">🧠 Reasoner · AI thinking on your snapshot</div>`;

    if (!cfg || !cfg.configured) {
      html += `<div class="v-headline warning">No AI provider configured yet.</div>`;
      html += `<div class="v-summary">The Reasoner reads your live chart snapshot + news headlines and REASONS to a decision (structure, retail-pain stage, session, risk budget). No prediction magic - honest reasoning, and 'flat' is a valid answer.<br><br>Set your own LLM key (OpenAI / DeepSeek / OpenRouter / Ollama / Anthropic). Stored locally in data/config.json.</div>`;
      html += `<button id="btnRezOpen" class="btn">Configure AI provider</button>`;
      $("verdict").innerHTML = html;
      $("btnRezOpen").addEventListener("click", openRezModal);
      return;
    }

    html += `<div class="v-headline ${SENT2[rz && rz.plan && rz.plan.direction] || 'info'}">${
      rz
        ? (rz.plan.direction === "flat" ? "STAY FLAT — " : rz.plan.direction.toUpperCase() + " bias ") + " · conviction " + Math.round((rz.plan.conviction || 0) * 100) + "%"
        : "Ready. Click think to analyse this snapshot."
    }</div>`;
    if (rz) {
      html += `<div class="v-summary">model ${esc(rz.model)} · ${(rz.ms / 1000).toFixed(1)}s · ${esc(rz.sourceLabel || "")} · news ${rz.newsUsed}</div>`;
    }

    html += '<div class="rez-actions">';
    html += `<button id="btnRezThink" class="btn" ${state.rezRunning ? "disabled" : ""}>${state.rezRunning ? "Thinking…" : (rz ? "Think again" : "🧠 Think now")}</button>`;
    html += `<button id="btnRezLearn" class="btn ghost">🎓 Learn the lingo</button>`;
    html += `<button id="btnRezSet" class="btn ghost">Settings</button>`;
    html += "</div>";

    if (rz && rz.ok === false) {
      html += `<div class="v-warning" style="margin-top:8px">⚠ ${esc(rz.message || rz.reason || "reasoner failed")}</div>`;
      if (rz.reason === "not-configured") html += `<div class="v-summary">Get a key from your provider and paste it here.</div>`;
    }

    if (rz && rz.plan) {
      const pl = rz.plan;
      if (pl.ok === false) {
        html += `<div class="v-warning" style="margin-top:8px">⚠ Plan rejected: ${esc(pl.reason)}</div>`;
      }
      if (pl.direction === "flat") {
        html += `<div class="v-summary">${esc(pl.reason && pl.reason[0] ? pl.reason.join(" · ") : "No edge found. The most profitable trade is often the one you don't take.")}</div>`;
      } else if (pl.ok) {
        if (pl.story) html += `<div class="rez-story"><span class="rez-story-tag">the AI read</span>${esc(pl.story)}</div>`;
        html += '<div class="v-cards">';
        html += `<div class="v-card"><div class="lbl">Entry</div><div class="val">${fmt(pl.entry, 2)}</div><div class="hint">market</div></div>`;
        html += `<div class="v-card"><div class="lbl">Stop</div><div class="val">${fmt(pl.stop, 2)}</div><div class="hint">hard, structural</div></div>`;
        html += `<div class="v-card"><div class="lbl">Target</div><div class="val">${fmt(pl.target, 2)}</div><div class="hint">level / RR ${fmt(pl.rr, 2)}</div></div>`;
        html += `<div class="v-card"><div class="lbl">Conviction</div><div class="val">${Math.round(pl.conviction * 100)}%</div><div class="hint">${esc(rz.confidence || "")}</div></div>`;
        html += '</div>';
        if (pl.sizeNote) html += `<div class="v-summary">Sizing: ${esc(pl.sizeNote)}</div>`;
      }
      if (pl.reason && pl.reason.length) {
        html += '<div class="v-bullets">';
        for (const b of pl.reason) html += `<div class="v-bullet"><span class="dot info"></span><span>${esc(b)}</span></div>`;
        html += "</div>";
      }
      if (pl.dominatedBy && pl.dominatedBy.length) {
        html += '<div class="v-levels">' + pl.dominatedBy.map((d) => `<span class="level-chip">${esc(d)}</span>`).join("") + "</div>";
      }
      if (pl.scenarioBull || pl.scenarioBase || pl.scenarioBear) {
        const sc = (lbl, tone, s) => s && typeof s === "object"
          ? `<div class="rez-scen ${tone}"><b>${lbl}:</b> ${esc(s.target !== undefined && s.target !== null ? s.target + " · " : "")}${esc(s.trigger || "")}</div>`
          : "";
        html += '<div class="v-summary" style="margin-top:6px">Scenarios</div>';
        html += sc("Bull", "up", pl.scenarioBull) + sc("Base", "info", pl.scenarioBase) + sc("Bear", "down", pl.scenarioBear);
      }
      if (pl.invalidation) html += `<div class="v-bullet"><span class="dot warn"></span><span><b>Invalid:</b> ${esc(pl.invalidation)}</span></div>`;
      if (pl.risks && pl.risks.length) {
        html += '<div class="v-warnings">';
        for (const w of pl.risks) html += `<div class="v-warning">⚠ ${esc(w)}</div>`;
        html += "</div>";
      }
    }

    if (rz && rz.warnings && rz.warnings.length) {
      html += '<div class="v-warnings" style="margin-top:8px">';
      for (const w of rz.warnings) html += `<div class="v-warning">⚠ ${esc(w)}</div>`;
      html += "</div>";
    }

    if (rz && rz.ok) html += `<div class="v-summary" style="font-size:11px">Reasoner = reasoning advisor, NOT a predictor and NOT an order sender. It writes data/reasoner-plan.json (advisory) for the EA. Verify with your own eyes. Generated ${new Date(rz.generatedAt).toLocaleTimeString()}.</div>`;

    if (cfg && cfg.configured) html += chatHtml();

    $("verdict").innerHTML = html;
    const think = $("btnRezThink");
    if (think) think.addEventListener("click", () => runReasonerNow(true));
    const set = $("btnRezSet");
    if (set) set.addEventListener("click", openRezModal);
    const learn = $("btnRezLearn");
    if (learn) learn.addEventListener("click", openLearn);
    bindChat();
  }

  // ------------------------------------------- learning deck (educational)
  function openLearn() {
    $("learnBody").innerHTML = learnDeckHtml();
    $("learnModal").hidden = false;
  }

  function learnDeckHtml() {
    const ind = (analysis && analysis.ind) || {};
    const pl = (state.reasoner && state.reasoner.plan) || {};
    const rows = [
      ["ATR - the volatility ruler", `Average candle range, the market's yardstick for "normal" movement. Today it reads $${fmt(ind.atr || 0, 2)}. Stops smaller than ~0.2 ATR are just noise; moves bigger than ~1.5 ATR are a big deal.`],
      ["Retail-pain stage", "The textbook stop zone where crowded trader positions get flushed (wicked) before price resumes. The Reasoner reads which stage gold is in right now and treats that flush distance as the real risk. That's why 'good' setups often need wide stops here."],
      ["Conviction", `How sure this AI read is, on a 0-1 scale (${Math.round((pl.conviction || 0) * 100)}% today). It is an OPINION distilled from structure + stage + session + headlines - never a guarantee. Below ~50% the EA ignores it on purpose.`],
      ["RR - reward/risk ratio", `How many dollars you are trying to win for every dollar you are prepared to lose (${pl.rr ? fmt(pl.rr, 2) : "n/a"} today). RR 2 means winning half the time keeps you even. The Reasoner skips setups under ~1.2.`],
      ["Entry / Stop / Target", "The planned road map: where to get in, the hard line where the idea is objectively wrong (stop), and the realistic destination (target). The EA only fires when price is within a small drift of the planned entry."],
      ["Invalidation", `The specific, concrete price condition that falsifies this plan today: ${esc(pl.invalidation || "see plan panel")}. Holding onto a trade past its invalidation is how good ideas become bad losses.`],
      ["Scenario bull / base / bear", "Three honest futures for the same setup - up case, drift base case, down case - each with a trigger. It keeps the AI honest by forcing it to write the failure story before it trades, not after."],
      ["Dominated by", "Which input had the biggest voice in this read - structure, stage, levels, session or news. All AIs quietly overweight their favourite input; naming it stops yours from lying to you."],
    ];
    return rows.map((r, i) => `<div class="learn-row"><b>${i + 1}. ${esc(r[0])}</b><div>${esc(r[1])}</div></div>`).join("");
  }

  // ------------------------------------------- Discovery chat (chat with the AI)
  state.chatHist = [];
  state.chatBusy = false;
  let chatLive = null;

  function chatHtml() {
    let h = '<div class="chat">';
    h += '<div class="chat-head">💬 Discovery · ask the AI teacher anything about this live snapshot</div>';
    h += '<div id="chatOut" class="chat-out">';
    for (const e of state.chatHist) {
      h += `<div class="chat-row"><div class="chat-q">${esc(e.q)}</div><div class="chat-a">${esc(e.a)}</div></div>`;
    }
    if (chatLive) h += `<div class="chat-row live"><div class="chat-q">${esc(chatLive.q)}</div><div class="chat-a typing" id="chatLiveA">…thinking</div></div>`;
    h += '</div>';
    h += '<div class="chat-in"><input id="chatQ" placeholder="Ask… e.g. teach me what conviction means" autocomplete="off" /><button id="chatSend" class="btn">Ask</button></div>';
    h += '<div class="chat-chips" id="chatChips"></div>';
    h += '</div>';
    return h;
  }

  function chatChips() {
    const pl = state.reasoner && state.reasoner.plan;
    const dir = pl && pl.direction === "long" ? "long" : (pl && pl.direction === "short" ? "short" : null);
    const c = [
      dir
        ? `Explain the case FOR going ${dir} in plain words`
        : "Explain this snapshot's structure in plain words",
      dir
        ? "Make the strongest argument AGAINST this plan"
        : "What is this snapshot saying about gold right now?",
      "What does ATR tell us about today's volatility?",
      "Quiz me: what does each number in this panel mean?",
      "What would make this analysis wrong? (falsification)",
    ];
    return c;
  }

  async function chatAsk(q) {
    if (state.chatBusy) return;
    state.chatBusy = true;
    chatLive = { q, text: "" };
    renderReasoner();
    const liveEl = $("chatLiveA");
    try {
      const r = await fetch("/api/reasoner/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q }),
      });
      if (!r.ok) {
        let msg = "Server " + r.status;
        try { const j = await r.json(); if (j.reason) msg = j.reason; } catch {}
        throw new Error(msg);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder("utf-8");
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chatLive.text += dec.decode(value, { stream: true });
        const el = $("chatLiveA");
        if (el) el.textContent = chatLive.text;
      }
    } catch (e) {
      chatLive.text += "\n[chat error: " + (e && e.message ? e.message : e) + "]";
      const el = $("chatLiveA");
      if (el) el.textContent = chatLive.text;
    }
    state.chatHist.push({ q: chatLive.q, a: chatLive.text.trim() });
    chatLive = null;
    state.chatBusy = false;
    renderReasoner();
    const qIn = $("chatQ");
    if (qIn) qIn.focus();
  }

  function bindChat() {
    const q = $("chatQ"), s = $("chatSend");
    if (!q || !s) return;
    const go = () => {
      const v = q.value.trim();
      if (!v || state.chatBusy) return;
      q.value = "";
      chatAsk(v);
    };
    s.addEventListener("click", go);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    const chipsBox = $("chatChips");
    if (chipsBox) {
      chipsBox.innerHTML = "";
      for (const c of chatChips()) {
        const b = document.createElement("button");
        b.className = "hint-chip";
        b.textContent = c;
        b.disabled = state.chatBusy;
        b.addEventListener("click", () => { q.value = c; go(); });
        chipsBox.appendChild(b);
      }
    }
  }

  async function runReasonerNow(force) {
    if (state.rezRunning) return;
    state.rezRunning = true;
    renderReasoner();
    try {
      const url = "/api/reasoner?" + qs() + (force ? "&force=1" : "");
      const r = await fetch(url);
      if (!r.ok) throw new Error("Server " + r.status);
      state.reasoner = await r.json();
      rezLoadedAt = Date.now();
      renderReasoner();
    } catch (e) {
      state.reasoner = { ok: false, reason: "fetch-error", message: e.message };
      renderReasoner();
    } finally {
      state.rezRunning = false;
    }
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

  $("btnRezClose").addEventListener("click", () => { $("rezModal").hidden = true; });
  $("btnLearnClose").addEventListener("click", () => { $("learnModal").hidden = true; });
  $("btnRezSave").addEventListener("click", async () => {
    let key = $("rezKey").value.trim();
    const c = state.rezConfig || {};
    if (key === "(saved)") key = c.configured ? "(keep-current-key)" : "";
    if (!key) { alert("Paste an API key (or keep '(saved)' and change base/model)."); return; }
    const body = JSON.stringify({
      apiKey: key,
      baseURL: $("rezBase").value.trim(),
      model: $("rezModel").value.trim(),
      mt5Files: $("rezMt5").value.trim(),
    });
    const r = await fetch("/api/reasoner/config", { method: "POST", headers: { "content-type": "application/json" }, body });
    const j = await r.json();
    if (j.ok) {
      state.rezConfig = j;
      $("rezModal").hidden = true;
      alert("Saved. Reasoner is ready - click 🧠 Think now.");
      renderModeTab();
    } else alert("Save failed: " + j.reason);
  });
  loadRezConfig();

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