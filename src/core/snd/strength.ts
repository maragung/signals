// Compute a 0..1 strength score for a supply / demand zone.
//
// Formula (per spec):
//
//   strength = departureSize * 0.4
//            + volume       * 0.2
//            + freshness    * 0.4
//
// where:
//   departureSize = body size of the departure candle normalized by
//                   the recent average candle range
//   volume        = base volume normalized by the recent average volume
//   freshness     = 1 / (1 + barsSince / 100)  -- decays with age
//
// All components are clamped to [0..1] before being combined.

import type { Candle, SupplyDemandZone } from '@/types';
import { isFiniteNum, clamp, mean } from '@/core/utils/series';
import type { ZoneCandidate } from './patterns';

export interface StrengthOptions {
  /** Window for computing the recent average range / volume. */
  rangeWindow: number;
  /** Maximum bars considered "fresh" (after this, freshness -> 0). */
  freshnessDecay: number;
}

export const DEFAULT_STRENGTH_OPTIONS: StrengthOptions = {
  rangeWindow: 14,
  freshnessDecay: 100,
};

function recentAvgRange(candles: Candle[], upToIndex: number, window: number): number {
  const start = Math.max(0, upToIndex - window);
  const ranges: number[] = [];
  for (let i = start; i < upToIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    if (isFiniteNum(c.high) && isFiniteNum(c.low)) ranges.push(c.high - c.low);
  }
  return mean(ranges) || 0;
}

function recentAvgVolume(candles: Candle[], upToIndex: number, window: number): number {
  const start = Math.max(0, upToIndex - window);
  const vols: number[] = [];
  for (let i = start; i < upToIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    if (isFiniteNum(c.volume)) vols.push(c.volume);
  }
  return mean(vols) || 0;
}

/** Compute the freshness factor for a zone. */
export function freshnessFactor(barsSince: number, decay: number): number {
  if (!isFiniteNum(barsSince) || barsSince < 0) return 0;
  if (decay <= 0) return 0;
  return clamp(1 / (1 + barsSince / decay), 0, 1);
}

/** Volume component (0..1). */
export function volumeComponent(baseVolume: number, avgVolume: number): number {
  if (!isFiniteNum(baseVolume) || !isFiniteNum(avgVolume) || avgVolume <= 0) return 0;
  return clamp(baseVolume / (avgVolume * 2), 0, 1);
}

/** Departure size component (0..1). */
export function departureComponent(departureSize: number, avgRange: number): number {
  if (!isFiniteNum(departureSize) || !isFiniteNum(avgRange) || avgRange <= 0) return 0;
  return clamp(departureSize / (avgRange * 3), 0, 1);
}

/** Combined strength in [0..1]. */
export function computeZoneStrength(
  departureSize: number,
  baseVolume: number,
  freshness: number,
): number {
  const d = clamp(isFiniteNum(departureSize) ? departureSize : 0, 0, 1);
  const v = clamp(isFiniteNum(baseVolume) ? baseVolume : 0, 0, 1);
  const f = clamp(isFiniteNum(freshness) ? freshness : 0, 0, 1);
  return clamp(d * 0.4 + v * 0.2 + f * 0.4, 0, 1);
}

/**
 * Build the strength score for a candidate zone using the candle
 * series to compute the recency-relative base volume and average range.
 */
export function scoreCandidate(
  cand: ZoneCandidate,
  candles: Candle[],
  options: Partial<StrengthOptions> = {},
): number {
  const opts: StrengthOptions = { ...DEFAULT_STRENGTH_OPTIONS, ...options };
  // Locate the departure index by finding the candle at originTime
  // (which marks the START of the base; the departure candle is
  // baseLength candles later).
  let baseStart = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.time === cand.originTime) {
      baseStart = i;
      break;
    }
  }
  // We use the end of the base as the reference index for the
  // recent-average computations. If we couldn't find originTime we
  // fall back to the last candle.
  const refIndex = baseStart >= 0 ? baseStart : candles.length - 1;
  const avgR = recentAvgRange(candles, refIndex, opts.rangeWindow);
  const avgV = recentAvgVolume(candles, refIndex, opts.rangeWindow);
  const dComp = departureComponent(cand.departureSize, avgR);
  const vComp = volumeComponent(cand.baseVolume, avgV);
  const fComp = freshnessFactor(Math.max(0, candles.length - 1 - refIndex), opts.freshnessDecay);
  return computeZoneStrength(dComp, vComp, fComp);
}

/** Convenience: apply a strength to a zone (returns a new zone object). */
export function scoreZone(
  zone: SupplyDemandZone,
  candles: Candle[],
  options: Partial<StrengthOptions> = {},
): SupplyDemandZone {
  const refIndex = candles.findIndex((c) => c.time === zone.originTime);
  const idx = refIndex >= 0 ? refIndex : candles.length - 1;
  const opts: StrengthOptions = { ...DEFAULT_STRENGTH_OPTIONS, ...options };
  const avgR = recentAvgRange(candles, idx, opts.rangeWindow);
  const avgV = recentAvgVolume(candles, idx, opts.rangeWindow);
  const zoneRange = Math.max(0, zone.high - zone.low);
  const dComp = departureComponent(zoneRange, avgR);
  // Use base volume proxy: nothing available in the zone itself, so
  // fall back to the recent average.
  const vComp = volumeComponent(avgV, avgV);
  const fComp = freshnessFactor(Math.max(0, candles.length - 1 - idx), opts.freshnessDecay);
  const strength = computeZoneStrength(dComp, vComp, fComp);
  return { ...zone, strength };
}
