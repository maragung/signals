// Compute a 0..1 strength score for a support / resistance level.
//
// Formula (per spec):
//
//   strength = touches * 0.3
//            + reactionMagnitude * 0.4
//            + recency * 0.3
//
// Each component is normalized into [0..1] before being combined. The
// function accepts a list of touch events and the candle series so it
// can derive the reaction magnitude (max distance price travelled away
// from the level after a touch) and the recency (how recent the most
// recent touch was).

import type { Candle, SupportResistanceLevel } from '@/types';
import { isFiniteNum, clamp } from '@/core/utils/series';

export interface TouchEvent {
  time: number;
  /** Price at the touch. */
  price: number;
  /**
   * Magnitude of the reaction that followed (e.g. max |delta| over the
   * next N candles). 0..1+ where 1 is "average move".
   */
  reactionMagnitude: number;
}

export interface StrengthOptions {
  /** Maximum touches to consider for normalization. Default 10. */
  maxTouches: number;
  /**
   * Number of bars to look ahead for measuring the reaction
   * magnitude. Default 10.
   */
  reactionWindow: number;
  /**
   * Number of bars to use as the recency decay half-life. Default 50.
   * After this many bars the recency factor drops to ~0.5.
   */
  recencyHalfLife: number;
}

export const DEFAULT_STRENGTH_OPTIONS: StrengthOptions = {
  maxTouches: 10,
  reactionWindow: 10,
  recencyHalfLife: 50,
};

/** Compute the reaction magnitude for a touch at the given candle. */
export function reactionMagnitude(
  candles: Candle[],
  touchIndex: number,
  level: number,
  window: number,
): number {
  if (touchIndex < 0 || touchIndex >= candles.length) return 0;
  const c = candles[touchIndex];
  if (!c || !isFiniteNum(c.close)) return 0;
  const ref = Math.max(Math.abs(level), 1);
  const end = Math.min(candles.length, touchIndex + 1 + window);
  let maxMove = 0;
  for (let i = touchIndex + 1; i < end; i++) {
    const cc = candles[i];
    if (!cc) continue;
    if (!isFiniteNum(cc.high) || !isFiniteNum(cc.low)) continue;
    // Measure distance from level on both sides
    const upDist = Math.abs(cc.high - level);
    const downDist = Math.abs(level - cc.low);
    const m = Math.max(upDist, downDist);
    if (m > maxMove) maxMove = m;
  }
  // Normalize by reference price
  return clamp(maxMove / ref, 0, 1);
}

/** Recency factor based on bars since the last touch. */
export function recencyFactor(barsSince: number, halfLife: number): number {
  if (!isFiniteNum(barsSince) || barsSince < 0) return 0;
  if (halfLife <= 0) return 1;
  return clamp(Math.exp(-Math.LN2 * (barsSince / halfLife)), 0, 1);
}

/**
 * Compute a strength score for a level.
 *
 * @param touches total number of touches
 * @param magnitude average reaction magnitude across touches (0..1)
 * @param recency recency factor (0..1, 1 = just happened)
 */
export function computeStrength(
  touches: number,
  magnitude: number,
  recency: number,
): number {
  const t = clamp(isFiniteNum(touches) ? touches / 10 : 0, 0, 1);
  const m = clamp(isFiniteNum(magnitude) ? magnitude : 0, 0, 1);
  const r = clamp(isFiniteNum(recency) ? recency : 0, 0, 1);
  return clamp(t * 0.3 + m * 0.4 + r * 0.3, 0, 1);
}

/**
 * Build a level's strength from its touch history and the candle series.
 *
 * Pure function. Returns a NEW level object with the same `id` and
 * metadata but updated `strength` and `touches`.
 */
export function scoreLevel(
  level: SupportResistanceLevel,
  candles: Candle[],
  options: Partial<StrengthOptions> = {},
): SupportResistanceLevel {
  const maxTouches = options.maxTouches ?? DEFAULT_STRENGTH_OPTIONS.maxTouches;
  const reactionWindow = options.reactionWindow ?? DEFAULT_STRENGTH_OPTIONS.reactionWindow;
  const halfLife = options.recencyHalfLife ?? DEFAULT_STRENGTH_OPTIONS.recencyHalfLife;

  // Re-derive touches by counting how many candles wick into the level
  // band. We define a band as ±(level * 0.1%) by default.
  const band = Math.max(Math.abs(level.price), 1) * 0.001;
  const touchIndices: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    if (level.type === 'support') {
      // A support touch is when the low of the candle is near the level
      if (Math.abs(c.low - level.price) <= band) touchIndices.push(i);
    } else {
      if (Math.abs(c.high - level.price) <= band) touchIndices.push(i);
    }
  }
  const touches = Math.min(maxTouches, touchIndices.length);
  let totalMag = 0;
  let count = 0;
  let lastIndex = -1;
  for (const idx of touchIndices) {
    totalMag += reactionMagnitude(candles, idx, level.price, reactionWindow);
    count++;
    if (idx > lastIndex) lastIndex = idx;
  }
  const avgMag = count > 0 ? totalMag / count : 0;
  const barsSince = lastIndex >= 0 ? candles.length - 1 - lastIndex : candles.length;
  const recency = recencyFactor(barsSince, halfLife);
  const strength = computeStrength(touches, avgMag, recency);
  return { ...level, strength, touches };
}
