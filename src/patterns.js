"use strict";
// Chart-pattern & structure detection. All causal (each bar's read uses info up to that bar).
const { atr, rsi } = require("./indicators");
const { nearestIndex } = require("./mta");

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// --- Swing pivots (fractal of width nb) --------------------------------
function swings(candles, nb = 2) {
  const out = [];
  for (let i = nb; i < candles.length - nb; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - nb; j <= i + nb; j++) {
      if (candles[j].h > candles[i].h) isHigh = false;
      if (candles[j].h < candles[i].h && j === i) isHigh = false;
      if (isNaN(candles[j].h)) isHigh = false;
      if (candles[j].l < candles[i].l) isLow = false;
      if (candles[j].l > candles[i].l && j === i) isLow = false;
      if (isNaN(candles[j].l)) isLow = false;
    }
    if (isHigh) out.push({ i, p: candles[i].h, type: "H" });
    if (isLow) out.push({ i, p: candles[i].l, type: "L" });
  }
  return out;
}

// --- Support / Resistance via swing clusters ----------------------------
function supportResistance(candles, atrArr, price) {
  const a = atrArr[atrArr.length - 1];
  const band = Math.max(isFinite(a) ? a * 0.18 : price * 0.001, price * 0.00015);
  const pv = swings(candles, 3);
  const levels = pv.map((s) => s.p).sort((x, y) => x - y);
  const clusters = [];
  for (const lv of levels) {
    const idx = nearestIndex(clusters.length ? clusters.map((c) => c.price) : [], lv);
    if (clusters.length && Math.abs(clusters[idx].price - lv) <= band) {
      clusters[idx].touches += 1;
      clusters[idx].price = (clusters[idx].price + lv) / 2;
    } else {
      // merge with a near round number if very close
      clusters.push({ price: lv, touches: 1 });
    }
  }
  const roundDist = Math.pow(10, Math.floor(Math.log10(Math.max(price, 1))) >= 0 ? 1 : 0);
  const final = clusters
    .map((c) => {
      const rounded = Math.round(c.price);
      if (Math.abs(rounded - c.price) < Math.max(band * 0.4, 0.5)) {
        return { price: rounded, touches: c.touches + 0.5, rounded: true };
      }
      return c;
    })
    .sort((x, y) => y.touches - x.touches)
    .slice(0, 8);
  const support = final.filter((l) => l.price < price).sort((x, y) => y.price - x.price);
  const resistance = final.filter((l) => l.price > price).sort((x, y) => x.price - y.price);
  return {
    all: final,
    support: support.map((s) => ({ ...s, distance: (price - s.price) / price })),
    resistance: resistance.map((r) => ({ ...r, distance: (r.price - price) / price })),
    nearestSupport: support.length ? support[0].price : null,
    nearestResistance: resistance.length ? resistance[0].price : null,
    atr: a,
  };
}

// --- Market structure (HH/HL vs LH/LL) ----------------------------------
function marketStructure(candles, nb = 2) {
  const pv = swings(candles, nb);
  const lows = pv.filter((s) => s.type === "L").slice(-3);
  const highs = pv.filter((s) => s.type === "H").slice(-3);
  let bullish = false;
  let bearish = false;
  if (highs.length >= 2 && highs[highs.length - 1].p > highs[highs.length - 2].p) {
    if (lows.length >= 2 && lows[lows.length - 1].p > lows[lows.length - 2].p) bullish = true;
    else if (lows.length >= 2 && lows[lows.length - 1].p < lows[lows.length - 2].p) {
      if (highs.length >= 3 && highs[highs.length - 1].p > highs[highs.length - 3].p) bullish = true;
    }
  }
  if (lows.length >= 2 && lows[lows.length - 1].p < lows[lows.length - 2].p) {
    if (highs.length >= 3 && highs[highs.length - 1].p < highs[highs.length - 2].p) bearish = true;
  }
  return {
    bullish,
    bearish,
    neither: !bullish && !bearish,
    label: bullish ? "Bullish (HH/HL)" : bearish ? "Bearish (LH/LL)" : "Ranging / uncertain",
    pivots: pv.slice(-6),
  };
}

// --- Candlestick patterns -------------------------------------------------
function body(c){ return Math.abs(c.c - c.o); }
function range(c){ return c.h - c.l || 1e-9; }

function classifyBar(c, prev1) {
  const r = range(c);
  const b = body(c);
  const upperW = c.h - Math.max(c.o, c.c);
  const lowerW = Math.min(c.o, c.c) - c.l;
  const bullish = c.c > c.o;
  const ratio = r / b;
  if (ratio > 6 && upperW < b * 0.3 && lowerW > b * 2.2 && b < r * 0.15) return "hammer";
  if (ratio > 6 && upperW > b * 2.2 && lowerW < b * 0.3 && b < r * 0.15) return "shooting_star";
  if (lowerW >= r * 0.55 && upperW < r * 0.2 && !bullish && b < r * 0.35) return "hammer";
  if (upperW >= r * 0.55 && lowerW < r * 0.2 && bullish && b < r * 0.35) return "shooting_star";
  if (b < r * 0.08 && r > 0) return "doji";
  if (b > r * 0.75) return "marubozu";
  if (prev1 && prev1.c < prev1.o && c.c > c.o && c.c >= prev1.o && c.o <= prev1.c && b > r * 0.6) return "bull_engulf";
  if (prev1 && prev1.c > prev1.o && c.c < c.o && c.c <= prev1.o && c.o >= prev1.c && b > r * 0.6) return "bear_engulf";
  if (prev1 && c.h <= prev1.h && c.l >= prev1.l && r < prev1.h - prev1.l) return "inside";
  if (prev1 && c.h > prev1.h && c.l < prev1.l) return "outside";
  if ((c.h - Math.max(c.o, c.c)) >= r * 0.5 && body(c) < r * 0.3) return "pin_top";
  if ((Math.min(c.o, c.c) - c.l) >= r * 0.5 && body(c) < r * 0.3) return "pin_bottom";
  return "none";
}

function candlePatterns(candles, atrArr) {
  const seen = [];
  const dirOf = {
    hammer: "up", shooting_star: "down", doji: "side", marubozu: "side", bull_engulf: "up",
    bear_engulf: "down", inside: "side", outside: "side", pin_top: "down", pin_bottom: "up",
  };
  const strengthOf = {
    hammer: 0.6, shooting_star: 0.6, doji: 0.3, marubozu: 0.7, bull_engulf: 0.8,
    bear_engulf: 0.8, inside: 0.25, outside: 0.65, pin_top: 0.75, pin_bottom: 0.75,
  };
  for (let i = 1; i < candles.length; i++) {
    const name = classifyBar(candles[i], candles[i - 1]);
    if (name === "none") continue;
    const a = atrArr[i] || NaN;
    const bigMovePenalty = isFinite(a) && body(candles[i]) > a * 2.5 ? 0.82 : 1; // huge bars = impulse, less "setup"
    seen.push({
      i,
      name,
      dir: dirOf[name],
      strength: clamp(strengthOf[name] * bigMovePenalty, 0, 1),
      t: candles[i].t,
    });
  }
  const recent = seen.slice(-24);
  const byDir = (d) => recent.filter((p) => p.dir === d).sort((x, y) => y.strength - x.strength);
  const up = byDir("up");
  const down = byDir("down");
  const best = (arr) => (arr.length ? { name: arr[0].name, strength: arr[0].strength, i: arr[0].i } : null);
  const tension = up.length && down.length ? up[0].strength - down[0].strength : 0;
  return {
    recent: recent.slice(-12),
    strongestUp: best(up),
    strongestDown: best(down),
    pull: clamp(0.5 + tension, 0, 1), // 0..1 pattern pull toward up
  };
}

// --- "Early move" ignition detector (M1 mindset) --------------------------
// Flags when the market starts to wake up: compressed range -> breakout on
// momentum + volume, or acceleration of a fresh trend leg.
function earlyMove(candles, window = 24) {
  if (candles.length < 40) return { ignition: "none", strength: 0, note: "Not enough bars yet." };
  const a1 = atr(candles, 14);
  const r16 = candles.slice(-window);
  const start = candles.length - window;
  let recentHigh = -Infinity;
  let recentLow = Infinity;
  for (let k = 0; k < r16.length - 1; k++) {
    if (r16[k].h > recentHigh) recentHigh = r16[k].h;
    if (r16[k].l < recentLow) recentLow = r16[k].l;
  }
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const a = a1[a1.length - 1] || (cur.h - cur.l);
  const volAvg = r16.length > 5 ? r16.slice(0, -1).reduce((s, c) => s + (c.v || 0), 0) / (r16.length - 1) : 1;
  const vCur = cur.v || 0;
  const followed = vCur >= volAvg * 1.5;
  const stretch = window <= 10 ? 0.5 : 1.2; // on M1 you allow smaller ATR multiples
  const bodyPct = (Math.abs(cur.c - cur.o) / (cur.h - cur.l || 1e-9));

  let ignition = "none";
  let strength = 0;
  let note = "Compressed range; market still coiling. Watch for breakout.";

  if (cur.c > Math.max(recentHigh, prev.c) && bodyPct > 0.55) {
    ignition = "up";
    strength = clamp(0.4 + (bodyPct - 0.55) + (followed ? 0.2 : 0) + (isFinite(a) && range(cur) / Math.max(a, 1e-9) > stretch ? 0.15 : 0), 0, 1);
    note = followed ? "Range breakout ABOVE with volume — early bullish ignition." : "Range breakout above (low volume) — confirm with a pullback hold.";
  } else if (cur.c < Math.min(recentLow, prev.c) && bodyPct > 0.55) {
    ignition = "down";
    strength = clamp(0.4 + (bodyPct - 0.55) + (followed ? 0.2 : 0) + (isFinite(a) && range(cur) / Math.max(a, 1e-9) > stretch ? 0.15 : 0), 0, 1);
    note = followed ? "Range breakout BELOW with volume — early bearish ignition." : "Range breakout below (low volume) — confirm with a pullback hold.";
  } else {
    // acceleration check
    const closes = candles.map((c) => c.c);
    const s1 = closes[start + window - 6] - closes[start + window - 12];
    const s2 = closes[start + window - 1] - closes[start + window - 6];
    const accel = s2 - s1;
    if (Math.abs(accel) > 0 && isFinite(a) && Math.abs(accel) > a * 1.1 && bodyPct > 0.4) {
      ignition = accel > 0 ? "up" : "down";
      strength = 0.55;
      note = `Acceleration ${ignition === "up" ? "upward" : "downward"} building — momentum leg starting.`;
    } else if (bodyPct < 0.2 && isFinite(a) && range(cur) < a * 0.6) {
      note = "Very tight coil — volatility squeeze likely resolves soon.";
      strength = 0.5;
    }
  }
  return {
    ignition,
    strength,
    note,
    rangeHigh: recentHigh,
    rangeLow: recentLow,
    atr: a,
  };
}

// Gold sessions in UTC
function session(epochMs) {
  const d = new Date(epochMs);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h >= 1 && h < 7) return { name: "Asia", active: false, note: "Thin liquidity — wider swings, chop common." };
  if (h >= 7 && h < 12.5) return { name: "London open", active: true, note: "Healthy liquidity, first real move of the day." };
  if (h >= 12.5 && h < 14.5) return { name: "NY open / Ldn overlap", active: true, note: "Highest liquidity & volatility for gold." };
  if (h >= 14.5 && h < 17) return { name: "NY afternoon", active: true, note: "Momentum often extends but fading risk rises." };
  if (h >= 17 && h < 21) return { name: "NY late", active: false, note: "Illiquid — avoid entries here." };
  return { name: "Late night", active: false, note: "Illiquid — setup-only, no entries." };
}

module.exports = { swings, supportResistance, marketStructure, candlePatterns, earlyMove, session, classifyBar };