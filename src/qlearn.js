"use strict";
const { atr, rsi, macd, ema, bollinger } = require("./indicators");
const { std, mean } = require("./mta");

const QFEAT = [
  "ret1", "ret3", "ret6", "ret12", "rsi14", "bodyPct", "lowerWick", "upperWick", "bbPos",
  "macdHist", "emaSpeed", "atrPct", "volZ", "slope8", "lastDir", "hourSin", "hourCos",
  "vwapDist", "squeeze", "pos10", "rsiAccel", "bullRun", "proxSup", "proxRes",
];

function buildFeatures(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const r = rsi(closes, 14);
  const macdRes = macd(closes, 12, 26, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const bb = bollinger(closes, 20, 2);
  const a = atr(candles, 14);
  const vwap = [];
  {
    let s = 0, v = 0;
    for (let i = 0; i < n; i++) {
      const tc = (candles[i].h + candles[i].l + candles[i].c) / 3;
      s += tc * (candles[i].v || 1);
      v += (candles[i].v || 1);
      vwap.push(v ? s / v : candles[i].c);
    }
  }
  const volZ = new Array(n).fill(0);
  for (let i = 23; i < n; i++) {
    const w = [];
    for (let j = i - 23; j <= i; j++) w.push(candles[j].v || 0);
    const m = mean(w);
    const sd = std(w, m);
    volZ[i] = sd === 0 ? 0 : ((candles[i].v || 0) - m) / sd;
  }
  const bw = new Array(n).fill(0);
  for (let i = 19; i < n; i++) {
    const up = bb.upper[i], lo = bb.lower[i];
    bw[i] = up && lo && isFinite(up) && isFinite(lo) ? (up - lo) / candles[i].c : 0;
  }
  const bwz = new Array(n).fill(0);
  for (let i = 30; i < n; i++) {
    const w = bw.slice(i - 30, i + 1);
    const m = mean(w);
    const sd = std(w, m);
    bwz[i] = sd === 0 ? 0 : (bw[i] - m) / sd;
  }
  const rows = [];
  for (let i = 30; i < n; i++) {
    const c = candles[i];
    const rng = c.h - c.l || 1e-9;
    const f = {};
    f.ret1 = (c.c - candles[i - 1].c) / c.c;
    f.ret3 = (c.c - candles[i - 3].c) / c.c;
    f.ret6 = (c.c - candles[i - 6].c) / c.c;
    f.ret12 = (c.c - candles[i - 12].c) / c.c;
    f.rsi14 = (r[i] || 50) / 100;
    f.bodyPct = Math.abs(c.c - c.o) / rng;
    f.lowerWick = (Math.min(c.o, c.c) - c.l) / rng;
    f.upperWick = (c.h - Math.max(c.o, c.c)) / rng;
    f.bbPos = isFinite(bb.upper[i]) && isFinite(bb.lower[i])
      ? Math.min(1, Math.max(0, (c.c - bb.lower[i]) / ((bb.upper[i] - bb.lower[i]) || 1e-9))) : 0.5;
    f.macdHist = (macdRes.hist[i] || 0) / (c.c || 1);
    f.emaSpeed = isFinite(e20[i]) && isFinite(e50[i]) ? e20[i] / e50[i] - 1 : 0;
    f.atrPct = isFinite(a[i]) ? a[i] / c.c : 0.001;
    f.volZ = Math.min(3, Math.max(-3, volZ[i]));
    f.slope8 = isFinite(a[i]) ? slope(closes, 8, i) / Math.max(a[i], 1e-9) : 0;
    f.lastDir = candles[i - 1].c > candles[i - 1].o ? 1 : -1;
    const dt = new Date(candles[i].t);
    const hr = ((dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 1440) * 2 * Math.PI;
    f.hourSin = Math.sin(hr);
    f.hourCos = Math.cos(hr);
    f.vwapDist = isFinite(vwap[i]) && isFinite(a[i]) ? (c.c - vwap[i]) / Math.max(a[i], 1e-9) : 0;
    f.squeeze = bwz[i] || 0;
    const k10 = candles.slice(i - 10, i + 1);
    const lo10 = Math.min(...k10.map((k) => k.l));
    const hi10 = Math.max(...k10.map((k) => k.h));
    f.pos10 = hi10 > lo10 ? (c.c - lo10) / (hi10 - lo10) : 0.5;
    f.rsiAccel = ((r[i] || 50) - (r[i - 3] || 50)) / 100;
    let bu = 0;
    for (let k = i - 5; k <= i; k++) if (candles[k].c > candles[k].o) bu++;
    f.bullRun = bu / 6;
    const win = candles.slice(i - 20, i);
    const at = Math.max(a[i] || 1e-9, 1e-9);
    const sups = win.filter((k) => k.l <= c.c).map((k) => k.l);
    const ress = win.filter((k) => k.h >= c.c).map((k) => k.h);
    const su = sups.length ? Math.max(...sups) : c.c - at * 1.2;
    const re = ress.length ? Math.min(...ress) : c.c + at * 1.2;
    f.proxSup = (c.c - su) / at;
    f.proxRes = (re - c.c) / at;
    rows.push({ i, t: c.t, f });
  }
  return rows;
}

function slope(arr, w, i) {
  const a = arr.slice(i - w + 1, i + 1);
  const m = w / 2 - 0.5;
  let num = 0, den = 0;
  for (let k = 0; k < w; k++) {
    num += (k - m) * (a[k] - mean(a));
    den += (k - m) * (k - m);
  }
  return den === 0 ? 0 : num / den;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function bondShape(d, B) {
  const nk = new Array(d + 1);
  nk[0] = 1;
  for (let k = 1; k < d; k++) nk[k] = B;
  nk[d] = 1;
  return nk;
}

function mpsParams(d, B) {
  const nk = bondShape(d, B);
  const W = [];
  for (let k = 0; k < d; k++) {
    const p = nk[k] * nk[k + 1] * 2;
    for (let i = 0; i < p; i++) W.push((Math.random() - 0.5) * 0.3);
  }
  return Float64Array.from(W);
}

function mpsScore(W, x, B) {
  const d = x.length;
  const nk = bondShape(d, B);
  let o = 0;
  let v = new Float64Array(1);
  v[0] = 1;
  for (let k = 0; k < d; k++) {
    const n0 = nk[k], n1 = nk[k + 1];
    const cbW = o, cwW = o + n0 * n1;
    const nv = new Float64Array(n1);
    for (let j = 0; j < n1; j++) {
      let s = 0;
      for (let i = 0; i < n0; i++) {
        s += v[i] * (W[cbW + i * n1 + j] + x[k] * W[cwW + i * n1 + j]);
      }
      nv[j] = s;
    }
    v = nv;
    o += 2 * n0 * n1;
  }
  return v[0];
}

function mpsBackprop(W, x, dl, B, into) {
  const d = x.length;
  const nk = bondShape(d, B);
  const vs = [new Float64Array(1)];
  vs[0][0] = 1;
  let o = 0;
  for (let k = 0; k < d; k++) {
    const n0 = nk[k], n1 = nk[k + 1];
    const cbW = o, cwW = o + n0 * n1;
    const nv = new Float64Array(n1);
    for (let j = 0; j < n1; j++) {
      let s = 0;
      for (let i = 0; i < n0; i++) s += vs[k][i] * (W[cbW + i * n1 + j] + x[k] * W[cwW + i * n1 + j]);
      nv[j] = s;
    }
    vs.push(nv);
    o += 2 * n0 * n1;
  }
  let g = new Float64Array(1);
  g[0] = dl;
  for (let k = d - 1; k >= 0; k--) {
    const n0 = nk[k], n1 = nk[k + 1];
    o -= 2 * n0 * n1;
    const cbW = o, cwW = o + n0 * n1;
    for (let i = 0; i < n0; i++) {
      for (let j = 0; j < n1; j++) {
        const ga = vs[k][i] * g[j];
        into[cbW + i * n1 + j] += ga;
        into[cwW + i * n1 + j] += ga * x[k];
      }
    }
    const gv = new Float64Array(n0);
    for (let i = 0; i < n0; i++) {
      let s = 0;
      for (let j = 0; j < n1; j++) s += (W[cbW + i * n1 + j] + x[k] * W[cwW + i * n1 + j]) * g[j];
      gv[i] = s;
    }
    g = gv;
  }
}

function trainMps(X, Y, B, lr, l2, epochs) {
  const d = X[0].length;
  let W = mpsParams(d, B);
  const m = new Float64Array(W.length);
  const v = new Float64Array(W.length);
  const gsum = new Float64Array(W.length);
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
  for (let e = 0; e < epochs; e++) {
    const bt = 1 - Math.pow(beta1, e + 1);
    const vt = 1 - Math.pow(beta2, e + 1);
    gsum.fill(0);
    for (let s = 0; s < X.length; s++) {
      const x = X[s];
      const z = mpsScore(W, x, B);
      const p = sigmoid(z);
      mpsBackprop(W, x, p - Y[s], B, gsum);
    }
    for (let i = 0; i < W.length; i++) {
      const gi = gsum[i] / X.length + l2 * W[i];
      m[i] = beta1 * m[i] + (1 - beta1) * gi;
      v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
      W[i] -= lr * (m[i] / bt) / (Math.sqrt(v[i] / vt) + eps);
    }
  }
  return W;
}

function predictMps(W, x, B) { return sigmoid(mpsScore(W, x, B)); }

function logisticBaseline(X, Y) {
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  const lr = 0.5, iters = 200, lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    let gb = 0;
    for (let s = 0; s < X.length; s++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[s][j];
      const p = sigmoid(z);
      const err = p - Y[s];
      for (let j = 0; j < d; j++) g[j] += err * X[s][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / X.length + lambda * w[j]);
    b -= lr * (gb / X.length);
  }
  return {
    predict(x) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      return sigmoid(z);
    },
  };
}

function accOf(preds, Y) {
  let hits = 0;
  for (let i = 0; i < preds.length; i++) if ((preds[i] >= 0.5 ? 1 : 0) === Y[i]) hits++;
  return Y.length ? hits / Y.length : 0.5;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function eaSearch(rows, label, gen = 10, pop = 20, rng) {
  const d = QFEAT.length;
  const evalRows = rows.length > 300 ? rows.slice(-300) : rows;
  const target = evalRows.map((r) => r[label]);
  let pool = [];
  for (let p = 0; p < pop; p++) {
    const mask = new Array(d).fill(0);
    for (let i = 0; i < d; i++) if (rng() < 0.35) mask[i] = 1;
    if (mask.reduce((a, b) => a + b, 0) < 4) mask[(rng() * d) | 0] = 1;
    pool.push(mask);
  }
  const factors = {};
  const fitnessOf = (mask) => {
    const keyM = mask.join("");
    if (factors[keyM] !== undefined) return factors[keyM];
    const feats = QFEAT.filter((_, i) => mask[i]);
    const stats = {};
    for (const k of feats) {
      const vals = evalRows.map((r) => r.f[k]);
      const m = mean(vals);
      stats[k] = { m, s: std(vals, m) || 1e-9 };
    }
    const toXk = (r) => feats.map((k) => (r.f[k] - stats[k].m) / stats[k].s);
    const split = Math.floor(evalRows.length * 0.85);
    const Xtr = evalRows.slice(0, split).map(toXk);
    const Ytr = target.slice(0, split);
    const base = logisticBaseline(Xtr, Ytr);
    const preds = evalRows.slice(split).map((r) => base.predict(toXk(r)));
    const fit = accOf(preds, target.slice(split)) - 0.5;
    factors[keyM] = fit;
    return fit;
  };
  const bestMasks = [];
  for (let g = 0; g < gen; g++) {
    const ranked = pool.map((mask) => ({ mask, fit: fitnessOf(mask) })).sort((a, b) => b.fit - a.fit);
    const elite = ranked.slice(0, Math.max(2, Math.floor(pop * 0.2)));
    bestMasks.push(...elite.slice(0, 2).map((e) => e.mask.slice()));
    const next = elite.map((e) => e.mask.slice());
    while (next.length < pop) {
      const a = elite[(rng() * elite.length) | 0].mask;
      const b = elite[(rng() * elite.length) | 0].mask;
      const child = a.map((v, i) => (rng() < 0.5 ? v : b[i]));
      for (let i = 0; i < d; i++) if (rng() < 0.08) child[i] = 1 - child[i];
      if (child.reduce((x, y) => x + y, 0) < 4) child[(rng() * d) | 0] = 1;
      next.push(child);
    }
    pool = next;
  }
  const seen = new Set();
  const diverse = [];
  for (const m of bestMasks) {
    const key = m.join("");
    if (seen.has(key)) continue;
    seen.add(key);
    diverse.push(m.slice());
    if (diverse.length >= 10) break;
  }
  return { masks: diverse };
}

function sampleIdx(n, k, rng) {
  const all = [...Array(n).keys()];
  const out = [];
  while (out.length < k && all.length) out.push(all.splice(Math.floor(rng() * all.length), 1)[0]);
  return out;
}

function featsOf(mask, order) {
  const kept = new Set(QFEAT.filter((_, i) => mask[i]));
  return order.filter((k) => kept.has(k));
}

function annealEnsemble(masks, rows, Y, rng, fast) {
  const sub = Math.min(rows.length, fast ? 160 : 220);
  const idx = rows.length === sub ? rows.map((_, i) => i) : sampleIdx(rows.length, sub, rng);
  const subRows = idx.map((i) => rows[i]);
  const subY = idx.map((i) => Y[i]);
  const sp = Math.floor(subRows.length * 0.8);
  const trRows = subRows.slice(0, sp);
  const trY = subY.slice(0, sp);
  const vaRows = subRows.slice(sp);
  const vaY = subY.slice(sp);

  const evalCfg = (cfg) => {
    const feats = featsOf(cfg.mask, cfg.order);
    const stats = {};
    for (const k of feats) {
      const vals = trRows.map((r) => r.f[k]);
      const m = mean(vals);
      stats[k] = { m, s: std(vals, m) || 1e-9 };
    }
    const toXk = (r) => feats.map((k) => (r.f[k] - stats[k].m) / stats[k].s);
    const Xtr = trRows.map(toXk);
    const logits = new Array(vaRows.length).fill(0);
    for (let mi = 0; mi < cfg.members; mi++) {
      const order2 = shuffle(feats, rng);
      const Xtr2 = trRows.map((r) => order2.map((k) => (r.f[k] - stats[k].m) / stats[k].s));
      const W = trainMps(Xtr2, trY, cfg.bond, cfg.lr, cfg.l2, cfg.epochs);
      for (let i = 0; i < vaRows.length; i++) {
        const x = order2.map((k) => (vaRows[i].f[k] - stats[k].m) / stats[k].s);
        const p = Math.min(0.999, Math.max(0.001, predictMps(W, x, cfg.bond)));
        logits[i] += Math.log(p / (1 - p));
      }
    }
    const acc = accOf(logits.map((v) => sigmoid(v / cfg.members)), vaY);
    return { acc, cost: 1 - acc };
  };

  const featsOfMask = (mask) => QFEAT.filter((_, i) => mask[i]);
  const sampleCfg = () => {
    const mask = masks[Math.floor(rng() * masks.length)];
    return {
      mask,
      order: shuffle(featsOfMask(mask), rng),
      bond: 2 + ((rng() * 3) | 0),
      lr: 0.05 + rng() * 0.15,
      l2: 1e-4 + rng() * 0.003,
      epochs: 40 + ((rng() * 50) | 0),
      members: 3 + ((rng() * 3) | 0),
    };
  };
  const mutateCfg = (c0) => {
    const c = Object.assign({}, c0);
    c.bond = 2 + ((rng() * 3) | 0);
    c.lr = Math.min(0.25, Math.max(0.02, c0.lr + (rng() - 0.5) * 0.06));
    c.l2 = Math.min(0.008, Math.max(1e-5, c0.l2 + (rng() - 0.5) * 0.0015));
    c.epochs = Math.min(120, Math.max(30, c0.epochs + ((rng() * 40) | 0) - 20));
    c.members = Math.min(6, Math.max(3, c0.members + ((rng() * 2) | 0) - 1));
    if (rng() < 0.3) c.order = shuffle(featsOfMask(c0.mask), rng);
    if (rng() < 0.2) {
      c.mask = masks[Math.floor(rng() * masks.length)];
      c.order = shuffle(featsOfMask(c.mask), rng);
    }
    return c;
  };

  let best = null;
  let cur = null;
  let T = 0.12;
  const its = fast ? 5 : 8;
  for (let it = 0; it < its; it++) {
    const cfg = it === 0 ? sampleCfg() : mutateCfg(cur ? cur.cfg : sampleCfg());
    const r = evalCfg(cfg);
    if (!best || r.cost < best.cost) best = { cfg, acc: r.acc, cost: r.cost };
    if (!cur || r.cost < cur.cost || rng() < Math.exp(-(r.cost - (cur ? cur.cost : 0)) / Math.max(T, 1e-4))) {
      cur = { cfg, acc: r.acc, cost: r.cost };
    }
    T *= 0.8;
  }
  return best || { cfg: sampleCfg(), acc: 0.5 };
}

function train(candles, windowHint = 1800) {
  const rows = buildFeatures(candles);
  if (rows.length < 120) return { ok: false, reason: "Need at least ~120 bars for the QuantumLink engine." };
  const use = rows.slice(-Math.min(rows.length, windowHint));
  const horizons = [1, 3, 6];
  const out = { ok: true, engine: "quantumlink-mps", horizons: {}, barCount: use.length, features: QFEAT.length, trace: [] };
  for (const r of use) {
    for (const hz of horizons) {
      const j = r.i + hz;
      r["y" + hz] = j < candles.length ? (candles[j].c > candles[r.i].c ? 1 : 0) : null;
    }
  }
  let sharedCfg = null;
  for (const hz of horizons) {
    const usable = use.filter((r) => r["y" + hz] !== null);
    if (usable.length < 100) {
      out.horizons[hz] = { ok: false, reason: "Too few labelled bars." };
      continue;
    }
    const fast = hz > 1;
    const split = Math.floor(usable.length * 0.85);
    const trRows = usable.slice(0, split);
    const target = usable.map((r) => r["y" + hz]);

    let cfg;
    let masks = null;
    if (hz === 1 || !sharedCfg) {
      const rngSeed = mulberry(12345 + hz * 7919);
      const probes = eaSearch(usable, "y" + hz, 10, 20, rngSeed);
      masks = probes.masks.slice(0, 7);
      const best = annealEnsemble(masks, trRows, target.slice(0, split), mulberry(7 + hz * 3), false);
      cfg = best.cfg;
      sharedCfg = { cfg, masks };
    } else {
      sharedCfg.cfg.members = Math.min(3, sharedCfg.cfg.members);
      sharedCfg.cfg.epochs = Math.max(30, Math.round(sharedCfg.cfg.epochs * 0.55));
      cfg = { mask: sharedCfg.cfg.mask.slice(), order: sharedCfg.cfg.order.slice(), bond: sharedCfg.cfg.bond, lr: sharedCfg.cfg.lr, l2: sharedCfg.cfg.l2, epochs: sharedCfg.cfg.epochs, members: sharedCfg.cfg.members };
      masks = sharedCfg.masks;
    }

    const feats = featsOf(cfg.mask, cfg.order);
    const allStats = {};
    for (const k of feats) {
      const vals = trRows.map((r) => r.f[k]);
      const m = mean(vals);
      allStats[k] = { m, s: std(vals, m) || 1e-9 };
    }
    const toXk = (r) => feats.map((k) => (r.f[k] - allStats[k].m) / allStats[k].s);
    const trForTrain = trRows.length > 240 ? sampleIdx(trRows.length, 240, mulberry(31 + hz)) : trRows.map((_, i) => i);
    const trTrain = trForTrain.map((i) => trRows[i]);
    const members = [];
    for (let mi = 0; mi < cfg.members; mi++) {
      const order2 = shuffle(feats, mulberry(900 + mi * 101 + hz));
      const Xtr = trTrain.map((r) => order2.map((k) => (r.f[k] - allStats[k].m) / allStats[k].s));
      const Ytr = trTrain.map((r) => r["y" + hz]);
      const W = trainMps(Xtr, Ytr, cfg.bond, cfg.lr, cfg.l2, fast ? Math.max(30, Math.round(cfg.epochs * 0.7)) : cfg.epochs);
      members.push({ W, order: order2 });
    }
    const logitOf = (r) => {
      let s = 0;
      for (const m of members) {
        const x = m.order.map((k) => (r.f[k] - allStats[k].m) / allStats[k].s);
        const p = Math.min(0.999, Math.max(0.001, predictMps(m.W, x, cfg.bond)));
        s += Math.log(p / (1 - p));
      }
      return s / members.length;
    };
    const vaRows = usable.slice(split);
    let hits = 0;
    for (let qi = 0; qi < vaRows.length; qi++) {
      const p = sigmoid(logitOf(vaRows[qi]));
      if ((p >= 0.5 ? 1 : 0) === vaRows[qi]["y" + hz]) hits++;
    }
    const acc = vaRows.length ? hits / vaRows.length : 0.5;
    const likely = vaRows.length ? vaRows : trRows.slice(-Math.min(60, Math.floor(trRows.length / 2)));
    const traceP = [];
    for (const r of likely) traceP.push({ t: r.t, p: sigmoid(logitOf(r)) });
    traceP.sort((a, b) => a.t - b.t);

    const baseModel = logisticBaseline(trRows.map(toXk), trRows.map((r) => r["y" + hz]));
    const basePreds = vaRows.map((r) => baseModel.predict(toXk(r)));
    const baseAcc = vaRows.length ? accOf(basePreds, vaRows.map((r) => r["y" + hz])) : 0.5;

    out.horizons[hz] = {
      ok: true,
      engine: "quantumlink-mps",
      probUp: Math.min(0.99, Math.max(0.01, sigmoid(logitOf(use[use.length - 1])))),
      fwdAccuracy: acc,
      baselineAccuracy: baseAcc,
      fwdSize: vaRows.length,
      hits,
      samples: usable.length,
      ensemble: { members: members.length, bond: cfg.bond, epochs: cfg.epochs, masks: masks ? masks.length : 0 },
    };
    if (hz === 1) {
      out.traceMap = traceP;
    }
  }
  const h1 = out.horizons[1];
  if (h1 && h1.ok) {
    const edge = (h1.probUp - 0.5) * 2;
    out.verdict = {
      dir: edge > 0.12 ? "up" : edge < -0.12 ? "down" : "side",
      probUp: h1.probUp,
      confidence: Math.abs(edge),
      fwdAccuracy: h1.fwdAccuracy,
    };
    out.trace = (out.traceMap || []).slice(-260).map((t) => ({ t: t.t, p: +t.p.toFixed(3) }));
    if (out.trace.length > 3) {
      out.traceDirection = out.trace[out.trace.length - 1].p - out.trace[Math.max(0, out.trace.length - 6)].p;
    }
  }
  delete out.traceMap;
  return out;
}

module.exports = { train, buildFeatures, QFEAT, sigmoid, mpsScore, trainMps, predictMps, logisticBaseline, accOf };