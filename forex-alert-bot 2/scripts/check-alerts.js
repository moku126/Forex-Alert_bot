// scripts/check-alerts.js
// Prüft die Watchlist gegen die 4 Kernindikatoren (Pivot, RSI, MA200, Fibonacci)
// und schickt eine Telegram-Nachricht, wenn alle 4 Ampeln in dieselbe Richtung zeigen.

const fs = require("fs");
const path = require("path");

// ---------- Konfiguration: hier deine Watchlist anpassen ----------
const WATCHLIST = [
  { pair: "EUR/USD", timeframe: "4h" },
  { pair: "GBP/USD", timeframe: "4h" },
  { pair: "USD/JPY", timeframe: "4h" },
  { pair: "EUR/USD", timeframe: "1h" },
  { pair: "GBP/USD", timeframe: "1h" },
];

const TIMEFRAME_OUTPUTSIZE = {
  "1day": 300,
  "4h": 500,
  "1h": 500,
  "15min": 500,
  "5min": 500,
};

const STATE_FILE = path.join(__dirname, "..", "state", "alert-state.json");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!API_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Fehlende Umgebungsvariablen: TWELVE_DATA_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipSize(pair) {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pivotPoints(prevHigh, prevLow, prevClose) {
  const p = (prevHigh + prevLow + prevClose) / 3;
  return { p, r1: 2 * p - prevLow, s1: 2 * p - prevHigh };
}

function fibLevels(swingHigh, swingLow) {
  const range = swingHigh - swingLow;
  return {
    high: swingHigh, low: swingLow,
    l500: swingHigh - range * 0.5,
    l618: swingHigh - range * 0.618,
  };
}

function atrSeries(candles, period = 14) {
  if (candles.length < period + 1) return [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const out = [];
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = val;
  for (let i = period; i < trs.length; i++) { val = (val * (period - 1) + trs[i]) / period; out[i + 1] = val; }
  return out;
}

function findSwings(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    if (window.every((c) => c.high <= candles[i].high)) highs.push({ price: candles[i].high, index: i });
    if (window.every((c) => c.low >= candles[i].low)) lows.push({ price: candles[i].low, index: i });
  }
  return { highs, lows };
}

function clusterLevels(points, tolerancePct) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = current[current.length - 1];
    if (Math.abs(sorted[i].price - last.price) / last.price <= tolerancePct) current.push(sorted[i]);
    else { clusters.push(current); current = [sorted[i]]; }
  }
  clusters.push(current);
  return clusters.map((c) => ({
    level: c.reduce((a, b) => a + b.price, 0) / c.length,
    min: Math.min(...c.map((p) => p.price)), max: Math.max(...c.map((p) => p.price)),
    touches: c.length,
  }));
}

function findFVGs(candles, lookback = 90) {
  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    if (a.high < c.low) gaps.push({ type: "bullish", top: c.low, bottom: a.high, formedIndex: i });
    else if (a.low > c.high) gaps.push({ type: "bearish", top: a.low, bottom: c.high, formedIndex: i });
  }
  return gaps.map((g) => {
    let filled = false;
    for (let j = g.formedIndex + 1; j < candles.length; j++) {
      const cc = candles[j];
      if (cc.low <= g.top && cc.high >= g.bottom) { filled = true; break; }
    }
    return { ...g, filled };
  }).filter((g) => !g.filled);
}

const TOLERANCE_BY_TF = {
  "1day": { zone: 0.0015, liquidity: 0.0006 },
  "4h": { zone: 0.0012, liquidity: 0.0005 },
  "1h": { zone: 0.0009, liquidity: 0.0004 },
  "15min": { zone: 0.0006, liquidity: 0.0003 },
  "5min": { zone: 0.0004, liquidity: 0.0002 },
};

// ---------- Notenbank-Termine 2026 (statisch, Quelle: federalreserve.gov / ecb.europa.eu) ----------
// Fed: Entscheidung jeweils am 2. Sitzungstag, 20:00 MESZ/MEZ (14:00 ET) + Pressekonferenz 20:30
const FED_DECISIONS_2026_UTC = [
  "2026-01-28T19:00:00Z", "2026-03-18T18:00:00Z", "2026-04-29T18:00:00Z", "2026-06-17T18:00:00Z",
  "2026-07-29T18:00:00Z", "2026-09-16T18:00:00Z", "2026-10-28T18:00:00Z", "2026-12-09T19:00:00Z",
];
// EZB: Entscheidung 14:15 MEZ/MESZ
const ECB_DECISIONS_2026_UTC = [
  "2026-01-25T13:15:00Z", "2026-03-19T13:15:00Z", "2026-04-30T12:15:00Z", "2026-06-11T12:15:00Z",
  "2026-07-23T12:15:00Z", "2026-09-10T12:15:00Z", "2026-10-29T13:15:00Z", "2026-12-17T13:15:00Z",
];
const OBSTACLE_THRESHOLD_PIPS = 15; // Veto-Schwelle: Zone näher als das → kein Alarm
const CENTRAL_BANK_HEADSUP_HOURS = 24; // Hinweis, wenn Sitzung innerhalb dieses Fensters liegt

function upcomingCentralBankEvent(pair) {
  const now = Date.now();
  const windowMs = CENTRAL_BANK_HEADSUP_HOURS * 60 * 60 * 1000;
  const relevantFed = pair.includes("USD");
  const relevantEcb = pair.includes("EUR");
  const candidates = [];
  if (relevantFed) FED_DECISIONS_2026_UTC.forEach((d) => candidates.push({ bank: "Fed", time: new Date(d) }));
  if (relevantEcb) ECB_DECISIONS_2026_UTC.forEach((d) => candidates.push({ bank: "EZB", time: new Date(d) }));
  const upcoming = candidates
    .filter((c) => c.time.getTime() >= now && c.time.getTime() - now <= windowMs)
    .sort((a, b) => a.time - b.time);
  return upcoming[0] || null;
}

async function fetchSeries(pair, interval, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "error" || json.code) {
    throw new Error(json.message || `API-Fehler für ${pair} (${interval})`);
  }
  if (!json.values || !Array.isArray(json.values)) {
    throw new Error(`Keine Kursdaten für ${pair} (${interval})`);
  }
  return json.values
    .map((v) => ({ date: v.datetime, close: parseFloat(v.close), high: parseFloat(v.high), low: parseFloat(v.low) }))
    .reverse();
}

async function analyzePair(pair, timeframe) {
  const outputsize = TIMEFRAME_OUTPUTSIZE[timeframe] || 300;
  const series = await fetchSeries(pair, timeframe, outputsize);
  await sleep(1200); // Twelve Data Free-Tier: Rate Limit schonen

  const dailySeries = timeframe === "1day" ? series : await (async () => {
    const d = await fetchSeries(pair, "1day", 5);
    await sleep(1200);
    return d;
  })();

  const closes = series.map((d) => d.close);
  const lastClose = closes[closes.length - 1];

  const rsiVal = rsi(closes, 14);
  const smaVal = sma(closes, 200);
  const emaArr = emaSeries(closes, 200);
  const emaVal = emaArr.length ? emaArr[emaArr.length - 1] : null;

  const prevDay = dailySeries[dailySeries.length - 2];
  const pivots = pivotPoints(prevDay.high, prevDay.low, prevDay.close);

  const swingWindow = series.slice(-50);
  const swingHigh = Math.max(...swingWindow.map((d) => d.high));
  const swingLow = Math.min(...swingWindow.map((d) => d.low));
  let swingHighIdx = 0, swingLowIdx = 0;
  swingWindow.forEach((d, i) => { if (d.high === swingHigh) swingHighIdx = i; if (d.low === swingLow) swingLowIdx = i; });
  const swingTrendUp = swingHighIdx > swingLowIdx;
  const swingTrendDown = swingLowIdx > swingHighIdx;
  const fib = fibLevels(swingHigh, swingLow);

  let rsiVote = 0;
  if (rsiVal !== null) { if (rsiVal < 30) rsiVote = 1; else if (rsiVal > 70) rsiVote = -1; }
  let maVote = 0;
  if (smaVal !== null && emaVal !== null) {
    if (lastClose > smaVal && lastClose > emaVal) maVote = 1;
    else if (lastClose < smaVal && lastClose < emaVal) maVote = -1;
  }
  let pivotVote = 0;
  if (lastClose > pivots.p) pivotVote = 1; else if (lastClose < pivots.p) pivotVote = -1;

  const inGoldenZone = lastClose <= fib.l500 && lastClose >= fib.l618;
  let fibVote = 0;
  if (inGoldenZone) { if (swingTrendUp) fibVote = 1; else if (swingTrendDown) fibVote = -1; }

  const score = rsiVote + maVote + pivotVote + fibVote;

  // --- Marktstruktur & Kontext (wie im Web-Panel) ---
  const tol = TOLERANCE_BY_TF[timeframe] || TOLERANCE_BY_TF["1day"];
  const structureCandles = series.slice(-150);
  const { highs, lows } = findSwings(structureCandles, 3);

  const resistanceClusters = clusterLevels(highs, tol.zone).filter((z) => z.level > lastClose).sort((a, b) => a.level - b.level);
  const demandClusters = clusterLevels(lows, tol.zone).filter((z) => z.level < lastClose).sort((a, b) => b.level - a.level);
  const nearestResistance = resistanceClusters[0] || null;
  const nearestDemand = demandClusters[0] || null;

  const liquidityHighClusters = clusterLevels(highs, tol.liquidity).filter((z) => z.touches >= 2);
  const liquidityLowClusters = clusterLevels(lows, tol.liquidity).filter((z) => z.touches >= 2);
  const buySideLiquidity = liquidityHighClusters.filter((z) => z.level > lastClose).sort((a, b) => a.level - b.level)[0] || null;
  const sellSideLiquidity = liquidityLowClusters.filter((z) => z.level < lastClose).sort((a, b) => b.level - a.level)[0] || null;

  const fvgs = findFVGs(structureCandles, 90);
  const nearestFvgAbove = fvgs.filter((g) => g.bottom > lastClose).sort((a, b) => a.bottom - b.bottom)[0] || null;
  const nearestFvgBelow = fvgs.filter((g) => g.top < lastClose).sort((a, b) => b.top - a.top)[0] || null;

  const atrArr = atrSeries(structureCandles, 14).filter((v) => v !== undefined);
  const currentAtr = atrArr[atrArr.length - 1] || null;
  const avgAtr = atrArr.length ? atrArr.reduce((a, b) => a + b, 0) / atrArr.length : null;
  let volLabel = "normal";
  if (currentAtr && avgAtr) { if (currentAtr > avgAtr * 1.2) volLabel = "erhöht"; else if (currentAtr < avgAtr * 0.8) volLabel = "niedrig"; }

  return {
    pair, timeframe, lastClose, rsiVal, smaVal, emaVal, pivots, rsiVote, maVote, pivotVote, fibVote, score,
    nearestResistance, nearestDemand, buySideLiquidity, sellSideLiquidity, nearestFvgAbove, nearestFvgBelow, currentAtr, avgAtr, volLabel,
  };
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!json.ok) console.error("Telegram-Fehler:", json.description);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fmt(n, pair) {
  const digits = pair.includes("JPY") ? 3 : 5;
  return n.toFixed(digits);
}

(async () => {
  const state = loadState();
  let stateChanged = false;

  for (const { pair, timeframe } of WATCHLIST) {
    const key = `${pair}_${timeframe}`;
    try {
      const a = await analyzePair(pair, timeframe);
      const direction = a.score === 4 ? "bullisch" : a.score === -4 ? "bärisch" : null;

      // Veto: starkes Hindernis (Widerstand/Kaufzone) direkt im Weg → Alarm unterdrücken
      const pip = pipSize(pair);
      let obstaclePips = null;
      if (direction === "bullisch" && a.nearestResistance) obstaclePips = (a.nearestResistance.level - a.lastClose) / pip;
      if (direction === "bärisch" && a.nearestDemand) obstaclePips = (a.lastClose - a.nearestDemand.level) / pip;
      const vetoed = obstaclePips !== null && obstaclePips < OBSTACLE_THRESHOLD_PIPS;

      if (direction && vetoed) {
        console.log(`${key}: Score ${a.score}, aber Zonen-Veto (Hindernis nur ${obstaclePips.toFixed(1)} Pips entfernt) — kein Alarm.`);
        continue;
      }

      if (direction && state[key] !== direction) {
        const arrow = direction === "bullisch" ? "🟢▲" : "🔴▼";
        const pip = pipSize(pair);
        const lines = [
          `${arrow} <b>Alle 4 Ampeln ${direction}</b>`,
          `${pair} · ${timeframe}`,
          `Kurs: ${fmt(a.lastClose, pair)}`,
          ``,
          `RSI: ${a.rsiVal.toFixed(1)} (${a.rsiVote > 0 ? "▲" : a.rsiVote < 0 ? "▼" : "–"})`,
          `MA200: ${a.maVote > 0 ? "▲ über EMA/SMA" : a.maVote < 0 ? "▼ unter EMA/SMA" : "–"}`,
          `Pivot: ${a.pivotVote > 0 ? "▲ über P" : "▼ unter P"} (${fmt(a.pivots.p, pair)})`,
          `Fibonacci: ${a.fibVote > 0 ? "▲ Golden Zone (Aufwärtsimpuls)" : "▼ Golden Zone (Abwärtsimpuls)"}`,
          ``,
          `<b>Marktstruktur:</b>`,
        ];
        if (a.nearestResistance) lines.push(`Widerstand: ${fmt(a.nearestResistance.min, pair)}–${fmt(a.nearestResistance.max, pair)} (${a.nearestResistance.touches}× getestet)`);
        if (a.nearestDemand) lines.push(`Kaufzone: ${fmt(a.nearestDemand.min, pair)}–${fmt(a.nearestDemand.max, pair)} (${a.nearestDemand.touches}× getestet)`);
        if (a.buySideLiquidity) lines.push(`Buy-Side-Liquidität: ${fmt(a.buySideLiquidity.level, pair)}`);
        if (a.sellSideLiquidity) lines.push(`Sell-Side-Liquidität: ${fmt(a.sellSideLiquidity.level, pair)}`);
        if (a.nearestFvgAbove) lines.push(`FVG über Kurs: ${fmt(a.nearestFvgAbove.bottom, pair)}–${fmt(a.nearestFvgAbove.top, pair)} (${a.nearestFvgAbove.type})`);
        if (a.nearestFvgBelow) lines.push(`FVG unter Kurs: ${fmt(a.nearestFvgBelow.bottom, pair)}–${fmt(a.nearestFvgBelow.top, pair)} (${a.nearestFvgBelow.type})`);
        lines.push(`Volatilität (ATR14): ${fmt(a.currentAtr, pair)} — ${a.volLabel}`);

        const cbEvent = upcomingCentralBankEvent(pair);
        if (cbEvent) {
          const opts = { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" };
          const localTime = cbEvent.time.toLocaleString("de-DE", opts);
          lines.push(``, `📅 Hinweis: ${cbEvent.bank}-Sitzung am ${localTime} Uhr (MEZ/MESZ) — Volatilität kann davor/danach stark abweichen.`);
        }

        lines.push(``, `⚠️ Kein Kauf-/Verkaufssignal, sondern eine regelbasierte Kennzahl. Entscheidung liegt bei dir.`);

        await sendTelegram(lines.join("\n"));
        state[key] = direction;
        stateChanged = true;
        console.log(`Alert gesendet: ${key} → ${direction}`);
      } else if (!direction && state[key]) {
        // Ampeln nicht mehr alle gleich ausgerichtet → Status zurücksetzen, damit der nächste Vollausschlag wieder meldet
        delete state[key];
        stateChanged = true;
      } else {
        console.log(`${key}: Score ${a.score}, keine Aktion.`);
      }
    } catch (e) {
      console.error(`Fehler bei ${key}:`, e.message);
    }
  }

  if (stateChanged) saveState(state);
})();
