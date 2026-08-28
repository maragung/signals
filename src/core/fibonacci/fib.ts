// Fibonacci engine.
//
// `autoFibonacci` finds the most recent swing high / low in the
// `lookback` window and computes the retracement and extension
// levels using the supplied `FibConfig`. `manualFibonacci` is used
// for user-drawn sequences from two anchor points.

import type { Candle, FibConfig, FibonacciLevel } from '@/types';
import { isFiniteNum } from '@/core/utils/series';

export type FibDirection = 'up' | 'down';

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

export interface AutoFibResult {
  swingHigh: SwingPoint;
  swingLow: SwingPoint;
  direction: FibDirection;
  retracements: FibonacciLevel[];
  extensions: FibonacciLevel[];
  range: number;
}

/** Locate the most recent swing high and low in the last `lookback` bars. */
export function findRecentSwings(
  candles: ReadonlyArray<Candle>,
  lookback: number,
): { swingHigh: SwingPoint; swingLow: SwingPoint; direction: FibDirection } | undefined {
  if (candles.length === 0) return undefined;
  const span = Math.max(2, Math.min(lookback, candles.length));
  const start = candles.length - span;

  let high: SwingPoint | undefined;
  let low: SwingPoint | undefined;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    if (!high || c.high > high.price) {
      high = { index: i, time: c.time, price: c.high, kind: 'high' };
    }
    if (!low || c.low < low.price) {
      low = { index: i, time: c.time, price: c.low, kind: 'low' };
    }
  }
  if (!high || !low) return undefined;
  // The "direction" of the move is the relative position of high vs low
  // in the lookback window: if high comes after low, the move is up.
  const direction: FibDirection = high.index >= low.index ? 'up' : 'down';
  return { swingHigh: high, swingLow: low, direction };
}

/** Compute retracement levels: high - (high - low) * ratio. */
export function retracementLevels(
  high: number,
  low: number,
  ratios: ReadonlyArray<number>,
): FibonacciLevel[] {
  const out: FibonacciLevel[] = [];
  if (!isFiniteNum(high) || !isFiniteNum(low)) return out;
  for (const r of ratios) {
    if (!isFiniteNum(r)) continue;
    const price = high - (high - low) * r;
    if (isFiniteNum(price)) out.push({ ratio: r, price, visible: true });
  }
  return out;
}

/**
 * Compute extension levels for a directional move from anchor p1 to
 * anchor p2. The third anchor is implicit (the leg that follows p2).
 *   - direction "up"   : price = p2 + (p2 - p1) * ratio
 *   - direction "down" : price = p2 - (p1 - p2) * ratio
 *
 * For "down" we use (p1 - p2) so a 200 -> 100 anchor (p1=200, p2=100)
 * projects a further |p1-p2| move downward, giving 0 at ratio 1.
 */
export function extensionLevels(
  p1: number,
  p2: number,
  ratios: ReadonlyArray<number>,
  direction: FibDirection,
): FibonacciLevel[] {
  const out: FibonacciLevel[] = [];
  if (!isFiniteNum(p1) || !isFiniteNum(p2)) return out;
  for (const r of ratios) {
    if (!isFiniteNum(r)) continue;
    let price: number;
    if (direction === 'up') {
      price = p2 + (p2 - p1) * r;
    } else {
      price = p2 - (p1 - p2) * r;
    }
    if (isFiniteNum(price)) out.push({ ratio: r, price, visible: true });
  }
  return out;
}

/** Compute full auto-fib set for the recent swing. */
export function autoFibonacci(
  candles: ReadonlyArray<Candle>,
  lookback: number,
  config: FibConfig,
): AutoFibResult | undefined {
  const swings = findRecentSwings(candles, lookback);
  if (!swings) return undefined;
  const { swingHigh, swingLow, direction } = swings;
  const high = swingHigh.price;
  const low = swingLow.price;
  const range = high - low;
  const retracements = retracementLevels(high, low, config.retracements);
  // For extensions, use the same anchor convention as manual:
  // up: p1 = low, p2 = high. down: p1 = high, p2 = low.
  const extAnchor1 = direction === 'up' ? low : high;
  const extAnchor2 = direction === 'up' ? high : low;
  const extensions = extensionLevels(extAnchor1, extAnchor2, config.extensions, direction);
  return { swingHigh, swingLow, direction, retracements, extensions, range };
}

/** Build retracement + extension levels from two user anchor points. */
export function manualFibonacci(
  p1: { price: number; time?: number },
  p2: { price: number; time?: number },
  direction: FibDirection,
  config: FibConfig,
): { retracements: FibonacciLevel[]; extensions: FibonacciLevel[]; range: number; high: number; low: number } {
  if (!isFiniteNum(p1.price) || !isFiniteNum(p2.price)) {
    return { retracements: [], extensions: [], range: 0, high: 0, low: 0 };
  }
  const high = Math.max(p1.price, p2.price);
  const low = Math.min(p1.price, p2.price);
  const range = high - low;
  const retracements = retracementLevels(high, low, config.retracements);
  const extensions = extensionLevels(p1.price, p2.price, config.extensions, direction);
  return { retracements, extensions, range, high, low };
}
