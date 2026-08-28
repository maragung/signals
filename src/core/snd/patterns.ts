// Detect supply & demand zone patterns.
//
// Pattern glossary:
//
//   Base-Rally (Demand): a tight base (small bodies over a few candles)
//     followed by a strong bullish departure (large green candle that
//     closes above the base and ideally continues higher).
//
//   Base-Drop (Supply): mirror -- tight base followed by a strong
//     bearish departure (large red candle that closes below the base).
//
//   Rally-Base-Rally (Demand): strong up move, tight base, strong up
//     move. The base is the pullback that consolidates the prior leg
//     up. The second rally is the fresh departure.
//
//   Drop-Base-Drop (Supply): strong down move, tight base, strong down
//     move. Mirror of RBR.
//
// All patterns return a *candidate* zone with origin time, base, and
// departure characteristics. The detector later scores and status-tags
// each candidate.

import type { Candle } from '@/types';
import { isFiniteNum, safeNum, mean } from '@/core/utils/series';

export type ZonePattern = 'base-rally' | 'base-drop' | 'rally-base-rally' | 'drop-base-drop';

export interface PatternOptions {
  /** Number of candles in the base. Default 3. */
  baseLength: number;
  /**
   * Max ratio of (base range / departure range). Smaller = tighter
   * base. Default 0.5.
   */
  baseTightness: number;
  /**
   * Minimum body size of the departure candle as a fraction of the
   * recent average range. Default 1.5.
   */
  departureSize: number;
  /** Window for the recent average range. Default 14. */
  rangeWindow: number;
  /**
   * Optional minimum number of candles after the departure for it to
   * count as a "strong" departure (continuation). Default 1.
   */
  continuationBars: number;
  /**
   * Minimum continuation move (in fraction of the departure) required.
   * Default 0.
   */
  continuationRatio: number;
}

export const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  baseLength: 3,
  baseTightness: 0.5,
  departureSize: 1.5,
  rangeWindow: 14,
  continuationBars: 1,
  continuationRatio: 0,
};

export interface ZoneCandidate {
  pattern: ZonePattern;
  type: 'supply' | 'demand';
  base: { high: number; low: number };
  high: number;
  low: number;
  originTime: number;
  /** Absolute size of the departure move, in price units. */
  departureSize: number;
  /** Average volume during the base. */
  baseVolume: number;
}

function candleRange(c: Candle): number {
  return c.high - c.low;
}

function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function isTightBase(candles: Candle[], start: number, len: number, tightness: number): boolean {
  if (start + len > candles.length) return false;
  let high = -Infinity;
  let low = Infinity;
  let totalRange = 0;
  for (let i = start; i < start + len; i++) {
    const c = candles[i];
    if (!c) return false;
    if (!isFiniteNum(c.high) || !isFiniteNum(c.low) || !isFiniteNum(c.open) || !isFiniteNum(c.close)) return false;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    totalRange += candleRange(c);
  }
  const baseRange = high - low;
  if (baseRange <= 0) return false;
  const avgRange = totalRange / len;
  return baseRange <= avgRange * tightness;
}

function avgBaseVolume(candles: Candle[], start: number, len: number): number {
  let s = 0;
  for (let i = start; i < start + len; i++) {
    const c = candles[i];
    if (c) s += safeNum(c.volume);
  }
  return s / Math.max(1, len);
}

function recentAvgRange(candles: Candle[], upToIndex: number, window: number): number {
  const start = Math.max(0, upToIndex - window);
  const ranges: number[] = [];
  for (let i = start; i < upToIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    if (isFiniteNum(c.high) && isFiniteNum(c.low)) ranges.push(candleRange(c));
  }
  return mean(ranges) || 0;
}

/**
 * Detect a single Base-Rally or Base-Drop pattern around a departure
 * candle at `departureIndex`.
 *
 * Returns null if the pattern is not valid.
 */
function detectBaseDeparture(
  candles: Candle[],
  departureIndex: number,
  options: PatternOptions,
  type: 'demand' | 'supply',
): ZoneCandidate | null {
  const c = candles[departureIndex];
  if (!c) return null;
  if (!isFiniteNum(c.open) || !isFiniteNum(c.close) || !isFiniteNum(c.high) || !isFiniteNum(c.low)) return null;

  const isBullish = c.close > c.open;
  const wantBullish = type === 'demand';
  if (isBullish !== wantBullish) return null;

  const baseStart = departureIndex - options.baseLength;
  if (baseStart < 0) return null;
  if (!isTightBase(candles, baseStart, options.baseLength, options.baseTightness)) {
    return null;
  }

  // Base range
  let baseHigh = -Infinity;
  let baseLow = Infinity;
  for (let i = baseStart; i < baseStart + options.baseLength; i++) {
    const cc = candles[i];
    if (!cc) continue;
    if (cc.high > baseHigh) baseHigh = cc.high;
    if (cc.low < baseLow) baseLow = cc.low;
  }
  if (!isFiniteNum(baseHigh) || !isFiniteNum(baseLow) || baseHigh <= baseLow) return null;

  // Departure size check
  const dep = bodySize(c);
  const avgR = recentAvgRange(candles, departureIndex, options.rangeWindow);
  if (avgR <= 0) return null;
  if (dep < avgR * options.departureSize) return null;

  // Optional continuation check
  if (options.continuationBars > 0) {
    const end = Math.min(candles.length, departureIndex + 1 + options.continuationBars);
    let totalCont = 0;
    for (let i = departureIndex + 1; i < end; i++) {
      const cc = candles[i];
      if (!cc) continue;
      if (wantBullish) {
        totalCont += Math.max(0, cc.close - cc.open);
      } else {
        totalCont += Math.max(0, cc.open - cc.close);
      }
    }
    if (totalCont < dep * options.continuationRatio) return null;
  }

  const pattern: ZonePattern = wantBullish ? 'base-rally' : 'base-drop';
  const zoneHigh = wantBullish ? baseHigh : baseHigh;
  const zoneLow = wantBullish ? baseLow : baseLow;
  return {
    pattern,
    type,
    base: { high: baseHigh, low: baseLow },
    high: zoneHigh,
    low: zoneLow,
    originTime: candles[baseStart]!.time,
    departureSize: dep,
    baseVolume: avgBaseVolume(candles, baseStart, options.baseLength),
  };
}

/**
 * Detect a Rally-Base-Rally or Drop-Base-Drop pattern. Two strong
 * legs sandwich a tight base. The first leg ends at the end of the
 * pre-base, the second leg starts at the end of the base.
 */
function detectLegBaseLeg(
  candles: Candle[],
  preEndIndex: number,
  options: PatternOptions,
  type: 'demand' | 'supply',
): ZoneCandidate | null {
  const wantBullish = type === 'demand';

  // First leg: from (preEndIndex - firstLegLen + 1) to preEndIndex
  // We don't constrain leg length strictly; instead we look at the
  // total move over the leg and ensure it exceeds the base range.
  const firstLegStart = preEndIndex - Math.max(options.baseLength, 1);
  if (firstLegStart < 0) return null;

  // The base starts at preEndIndex + 1 (after the first leg)
  const baseStart = preEndIndex + 1;
  if (baseStart + options.baseLength > candles.length) return null;
  if (!isTightBase(candles, baseStart, options.baseLength, options.baseTightness)) return null;

  // Second leg: must be the candle right after the base
  const depIndex = baseStart + options.baseLength;
  if (depIndex >= candles.length) return null;
  const c = candles[depIndex];
  if (!c) return null;
  if (!isFiniteNum(c.open) || !isFiniteNum(c.close)) return null;
  const isBullish = c.close > c.open;
  if (isBullish !== wantBullish) return null;

  // First leg magnitude
  const first = candles[firstLegStart];
  const last = candles[preEndIndex];
  if (!first || !last) return null;
  if (!isFiniteNum(first.close) || !isFiniteNum(last.close)) return null;
  const legMove = last.close - first.close;
  if (wantBullish ? legMove <= 0 : legMove >= 0) return null;
  const legMag = Math.abs(legMove);

  // Base range
  let baseHigh = -Infinity;
  let baseLow = Infinity;
  for (let i = baseStart; i < baseStart + options.baseLength; i++) {
    const cc = candles[i];
    if (!cc) continue;
    if (cc.high > baseHigh) baseHigh = cc.high;
    if (cc.low < baseLow) baseLow = cc.low;
  }
  if (!isFiniteNum(baseHigh) || !isFiniteNum(baseLow) || baseHigh <= baseLow) return null;
  const baseRange = baseHigh - baseLow;
  if (baseRange <= 0) return null;

  // Departure must be strong
  const dep = bodySize(c);
  const avgR = recentAvgRange(candles, depIndex, options.rangeWindow);
  if (avgR <= 0) return null;
  if (dep < avgR * options.departureSize) return null;

  // The two legs should be of similar magnitude for a "real" RBR/DBD
  // (we just need the second leg to be non-zero)
  if (dep <= 0) return null;

  const pattern: ZonePattern = wantBullish ? 'rally-base-rally' : 'drop-base-drop';
  return {
    pattern,
    type,
    base: { high: baseHigh, low: baseLow },
    high: baseHigh,
    low: baseLow,
    originTime: candles[baseStart]!.time,
    departureSize: Math.max(legMag, dep),
    baseVolume: avgBaseVolume(candles, baseStart, options.baseLength),
  };
}

/**
 * Scan the candle series for all valid SND zone candidates.
 *
 * The function tries every possible window position; overlapping
 * candidates are deduplicated later by the detector.
 */
export function detectPatterns(
  candles: Candle[],
  options: Partial<PatternOptions> = {},
): ZoneCandidate[] {
  const opts: PatternOptions = { ...DEFAULT_PATTERN_OPTIONS, ...options };
  const n = candles.length;
  const out: ZoneCandidate[] = [];

  if (n < opts.baseLength + 1) return out;

  for (let i = opts.baseLength; i < n; i++) {
    const c = candles[i];
    if (!c) continue;
    if (!isFiniteNum(c.open) || !isFiniteNum(c.close)) continue;

    const wantBullish = c.close > c.open;
    const cand = wantBullish
      ? detectBaseDeparture(candles, i, opts, 'demand')
      : detectBaseDeparture(candles, i, opts, 'supply');
    if (cand) out.push(cand);

    // RBR / DBD: requires the candle at i (end of first leg) to be
    // the last in a strong first leg.
    if (i - opts.baseLength - 1 >= 0) {
      const cand2 = wantBullish
        ? detectLegBaseLeg(candles, i, opts, 'demand')
        : detectLegBaseLeg(candles, i, opts, 'supply');
      if (cand2) out.push(cand2);
    }
  }
  return out;
}
