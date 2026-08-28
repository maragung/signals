// Per-category sub-scoring primitives used by `computeScore`.
//
// Every sub-score returns `{ bullish, bearish }` contributions in the
// range [0, 1] (0 = no contribution, 1 = full contribution). The
// main `computeScore` aggregates them with user-configurable weights.

import type {
  Bias,
  Candle,
  MarketStructureEvent,
  MTFAnalysis,
  SupplyDemandZone,
  SupportResistanceLevel,
} from '@/types';
import { isFiniteNum, mean, safeNum } from '@/core/utils/series';
import { adxSeries, ema, lastFinite, macdSeries, rsiSeries, sma } from '@/core/strategies/indicators';
import { logReturns, trueRange } from '@/core/utils/candles';

export interface SubScore {
  bullish: number;
  bearish: number;
}

/** Score trend strength via EMA alignment and slope direction. */
export function scoreTrend(candles: ReadonlyArray<Candle>): SubScore {
  if (candles.length < 10) return { bullish: 0, bearish: 0 };
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, Math.min(9, candles.length));
  const slow = ema(closes, Math.min(21, candles.length));
  const lastFast = lastFinite(fast);
  const lastSlow = lastFinite(slow);
  if (!isFiniteNum(lastFast) || !isFiniteNum(lastSlow)) return { bullish: 0, bearish: 0 };

  // Slope contribution: change in slow EMA across the last N bars.
  const span = Math.min(20, candles.length);
  const slowStart = lastFinite(slow.slice(0, Math.max(0, slow.length - span)));
  let slope = 0;
  if (isFiniteNum(slowStart) && lastSlow !== 0) {
    slope = (lastSlow - slowStart) / Math.abs(slowStart);
  }
  const spread = lastFast - lastSlow;
  const lastClose = closes[closes.length - 1] ?? NaN;
  const ref = isFiniteNum(lastClose) && Math.abs(lastClose) > 0 ? Math.abs(lastClose) : Math.max(1, Math.abs(lastSlow));
  const normSpread = Math.min(1, Math.abs(spread) / ref * 20);
  const normSlope = Math.min(1, Math.abs(slope) * 20);

  if (spread > 0 && slope > 0) {
    return { bullish: 0.5 + 0.3 * normSpread + 0.2 * normSlope, bearish: 0 };
  }
  if (spread < 0 && slope < 0) {
    return { bullish: 0, bearish: 0.5 + 0.3 * normSpread + 0.2 * normSlope };
  }
  return { bullish: 0.1, bearish: 0.1 };
}

/** Score momentum via RSI + MACD histogram sign. */
export function scoreMomentum(candles: ReadonlyArray<Candle>): SubScore {
  if (candles.length < 20) return { bullish: 0, bearish: 0 };
  const closes = candles.map((c) => c.close);
  const rsi = rsiSeries(closes, Math.min(14, closes.length - 1));
  const macd = macdSeries(
    closes,
    Math.min(12, closes.length),
    Math.min(26, closes.length),
    Math.min(9, closes.length),
  );
  const lastRsi = lastFinite(rsi);
  const lastHist = lastFinite(macd.histogram);
  const lastMacd = lastFinite(macd.macd);
  const lastSignal = lastFinite(macd.signal);

  const bull: number[] = [];
  const bear: number[] = [];

  if (isFiniteNum(lastRsi)) {
    if (lastRsi > 50) bull.push(Math.min(1, (lastRsi - 50) / 30));
    if (lastRsi < 50) bear.push(Math.min(1, (50 - lastRsi) / 30));
    if (lastRsi >= 70) bull.push(0.3);
    if (lastRsi <= 30) bear.push(0.3);
  }
  if (isFiniteNum(lastHist)) {
    if (lastHist > 0) bull.push(Math.min(1, lastHist / Math.max(1, Math.abs(lastMacd || 1))));
    if (lastHist < 0) bear.push(Math.min(1, -lastHist / Math.max(1, Math.abs(lastMacd || 1))));
  }
  if (isFiniteNum(lastMacd) && isFiniteNum(lastSignal)) {
    if (lastMacd > lastSignal) bull.push(0.2);
    if (lastMacd < lastSignal) bear.push(0.2);
  }
  return {
    bullish: clamp01(sumArr(bull)),
    bearish: clamp01(sumArr(bear)),
  };
}

/** Score volume via up/down volume ratio and volume vs its own average. */
export function scoreVolume(candles: ReadonlyArray<Candle>): SubScore {
  if (candles.length < 10) return { bullish: 0, bearish: 0 };
  const span = Math.min(50, candles.length);
  const window = candles.slice(candles.length - span);
  let upVol = 0;
  let downVol = 0;
  for (let i = 1; i < window.length; i++) {
    const cur = window[i]!;
    const prev = window[i - 1]!;
    if (cur.close > prev.close) upVol += cur.volume;
    else if (cur.close < prev.close) downVol += cur.volume;
  }
  const total = upVol + downVol;
  if (total <= 0) return { bullish: 0.1, bearish: 0.1 };
  const upRatio = upVol / total;

  // Trend day: above-average volume on a series of up-bars.
  const recent = candles.slice(-Math.min(20, candles.length));
  const avgVol = mean(recent.map((c) => c.volume));
  const lastVol = recent[recent.length - 1]?.volume ?? 0;
  const lastDelta = (recent[recent.length - 1]?.close ?? 0) - (recent[recent.length - 2]?.close ?? 0);
  const volConfirm = isFiniteNum(avgVol) && avgVol > 0 && isFiniteNum(lastVol) && lastVol >= 1.5 * avgVol;
  const trendBoost = volConfirm ? (lastDelta > 0 ? 0.3 : lastDelta < 0 ? -0.3 : 0) : 0;

  const base = upRatio;
  const bull = clamp01(base + (trendBoost > 0 ? trendBoost : 0));
  const bear = clamp01((1 - base) + (trendBoost < 0 ? -trendBoost : 0));
  return { bullish: bull, bearish: bear };
}

/** Score market structure from BOS / CHOCH events. */
export function scoreStructure(
  candles: ReadonlyArray<Candle>,
  structure?: ReadonlyArray<MarketStructureEvent>,
): SubScore {
  if (!structure || structure.length === 0) {
    // Fall back to a simple swing-count heuristic.
    return scoreStructureFromSwings(candles);
  }
  let bull = 0;
  let bear = 0;
  for (const ev of structure) {
    if (ev.direction === 'bullish') bull += 0.5;
    else if (ev.direction === 'bearish') bear += 0.5;
  }
  // The most recent event dominates.
  const last = structure[structure.length - 1]!;
  if (last.direction === 'bullish') bull += 0.3;
  else bear += 0.3;
  return {
    bullish: clamp01(Math.min(1, bull)),
    bearish: clamp01(Math.min(1, bear)),
  };
}

function scoreStructureFromSwings(candles: ReadonlyArray<Candle>): SubScore {
  if (candles.length < 10) return { bullish: 0, bearish: 0 };
  const span = Math.min(60, candles.length);
  const window = candles.slice(candles.length - span);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 1; i < window.length - 1; i++) {
    const c = window[i]!;
    const a = window[i - 1]!;
    const b = window[i + 1]!;
    if (c.high > a.high && c.high > b.high) highs.push(c.high);
    if (c.low < a.low && c.low < b.low) lows.push(c.low);
  }
  if (highs.length === 0 && lows.length === 0) return { bullish: 0.1, bearish: 0.1 };
  let hh = 0;
  let hl = 0;
  let lh = 0;
  let ll = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i]! > highs[i - 1]!) hh++;
    else if (highs[i]! < highs[i - 1]!) lh++;
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i]! > lows[i - 1]!) hl++;
    else if (lows[i]! < lows[i - 1]!) ll++;
  }
  const total = hh + hl + lh + ll;
  if (total === 0) return { bullish: 0.1, bearish: 0.1 };
  const bull = (hh + hl) / total;
  const bear = (lh + ll) / total;
  return { bullish: clamp01(bull), bearish: clamp01(bear) };
}

/** Score support / resistance proximity. */
export function scoreSNR(
  price: number,
  snrLevels?: ReadonlyArray<SupportResistanceLevel>,
): SubScore {
  if (!snrLevels || snrLevels.length === 0) return { bullish: 0, bearish: 0 };
  if (!isFiniteNum(price) || price <= 0) return { bullish: 0, bearish: 0 };
  let bull = 0;
  let bear = 0;
  for (const lvl of snrLevels) {
    if (!isFiniteNum(lvl.price)) continue;
    const distance = (lvl.price - price) / price;
    const absDist = Math.abs(distance);
    if (absDist > 0.05) continue; // ignore far-away levels
    const proximity = clamp01(1 - absDist / 0.05);
    const strength = safeNum(lvl.strength, 0.5);
    const contrib = proximity * strength;
    if (lvl.type === 'support' && distance < 0) bull += contrib;
    if (lvl.type === 'resistance' && distance > 0) bear += contrib;
    if (lvl.type === 'support' && distance > 0) bear += contrib * 0.3;
    if (lvl.type === 'resistance' && distance < 0) bull += contrib * 0.3;
  }
  return { bullish: clamp01(bull), bearish: clamp01(bear) };
}

/** Score proximity to a supply / demand zone. */
export function scoreSND(
  price: number,
  sndZones?: ReadonlyArray<SupplyDemandZone>,
): SubScore {
  if (!sndZones || sndZones.length === 0) return { bullish: 0, bearish: 0 };
  if (!isFiniteNum(price) || price <= 0) return { bullish: 0, bearish: 0 };
  let bull = 0;
  let bear = 0;
  for (const z of sndZones) {
    if (!isFiniteNum(z.high) || !isFiniteNum(z.low)) continue;
    if (price >= z.low && price <= z.high) {
      const strength = safeNum(z.strength, 0.5);
      const freshBoost = z.status === 'fresh' ? 0.4 : z.status === 'tested' ? 0.1 : 0;
      if (z.type === 'demand') bull += 0.5 + strength * 0.4 + freshBoost * 0.1;
      if (z.type === 'supply') bear += 0.5 + strength * 0.4 + freshBoost * 0.1;
    } else {
      // Approaching a zone in the direction it points.
      const dist = z.type === 'demand' ? (z.low - price) / price : (price - z.high) / price;
      if (dist > 0 && dist < 0.02) {
        const strength = safeNum(z.strength, 0.5);
        if (z.type === 'demand') bull += 0.2 * strength;
        if (z.type === 'supply') bear += 0.2 * strength;
      }
    }
  }
  return { bullish: clamp01(bull), bearish: clamp01(bear) };
}

/** Score volatility: range expansion / contraction and ATR trend. */
export function scoreVolatility(candles: ReadonlyArray<Candle>): SubScore {
  if (candles.length < 20) return { bullish: 0, bearish: 0 };
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2] ?? last;
  const atr = trueRange(last, prev);
  const span = Math.min(50, candles.length);
  const recent = candles.slice(candles.length - span);
  const ranges: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    ranges.push(trueRange(recent[i]!, recent[i - 1]));
  }
  const avgRange = mean(ranges.filter((r) => isFiniteNum(r) && r > 0));
  if (!isFiniteNum(avgRange) || avgRange <= 0) return { bullish: 0.1, bearish: 0.1 };

  const expansion = atr / avgRange;
  const direction = last.close - prev.close;

  // Expansion with a directional move favours that side.
  if (expansion > 1.2) {
    if (direction > 0) return { bullish: clamp01(0.5 + Math.min(0.5, (expansion - 1) * 0.5)), bearish: 0 };
    if (direction < 0) return { bullish: 0, bearish: clamp01(0.5 + Math.min(0.5, (expansion - 1) * 0.5)) };
  }
  if (expansion < 0.8) {
    return { bullish: 0.1, bearish: 0.1 };
  }
  if (direction > 0) return { bullish: 0.4, bearish: 0.2 };
  if (direction < 0) return { bullish: 0.2, bearish: 0.4 };
  return { bullish: 0.2, bearish: 0.2 };
}

/** Score multi-timeframe confirmation. */
export function scoreMTF(mtf?: MTFAnalysis): SubScore {
  if (!mtf || mtf.cells.length === 0) return { bullish: 0, bearish: 0 };
  const totalWeight = mtf.cells.reduce((acc, c) => acc + Math.abs(safeNum(c.score, 0)), 0) || 1;
  const bull = mtf.cells
    .filter((c) => c.trend === 'bullish' || c.momentum === 'bullish' || c.structure === 'bullish')
    .reduce((acc, c) => acc + Math.max(0, safeNum(c.score, 0)), 0);
  const bear = mtf.cells
    .filter((c) => c.trend === 'bearish' || c.momentum === 'bearish' || c.structure === 'bearish')
    .reduce((acc, c) => acc + Math.max(0, -safeNum(c.score, 0)), 0);
  const bias = mtf.overallBias;
  if (bias === 'bullish') {
    return { bullish: clamp01(0.5 + (bull / totalWeight) * 0.5), bearish: clamp01((bear / totalWeight) * 0.3) };
  }
  if (bias === 'bearish') {
    return { bullish: clamp01((bull / totalWeight) * 0.3), bearish: clamp01(0.5 + (bear / totalWeight) * 0.5) };
  }
  return { bullish: clamp01(0.2 + (bull / totalWeight) * 0.3), bearish: clamp01(0.2 + (bear / totalWeight) * 0.3) };
}

/** Score a confidence bias for an individual category in -1..1. */
export function subScoreSigned(s: SubScore): number {
  return clampRange(s.bullish - s.bearish, -1, 1);
}

/** Translate a sub-score to a directional bias. */
export function subScoreBias(s: SubScore): Bias {
  if (s.bullish === 0 && s.bearish === 0) return 'neutral';
  const diff = s.bullish - s.bearish;
  if (diff > 0.15) return 'bullish';
  if (diff < -0.15) return 'bearish';
  return 'neutral';
}

function clamp01(x: number): number {
  if (!isFiniteNum(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function clampRange(x: number, lo: number, hi: number): number {
  if (!isFiniteNum(x)) return 0;
  return Math.min(hi, Math.max(lo, x));
}

function sumArr(arr: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] ?? 0;
    if (isFiniteNum(v)) s += v;
  }
  return s;
}

// re-export sma/ema for tests that want to spot-check primitives
export { sma, ema };
