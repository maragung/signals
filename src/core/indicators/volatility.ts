// Volatility indicators: ATR, Bollinger Bands, Bollinger Bandwidth,
// Keltner Channels.
//
// All functions are pure and return arrays of the same length as the
// candle input, with NaN for indices inside the warmup window.

import type { Candle } from '@/types';
import { trueRange } from '@/core/utils/candles';
import { mean, safeDiv, stddev } from '@/core/utils/series';
import { ema } from './trend';
import type { CandleInput, IndicatorOutput } from './types';

/** Fill output array with NaN of the same length as candles. */
function nanArray(len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = NaN;
  return out;
}

// ---------------------------------------------------------------------------
// Average True Range (Wilder's smoothing)
// ---------------------------------------------------------------------------

/**
 * ATR with Wilder's smoothing over `period`. The first valid value is at
 * index `period - 1` (simple mean of the first `period` TRs).
 */
export function atr(candles: CandleInput, period = 14): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n === 0) return out;
  if (n < period) return out;

  // First valid window: mean of true range over the first `period` candles.
  let s = 0;
  for (let i = 0; i < period; i++) {
    s += trueRange(candles[i]!, i > 0 ? candles[i - 1] : undefined);
  }
  out[period - 1] = s / period;
  let prev = s / period;
  for (let i = period; i < n; i++) {
    const tr = trueRange(candles[i]!, candles[i - 1]);
    const v = (prev * (period - 1) + tr) / period;
    out[i] = v;
    prev = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

export interface BollingerBandsOutput {
  middle: IndicatorOutput;
  upper: IndicatorOutput;
  lower: IndicatorOutput;
}

/**
 * Bollinger Bands. Middle = SMA(close, period). Upper/Lower = middle ±
 * multiplier * stdev(close, period, ddof=0). The first valid value is at
 * index `period - 1`.
 */
export function bollingerBands(
  candles: CandleInput,
  period = 20,
  multiplier = 2,
): BollingerBandsOutput {
  const n = candles.length;
  const middle = nanArray(n);
  const upper = nanArray(n);
  const lower = nanArray(n);
  if (period <= 0 || n < period) {
    return { middle, upper, lower };
  }

  for (let i = period - 1; i < n; i++) {
    const window = new Array<number>(period);
    for (let j = 0; j < period; j++) {
      window[j] = candles[i - period + 1 + j]!.close;
    }
    const m = mean(window);
    const s = stddev(window, 0);
    if (!Number.isFinite(m) || !Number.isFinite(s)) continue;
    middle[i] = m;
    upper[i] = m + multiplier * s;
    lower[i] = m - multiplier * s;
  }
  return { middle, upper, lower };
}

// ---------------------------------------------------------------------------
// Bollinger Bandwidth
// ---------------------------------------------------------------------------

/**
 * Bollinger Bandwidth = (upper - lower) / middle. Returns NaN whenever
 * the underlying band values are not yet defined or the middle band is
 * effectively zero.
 */
export function bollingerWidth(
  candles: CandleInput,
  period = 20,
  multiplier = 2,
): IndicatorOutput {
  const { middle, upper, lower } = bollingerBands(candles, period, multiplier);
  const n = candles.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = safeDiv(upper[i]! - lower[i]!, middle[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keltner Channels
// ---------------------------------------------------------------------------

export interface KeltnerOutput {
  middle: IndicatorOutput;
  upper: IndicatorOutput;
  lower: IndicatorOutput;
}

/**
 * Keltner Channels: middle = EMA(close, period). Upper/Lower =
 * middle ± multiplier * ATR(atrPeriod). Defaults to a 20-period EMA and
 * 10-period ATR with multiplier 2.
 */
export function keltnerChannels(
  candles: CandleInput,
  period = 20,
  multiplier = 2,
  atrPeriod = 10,
): KeltnerOutput {
  const n = candles.length;
  const middle = nanArray(n);
  const upper = nanArray(n);
  const lower = nanArray(n);
  if (period <= 0 || atrPeriod <= 0) return { middle, upper, lower };

  const e = ema(candles, period);
  const a = atr(candles, atrPeriod);
  for (let i = 0; i < n; i++) {
    const m = e[i]!;
    if (!Number.isFinite(m)) continue;
    const av = a[i]!;
    if (!Number.isFinite(av)) {
      // Middle is available but ATR is not. Emit only the middle band.
      middle[i] = m;
      continue;
    }
    middle[i] = m;
    upper[i] = m + multiplier * av;
    lower[i] = m - multiplier * av;
  }
  return { middle, upper, lower };
}

// Re-export the Candle type for convenience; intentionally avoids
// duplicating definitions.
export type { Candle };

// Re-export shared helpers for tests.
export const _volatilityInternal = { nanArray };
