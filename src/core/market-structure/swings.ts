// Swing high / swing low detection using a symmetric lookback window.
//
// A swing high at index i (with lookback L) requires that candle[i].high
// is the strict maximum among candles[i-L .. i+L].
// A swing low at index i requires that candle[i].low is the strict minimum
// among candles[i-L .. i+L].
//
// This is the canonical zigzag-style swing definition. The function returns
// only the *confirmed* swings (those that have a full window to the right
// in the source array), so it is suitable for incremental use as well as
// batch analysis.

import type { Candle } from '@/types';
import { isFiniteNum } from '@/core/utils/series';

export interface SwingPoint {
  time: number;
  price: number;
  index: number;
  kind: 'high' | 'low';
}

export interface SwingOptions {
  /** Number of candles on each side that must be strictly lower (for highs) or higher (for lows). */
  lookback: number;
}

export const DEFAULT_SWING_OPTIONS: SwingOptions = {
  lookback: 2,
};

/**
 * Detect confirmed swing highs and lows.
 *
 * Pure: returns a new array sorted by time (which matches insertion order).
 *
 * @param candles sorted-by-time candle array
 * @param options lookback window (default 2 -> 5-candle pattern)
 */
export function detectSwings(
  candles: Candle[],
  options: Partial<SwingOptions> = {},
): SwingPoint[] {
  const lookback = Math.max(1, Math.floor(options.lookback ?? DEFAULT_SWING_OPTIONS.lookback));
  const n = candles.length;
  if (n < 2 * lookback + 1) return [];

  const out: SwingPoint[] = [];

  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i];
    if (!c) continue;
    if (!isFiniteNum(c.high) || !isFiniteNum(c.low) || !isFiniteNum(c.time)) continue;

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      const left = candles[i - j];
      const right = candles[i + j];
      if (!left || !right) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (!(left.high < c.high && right.high < c.high)) isHigh = false;
      if (!(left.low > c.low && right.low > c.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      out.push({ time: c.time, price: c.high, index: i, kind: 'high' });
    } else if (isLow) {
      out.push({ time: c.time, price: c.low, index: i, kind: 'low' });
    }
  }

  return out;
}

/** Convenience: only swing highs. */
export function detectSwingHighs(candles: Candle[], options: Partial<SwingOptions> = {}): SwingPoint[] {
  return detectSwings(candles, options).filter((s) => s.kind === 'high');
}

/** Convenience: only swing lows. */
export function detectSwingLows(candles: Candle[], options: Partial<SwingOptions> = {}): SwingPoint[] {
  return detectSwings(candles, options).filter((s) => s.kind === 'low');
}
