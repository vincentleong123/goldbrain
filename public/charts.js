"use strict";
// Custom canvas renderer: candlesticks, overlays, S/R lines, pattern markers,
// crosshair, pan/zoom, plus the RSI/AI and equity sub-charts. Zero libs.
(function () {
  const C = {
    up: "#22c55e", down: "#ef4444", grid: "#1a2430", ema20: "#38bdf8", ema50: "#e879f9",
    bb: "#31404d", vwap: "#f0b90b", supp: "rgba(34,197,94,0.55)", res: "rgba(239,68,68,0.55)",
    txt: "#7f8c96", gold: "#f0b90b", ai: "#f0b90b", rsi: "#38bdf8",
  };

  const view = { start: 0, len: 0, hover: -1, drag: null };
  let data = null;
  let activeStrat = "hybrid";
  let canvases = {};

  function prep(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(40, r.width);
    const h = Math.max(40, r.height);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function indexOfTime(t, arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t === t) return i;
    return -1;
  }

  function sliceRange() {
    const total = data ? data.series.candles.length : 0;
    const start = Math.max(0, Math.min(view.start, total - view.len));
    const len = Math.min(view.len, total - start);
    return { start, end: start + len, total };
  }

  function drawMain() {
    if (!data) return;
    const { ctx, w, h } = prep(canvases.main);
    ctx.clearRect(0, 0, w, h);
    const candles = data.series.candles;
    const total = candles.length;
    if (!total) return;
    // ensure sane view
    if (view.len <= 0) view.len = total;
    const { start, end } = sliceRange();
    const px = view.visible ? view.visible : { start, end };

    let pmin = Infinity, pmax = -Infinity;
    for (let i = start; i < end; i++) {
      pmin = Math.min(pmin, candles[i].l);
      pmax = Math.max(pmax, candles[i].h);
    }
    const pad = (pmax - pmin) * 0.06 || 1;
    pmin -= pad; pmax += pad;
    const plotH = h - 28, plotW = w - 66;
    const lo = 24, top = 12;
    const X = (i) => lo + ((i - start) / Math.max(end - start, 1)) * plotW;
    const Y = (p) => top + ((pmax - p) / (pmax - pmin || 1)) * plotH;

    // grid + y labels
    ctx.lineWidth = 1;
    const yTicks = 6;
    ctx.font = "10px system-ui";
    ctx.fillStyle = C.txt;
    for (let k = 0; k <= yTicks; k++) {
      const g = pmin + ((pmax - pmin) * k) / yTicks;
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(lo, Y(g)); ctx.lineTo(w - 4, Y(g)); ctx.stroke();
      ctx.fillText(g.toFixed(2), w - 22, Y(g) + 3);
    }
    // time labels
    ctx.strokeStyle = C.grid;
    const xTicks = Math.max(3, Math.floor(plotW / 90));
    for (let k = 0; k <= xTicks; k++) {
      const i = start + Math.floor((k * (end - start - 1)) / xTicks);
      const t = new Date(candles[i].t);
      const lbl = t.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      ctx.fillText(lbl, X(i) - 24, h - 8);
    }

    // early-move range band (last min(len, ~22) bars of the view)
    const em = data.early;
    if (em && isFinite(em.rangeHigh) && isFinite(em.rangeLow)) {
      const nBand = Math.min(end - start, 22);
      const bs = end - nBand;
      ctx.fillStyle = "rgba(240,185,11,0.06)";
      ctx.fillRect(X(bs), Y(em.rangeHigh), X(end) - X(bs), Y(em.rangeLow) - Y(em.rangeHigh));
      ctx.strokeStyle = "rgba(240,185,11,0.25)";
      ctx.beginPath(); ctx.moveTo(X(bs), Y(em.rangeHigh)); ctx.lineTo(X(end), Y(em.rangeHigh));
      ctx.moveTo(X(bs), Y(em.rangeLow)); ctx.lineTo(X(end), Y(em.rangeLow)); ctx.stroke();
    }

    // bollinger bands
    line(ctx, data.series.bbUpper, start, end, X, Y, C.bb, [4, 4], 1);
    line(ctx, data.series.bbLower, start, end, X, Y, C.bb, [4, 4], 1);

    // ema overlays
    line(ctx, data.series.ema20, start, end, X, Y, C.ema20, [], 1.4);
    line(ctx, data.series.ema50, start, end, X, Y, C.ema50, [], 1.4);
    line(ctx, data.series.vwap, start, end, X, Y, C.vwap, [2, 3], 1);

    // support/resistance lines
    if (data.sr) {
      for (const s of data.sr.supports || []) hLine(ctx, Y(s.price), C.supp, w);
      for (const r of data.sr.resistances || []) hLine(ctx, Y(r.price), C.res, w);
    }

    // candles
    const bw = Math.max(1.5, Math.min(11, (plotW / Math.max(end - start, 1)) * 0.68));
    for (let i = start; i < end; i++) {
      const c = candles[i];
      const up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
      ctx.lineWidth = 1;
      const x = X(i);
      ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
      const yo = Y(c.o), yc = Y(c.c);
      if (Math.abs(yc - yo) < 1) ctx.fillRect(x - bw / 2, yo - 0.6, bw, 1.2);
      else ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    }

    // pattern markers
    if (data.patterns && data.patterns.recent) {
      for (const p of data.patterns.recent) {
        if (!p || !p.dir || p.dir === "side") continue;
        const i = indexOfTime(p.t, candles);
        if (i < start || i >= end) continue;
        const x = X(i);
        const c = candles[i];
        ctx.fillStyle = p.dir === "up" ? C.up : C.down;
        if (p.dir === "up") {
          ctx.beginPath();
          ctx.moveTo(x, Y(c.h) - 6); ctx.lineTo(x - 4, Y(c.h) - 11); ctx.lineTo(x + 4, Y(c.h) - 11);
          ctx.closePath(); ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(x, Y(c.l) + 6); ctx.lineTo(x - 4, Y(c.l) + 11); ctx.lineTo(x + 4, Y(c.l) + 11);
          ctx.closePath(); ctx.fill();
        }
        ctx.font = "9px system-ui"; ctx.fillStyle = C.txt;
        ctx.fillText(p.name.split("_").join(" ").slice(0, 12), x - 14, p.dir === "up" ? Y(c.h) - 13 : Y(c.l) + 17);
      }
    }
    if (em && em.ignition !== "none") {
      ctx.fillStyle = C.gold;
      ctx.font = "bold 11px system-ui";
      const li = candles.length - 1;
      ctx.fillText("⚡ " + em.ignition.toUpperCase() + " START", X(li) - 20, top + 8);
    }

    // last price line + flag
    const li = candles.length - 1;
    const lp = candles[li].c;
    hLine(ctx, Y(lp), "rgba(240,185,11,0.35)", w, [3, 3]);
    ctx.fillStyle = C.gold;
    ctx.fillText(lp.toFixed(2), w - 46, Y(lp) - 3);

    // crosshair
    const hov = view.hover;
    if (hov >= start && hov < end) {
      const c = candles[hov];
      const x = X(hov);
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lo, Y(c.c)); ctx.lineTo(w - 4, Y(c.c)); ctx.stroke();
      const txt = `${c.o.toFixed(2)}  H=${c.h.toFixed(2)}  L=${c.l.toFixed(2)}  C=${c.c.toFixed(2)}`;
      ctx.fillStyle = "rgba(10,14,18,0.85)";
      ctx.fillRect(lo, top, ctx.measureText(txt).width + 12, 17);
      ctx.fillStyle = "#d7e0e8";
      ctx.fillText(txt, lo + 6, top + 12);
    }

    // legend
    if (start === 0) {
      ctx.font = "10px system-ui";
      let lx = lo;
      const leg = [["EMA20", C.ema20], ["EMA50", C.ema50], ["VWAP", C.vwap], [`AI P(up) ${aiNow()}`, C.gold]];
      for (const [t, col] of leg) {
        ctx.fillStyle = col; ctx.fillRect(lx, top + 26, 9, 2);
        ctx.fillStyle = C.txt; ctx.fillText(t, lx + 12, top + 30);
        lx += ctx.measureText(t).width + 34;
      }
    }
  }

  function aiNow() {
    if (data && data.ai && data.ai.verdict) return (data.ai.verdict.probUp * 100).toFixed(0) + "%";
    return "–";
  }

  function line(ctx, arr, start, end, X, Y, col, dash, width) {
    if (!arr) return;
    ctx.strokeStyle = col; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      const v = arr[i];
      if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
      if (!started) { ctx.moveTo(X(i), Y(v)); started = true; }
      else ctx.lineTo(X(i), Y(v));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function hLine(ctx, y, col, w, dash) {
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(dash || [8, 4]);
    ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(w - 4, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawInd() {
    if (!data) return;
    const { ctx, w, h } = prep(canvases.ind);
    ctx.clearRect(0, 0, w, h);
    const candles = data.series.candles;
    const total = candles.length;
    if (!total) return;
    const { start, end } = sliceRange();
    const lo = 24, top = 12, plotW = w - 66, plotH = h - 24;
    const X = (i) => lo + ((i - start) / Math.max(end - start, 1)) * plotW;
    const Y = (v) => top + (1 - v / 100) * plotH;
    ctx.strokeStyle = C.grid;
    for (const g of [0, 30, 50, 70, 100]) {
      ctx.beginPath(); ctx.moveTo(lo, Y(g)); ctx.lineTo(w - 4, Y(g)); ctx.stroke();
    }
    ctx.fillStyle = C.txt; ctx.font = "9px system-ui";
    ctx.fillText("RSI 30/70 + AI P(up)%", lo, top + 8);
    ctx.fillText("30", w - 22, Y(30) + 3); ctx.fillText("70", w - 22, Y(70) + 3);
    line(ctx, data.series.rsi, start, end, X, Y, C.rsi, [], 1.2);
    if (data.ai && data.ai.trace && data.ai.trace.length > 2) {
      const map = [];
      for (const tr of data.ai.trace) map.push({ t: tr.t, p: tr.p * 100 });
      // draw over the visible range: find by time
      ctx.strokeStyle = C.ai; ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      const idxt = (t) => indexOfTime(t, candles);
      for (const tr of map) {
        const i = idxt(tr.t);
        if (i < start || i >= end) continue;
        if (!started) { ctx.moveTo(X(i), Y(tr.p)); started = true; }
        else ctx.lineTo(X(i), Y(tr.p));
      }
      ctx.stroke();
    }
    const hov = view.hover;
    if (hov >= start && hov < end) {
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath(); ctx.moveTo(X(hov), top); ctx.lineTo(X(hov), top + plotH); ctx.stroke();
    }
  }

  function drawEq() {
    if (!data) return;
    const { ctx, w, h } = prep(canvases.eq);
    ctx.clearRect(0, 0, w, h);
    const bt = data.backtests && data.backtests[activeStrat];
    if (!bt || !bt.equitySeries || !bt.equitySeries.length) {
      ctx.fillStyle = C.txt; ctx.fillText("Run a backtest first", 30, 20);
      return;
    }
    const s = bt.equitySeries;
    let lo = s[0], hi = s[0];
    for (const v of s) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad; hi += pad;
    const X = (i) => 32 + (i / (s.length - 1 || 1)) * (w - 52);
    const Y = (v) => 14 + ((hi - v) / (hi - lo)) * (h - 40);
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(32, Y(bt.equityStart)); ctx.lineTo(w - 20, Y(bt.equityStart)); ctx.stroke();
    ctx.strokeStyle = C.gold; ctx.lineWidth = 1.6; ctx.beginPath();
    s.forEach((v, i) => { if (i === 0) ctx.moveTo(X(i), Y(v)); else ctx.lineTo(X(i), Y(v)); });
    ctx.stroke();
    ctx.fillStyle = C.txt; ctx.font = "9px system-ui";
    ctx.fillText(bt.strategy.toUpperCase() + "  equity", 32, 11);
    const lastV = s[s.length - 1];
    ctx.fillStyle = lastV >= bt.equityStart ? C.up : C.down;
    ctx.fillText("$" + lastV.toFixed(0), w - 60, Y(lastV) - 3);
  }

  // ------------------------------------------------ interaction
  function init(mainCv, indCv, eqCv) {
    canvases.main = mainCv; canvases.ind = indCv; canvases.eq = eqCv;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(mainCv.parentElement);
    ro.observe(indCv.parentElement);
    ro.observe(eqCv.parentElement);

    mainCv.addEventListener("mousemove", (e) => {
      const r = mainCv.getBoundingClientRect();
      const { start, end } = sliceRange();
      if (view.drag) {
        const dxPerBar = r.width / Math.max(end - start, 1);
        const dBars = Math.round((view.drag.ox - e.clientX) / dxPerBar);
        view.start = view.drag.s0 + dBars;
        view.start = Math.max(0, Math.min(view.start, data.series.candles.length - view.len));
        redraw();
        return;
      }
      const i = start + Math.floor(((e.clientX - r.left - 24) / Math.max(r.width - 66, 1)) * (end - start));
      view.hover = Math.max(start, Math.min(end - 1, i));
      redraw();
    });
    mainCv.addEventListener("mouseleave", () => { view.hover = -1; redraw(); });
    mainCv.addEventListener("mousedown", (e) => {
      const r = mainCv.getBoundingClientRect();
      view.drag = { ox: e.clientX, oy: e.clientY, s0: view.start };
    });
    window.addEventListener("mouseup", () => { view.drag = null; });
    mainCv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = mainCv.getBoundingClientRect();
      const frac = (e.clientX - r.left) / r.width;
      const { start, end, total } = sliceRange();
      const pointIdx = start + frac * (end - start);
      const f = e.deltaY > 0 ? 1.16 : 0.86;
      let nlen = Math.round(view.len * f);
      nlen = Math.max(24, Math.min(total, nlen));
      const fracP = (pointIdx - start) / view.len;
      view.start = Math.min(total - nlen, Math.max(0, Math.round(pointIdx - fracP * nlen)));
      view.len = nlen;
      redraw();
    }, { passive: false });
  }

  function redraw() { drawMain(); drawInd(); drawEq(); }

  function setData(d) {
    data = d;
    view.len = d.series.candles.length;
    view.start = 0;
    view.hover = -1;
    redraw();
  }
  function setStrat(s) { activeStrat = s; drawEq(); }
  function setViewLen(len) {
    view.len = Math.max(24, Math.min(data.series.candles.length, len));
    view.start = Math.max(0, data.series.candles.length - view.len);
    redraw();
  }

  window.GBChart = { init, setData, setStrat, setViewLen, redraw, view };
})();