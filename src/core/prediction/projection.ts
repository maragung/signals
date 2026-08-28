// Technical projection engine.
//
// `buildProjection` consumes a scoring result plus optional SNR,
// SND, and market structure context and produces a fully self-
// contained `TechnicalProjection` with directional bias, entry
// zone, support / resistance, TP1/TP2/TP3, invalidation, and
// risk/reward. All math is deterministic and based on the latest
// price plus ATR.

import type {
  Bias,
  Candle,
  MarketStructureEvent,
  ProjectionLevel,
  ScoringResult,
  SupplyDemandZone,
  SupportResistanceLevel,
  TechnicalProjection,
  Timeframe,
} from '@/types';
import { clamp, isFiniteNum, safeNum } from '@/core/utils/series';
import { atrSeries } from '@/core/strategies/indicators';

export const PROJECTION_DISCLAIMER =
  'This is a technical/probabilistic projection based on deterministic algorithms. It is NOT a guarantee of future price.';

export interface ProjectionContext {
  symbol: string;
  timeframe: Timeframe;
  /** Optional override ATR (otherwise computed from candles). */
  atr?: number;
  /** Optional override current price (otherwise the last close). */
  price?: number;
  /** Optional override generatedAt timestamp (ms). */
  generatedAt?: number;
  /** Wall-clock now used for generatedAt. */
  nowMs?: number;
  /** Pre-computed support/resistance. */
  snr?: SupportResistanceLevel[];
  /** Pre-computed supply/demand. */
  snd?: SupplyDemandZone[];
  /** Pre-computed market structure. */
  structure?: MarketStructureEvent[];
  /** Configurable target multipliers. */
  targetMultipliers?: {
    r1?: number; // first R multiple
    r2?: number; // second R multiple
    r3?: number; // third R multiple (also a fib extension fallback)
    extension?: number; // used when no extension is found in SNR
  };
}

interface ProjectionParams {
  r1: number;
  r2: number;
  r3: number;
  extension: number;
}

const DEFAULT_PARAMS: ProjectionParams = { r1: 1, r2: 2, r3: 3, extension: 1.618 };

export function buildProjection(
  candles: ReadonlyArray<Candle>,
  score: ScoringResult,
  context: ProjectionContext,
): TechnicalProjection {
  const params: ProjectionParams = { ...DEFAULT_PARAMS, ...(context.targetMultipliers ?? {}) };
  const last = candles[candles.length - 1];
  const price = isFiniteNum(context.price) ? context.price : last?.close ?? 0;
  const atr = isFiniteNum(context.atr) && context.atr > 0
    ? context.atr
    : lastAtr(candles);
  const generatedAt = isFiniteNum(context.generatedAt)
    ? context.generatedAt!
    : context.nowMs ?? last?.time ? last.time * 1000 : Date.now();

  const direction: Bias = score.bias;

  // Confidence = clamp(0.5 + (net/total) * 0.5) + small agreement bonus.
  const ratio = score.total > 0 ? score.net / score.total : 0;
  let confidence = clamp(0.5 + ratio * 0.5, 0, 1);
  const agreement = countAgreement(score.breakdown);
  if (agreement.bull >= 3 || agreement.bear >= 3) confidence = clamp(confidence + 0.05, 0, 1);

  // Entry zone: current price +/- max(ATR * 0.5, 0.001 * price)
  const entrySpan = atr > 0 ? atr * 0.5 : Math.max(0.001 * price, 1e-8);
  const entryZone = { low: price - entrySpan, high: price + entrySpan };

  // Support / resistance: nearest levels in either direction.
  const supportLevel = findNearestLevel(context.snr, price, 'support');
  const resistanceLevel = findNearestLevel(context.snr, price, 'resistance');

  // Compute the 1R distance: |entry - invalidation| where invalidation
  // sits one ATR beyond the opposite level.
  const oneAtr = atr;
  const longSetup = direction !== 'bearish';
  const shortSetup = direction !== 'bullish';

  let invalidation: number | undefined;
  let r1Target: number | undefined;
  let r2Target: number | undefined;
  let r3Target: number | undefined;

  if (longSetup) {
    // Stop sits below the nearest support by 1 ATR; if no support, below price by 1.5 ATR.
    const anchor = supportLevel !== undefined ? supportLevel : price;
    invalidation = anchor - oneAtr;
    // R = |entry - invalidation| (we use the midpoint of the entry zone)
    const r = Math.max(1e-12, Math.abs(price - invalidation));
    r1Target = price + r * params.r1;
    r2Target = price + r * params.r2;
    r3Target = resistanceLevel !== undefined
      ? Math.max(resistanceLevel, price + r * params.r3)
      : price + r * params.r3;
  } else if (shortSetup) {
    const anchor = resistanceLevel !== undefined ? resistanceLevel : price;
    invalidation = anchor + oneAtr;
    const r = Math.max(1e-12, Math.abs(invalidation - price));
    r1Target = price - r * params.r1;
    r2Target = price - r * params.r2;
    r3Target = supportLevel !== undefined
      ? Math.min(supportLevel, price - r * params.r3)
      : price - r * params.r3;
  }

  // TP1 = nearest resistance (long) / support (short) OR 1R; we honour the
  // closer of the two.
  const tp1 = chooseTp1(direction, price, r1Target, supportLevel, resistanceLevel);
  const tp2 = r2Target;
  // TP3: prefer 1.618 extension of the recent swing (swingHigh - swingLow)
  // when available, else 3R.
  const swingRange = recentSwingRange(candles);
  let tp3: number | undefined = r3Target;
  if (swingRange && isFiniteNum(swingRange) && swingRange > 0) {
    if (direction === 'bullish') {
      const ext = recentSwingHigh(candles) + swingRange * (params.extension - 1);
      tp3 = isFiniteNum(tp3) ? Math.max(tp3!, ext) : ext;
    } else if (direction === 'bearish') {
      const ext = recentSwingLow(candles) - swingRange * (params.extension - 1);
      tp3 = isFiniteNum(tp3) ? Math.min(tp3!, ext) : ext;
    }
  }

  const targets: ProjectionLevel[] = [];
  if (isFiniteNum(tp1)) targets.push({ label: 'TP1', price: tp1! });
  if (isFiniteNum(tp2)) targets.push({ label: 'TP2', price: tp2! });
  if (isFiniteNum(tp3)) targets.push({ label: 'TP3', price: tp3! });

  const riskReward = computeRiskReward(price, tp1, invalidation);

  // Expected volatility = ATR% / price
  const expectedVolatility = price > 0 && atr > 0 ? (atr / price) * 100 : undefined;

  return {
    symbol: context.symbol,
    timeframe: context.timeframe,
    direction,
    score: score.net,
    total: score.total,
    confidence,
    entryZone,
    support: supportLevel,
    resistance: resistanceLevel,
    targets,
    invalidation: invalidation !== undefined && isFiniteNum(invalidation) ? invalidation : undefined,
    riskReward,
    expectedVolatility: isFiniteNum(expectedVolatility) ? expectedVolatility : undefined,
    disclaimer: PROJECTION_DISCLAIMER,
    generatedAt,
  };
}

// ----- helpers ---------------------------------------------------------------

function lastAtr(candles: ReadonlyArray<Candle>): number {
  if (candles.length < 2) return 0;
  const arr = atrSeries(candles, Math.min(14, candles.length));
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (isFiniteNum(v) && v > 0) return v;
  }
  return 0;
}

function findNearestLevel(
  levels: ReadonlyArray<SupportResistanceLevel> | undefined,
  price: number,
  type: 'support' | 'resistance',
): number | undefined {
  if (!levels || levels.length === 0) return undefined;
  let best: number | undefined;
  let bestDist = Infinity;
  for (const l of levels) {
    if (l.type !== type) continue;
    if (!isFiniteNum(l.price)) continue;
    if (type === 'support' && l.price >= price) continue;
    if (type === 'resistance' && l.price <= price) continue;
    const d = Math.abs(l.price - price);
    if (d < bestDist) {
      bestDist = d;
      best = l.price;
    }
  }
  return best;
}

function chooseTp1(
  direction: Bias,
  price: number,
  r1: number | undefined,
  support: number | undefined,
  resistance: number | undefined,
): number | undefined {
  if (direction === 'bullish' || direction === 'neutral') {
    const candidates: number[] = [];
    if (isFiniteNum(r1) && r1! > price) candidates.push(r1!);
    if (isFiniteNum(resistance) && resistance! > price) candidates.push(resistance!);
    if (candidates.length === 0) return r1;
    return Math.min(...candidates);
  }
  if (direction === 'bearish') {
    const candidates: number[] = [];
    if (isFiniteNum(r1) && r1! < price) candidates.push(r1!);
    if (isFiniteNum(support) && support! < price) candidates.push(support!);
    if (candidates.length === 0) return r1;
    return Math.max(...candidates);
  }
  return r1;
}

function computeRiskReward(
  price: number,
  tp1: number | undefined,
  invalidation: number | undefined,
): number | undefined {
  if (!isFiniteNum(tp1) || !isFiniteNum(invalidation)) return undefined;
  const reward = Math.abs(tp1! - price);
  const risk = Math.abs(price - invalidation!);
  if (risk <= 0) return undefined;
  return reward / risk;
}

function countAgreement(breakdown: import('@/types').ScoreBreakdown): { bull: number; bear: number } {
  let bull = 0;
  let bear = 0;
  for (const k of Object.keys(breakdown) as (keyof import('@/types').ScoreBreakdown)[]) {
    const v = breakdown[k];
    if (v > 0) bull++;
    else if (v < 0) bear++;
  }
  return { bull, bear };
}

function recentSwingHigh(candles: ReadonlyArray<Candle>): number {
  const span = Math.min(50, candles.length);
  if (span === 0) return NaN;
  let best = -Infinity;
  for (let i = candles.length - span; i < candles.length; i++) {
    const c = candles[i];
    if (c && c.high > best) best = c.high;
  }
  return best;
}

function recentSwingLow(candles: ReadonlyArray<Candle>): number {
  const span = Math.min(50, candles.length);
  if (span === 0) return NaN;
  let best = Infinity;
  for (let i = candles.length - span; i < candles.length; i++) {
    const c = candles[i];
    if (c && c.low < best) best = c.low;
  }
  return best;
}

function recentSwingRange(candles: ReadonlyArray<Candle>): number | undefined {
  const h = recentSwingHigh(candles);
  const l = recentSwingLow(candles);
  if (!isFiniteNum(h) || !isFiniteNum(l)) return undefined;
  const range = h - l;
  return range > 0 ? range : undefined;
}

export { safeNum };
