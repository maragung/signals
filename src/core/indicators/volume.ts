// Volume-based indicators: volume, volume SMA, OBV, CMF, VWAP (re-exported).
//
// All functions are pure. NaN is emitted wherever a value is not yet
// available (warmup) or whenever the input contains a non-finite number.

import type { Candle } from '@/types';
import { sanitizeCandles } from '@/core/utils/candles';
import { EPS, isFiniteNum, mean, safeDiv, sum } from '@/core/utils/series';
import { sma, vwap } from './trend';
import type { CandleInput, IndicatorOutput } from './types';

export { vwap };

/** Fill output array with NaN of the same length as candles. */
function nanArray(len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = NaN;
  return out;
}

/** Extract a numeric series from candles; non-finite entries become NaN. */
function extractSeries(
  candles: CandleInput,
  pick: (c: Candle) => number,
): number[] {
  const n = candles.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = pick(candles[i]!);
    out[i] = isFiniteNum(v) ? v : NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volume (passthrough)
// ---------------------------------------------------------------------------

/** Volume as-is from each candle. Non-finite entries become NaN. */
export function volume(candles: CandleInput): IndicatorOutput {
  return extractSeries(candles, (c) => c.volume);
}

// ---------------------------------------------------------------------------
// Volume SMA
// ---------------------------------------------------------------------------

/**
 * Simple moving average of volume. Same shape as `sma` but applied to the
 * volume field. First valid value at index `period - 1`.
 */
export function volumeSma(candles: CandleInput, period: number): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;
  const vols = extractSeries(candles, (c) => c.volume);
  let s = 0;
  for (let i = 0; i < period; i++) s += vols[i]!;
  out[period - 1] = s / period;
  for (let i = period; i < n; i++) {
    s += vols[i]! - vols[i - period]!;
    out[i] = s / period;
  }
  return out;
}

// ---------------------------------------------------------------------------
// On-Balance Volume
// ---------------------------------------------------------------------------

/**
 * OBV: cumulative sum of signed volume. The sign is +1 when the close
 * rises, -1 when it falls, 0 when it stays the same. NaN propagates
 * from non-finite closes.
 */
export function obv(candles: CandleInput): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (n === 0) return out;

  if (!isFiniteNum(candles[0]!.close) || !isFiniteNum(candles[0]!.volume)) {
    out[0] = NaN;
  } else {
    out[0] = 0;
  }
  let running = 0;
  for (let i = 1; i < n; i++) {
    const a = candles[i - 1]!.close;
    const b = candles[i]!.close;
    const v = candles[i]!.volume;
    if (!isFiniteNum(a) || !isFiniteNum(b) || !isFiniteNum(v)) {
      out[i] = NaN;
      continue;
    }
    if (b > a) running += v;
    else if (b < a) running -= v;
    out[i] = running;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chaikin Money Flow
// ---------------------------------------------------------------------------

/**
 * Chaikin Money Flow:
 *   MFV_i = volume_i * ((close - low) - (high - close)) / (high - low)
 *   CMF_i = sum(MFV, period) / sum(volume, period)
 * If a candle has high == low the MFV is defined as 0 (no price range).
 * First valid value at index `period - 1`.
 */
export function cmf(candles: CandleInput, period = 20): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;

  for (let i = period - 1; i < n; i++) {
    let mfvSum = 0;
    let volSum = 0;
    let valid = true;
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j]!;
      if (!isFiniteNum(c.close) || !isFiniteNum(c.low) || !isFiniteNum(c.high) || !isFiniteNum(c.volume)) {
        valid = false;
        break;
      }
      const range = c.high - c.low;
      const mfv = range < EPS ? 0 : (c.volume * ((c.close - c.low) - (c.high - c.close))) / range;
      mfvSum += mfv;
      volSum += c.volume;
    }
    if (!valid) {
      out[i] = NaN;
      continue;
    }
    out[i] = safeDiv(mfvSum, volSum);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convenience: re-export the shared helpers used in tests.
// ---------------------------------------------------------------------------

export { sma, sanitizeCandles, mean, sum, EPS };
