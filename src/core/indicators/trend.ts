// Trend-following indicators: SMA, EMA, WMA, VWAP, MACD, ADX, Supertrend.
//
// All functions are pure. Output arrays are the same length as the input
// candle array, with NaN filled in for indices where the indicator's
// warmup period has not yet elapsed or where the underlying value is not
// finite.

import type { Candle } from '@/types';
import { trueRange } from '@/core/utils/candles';
import { EPS, isFiniteNum, safeDiv, safeNum } from '@/core/utils/series';
import type { CandleInput, IndicatorOutput } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fill output array with NaN of the same length as candles. */
function nanArray(len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = NaN;
  return out;
}

/** Extract a price series from candles; non-finite entries become NaN. */
function priceSeries(
  candles: CandleInput,
  pick: (c: Candle) => number,
): number[] {
  const n = candles.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const v = pick(c);
    out[i] = isFiniteNum(v) ? v : NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simple Moving Average
// ---------------------------------------------------------------------------

/**
 * Simple Moving Average over `period` using the close price.
 * Output[i] is the mean of closes [i-period+1 .. i] when fully formed.
 */
export function sma(candles: CandleInput, period: number): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n === 0) return out;

  const closes = priceSeries(candles, (c) => c.close);
  if (n < period) return out;

  // First window: SMA seeds the first valid output.
  let s = 0;
  for (let i = 0; i < period; i++) s += closes[i]!;
  out[period - 1] = safeNum(s / period);

  // Rolling sum for subsequent windows.
  for (let i = period; i < n; i++) {
    s += closes[i]! - closes[i - period]!;
    out[i] = s / period;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exponential Moving Average
// ---------------------------------------------------------------------------

/**
 * Exponential Moving Average with SMA seed over `period` close prices.
 * Uses the standard smoothing constant k = 2 / (period + 1).
 */
export function ema(candles: CandleInput, period: number): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;

  const closes = priceSeries(candles, (c) => c.close);
  // SMA seed over the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i]!;
  const prev = seed / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  let e = prev;
  for (let i = period; i < n; i++) {
    e = closes[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weighted Moving Average
// ---------------------------------------------------------------------------

/**
 * Linearly weighted moving average:
 *   WMA_i = sum(j * close[i - period + j]) / sum(j), j = 1..period
 */
export function wma(candles: CandleInput, period: number): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;

  const closes = priceSeries(candles, (c) => c.close);
  const denom = (period * (period + 1)) / 2;

  // Recompute the weighted sum each step. O(period) per step, but trivially
  // correct and the function is still pure. For very long candle histories
  // a deque-based sliding window can be substituted without changing the
  // observable output.
  for (let i = period - 1; i < n; i++) {
    let w = 0;
    for (let j = 0; j < period; j++) {
      w += (j + 1) * closes[i - period + 1 + j]!;
    }
    out[i] = w / denom;
  }
  return out;
}

// ---------------------------------------------------------------------------
// VWAP (rolling session-like, deterministic)
// ---------------------------------------------------------------------------

/**
 * Rolling VWAP computed on each candle as
 *   VWAP_i = sum(typical * volume, 0..i) / sum(volume, 0..i)
 *
 * This is a cumulative (session-style) VWAP; a periodic reset variant can
 * be built by feeding only the in-window candles. Values are NaN until the
 * cumulative volume is positive.
 */
export function vwap(candles: CandleInput): IndicatorOutput {
  const n = candles.length;
  const out = new Array<number>(n);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const typical = (c.high + c.low + c.close) / 3;
    if (!isFiniteNum(typical) || !isFiniteNum(c.volume) || c.volume < 0) {
      out[i] = NaN;
      continue;
    }
    cumPV += typical * c.volume;
    cumV += c.volume;
    out[i] = cumV < EPS ? NaN : cumPV / cumV;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

export interface MACDOutput {
  macd: IndicatorOutput;
  signal: IndicatorOutput;
  histogram: IndicatorOutput;
}

/**
 * MACD with EMA periods fast / slow / signal. Returns three arrays of the
 * same length as the candle input. First valid MACD value is at slow-1;
 * signal/histogram wait for an additional (signal-1) samples beyond that.
 */
export function macd(
  candles: CandleInput,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MACDOutput {
  const n = candles.length;
  const macdLine = nanArray(n);
  const signalLine = nanArray(n);
  const hist = nanArray(n);

  if (slow <= 0 || fast <= 0 || signalPeriod <= 0 || n < slow) {
    return { macd: macdLine, signal: signalLine, histogram: hist };
  }

  const fastEma = ema(candles, fast);
  const slowEma = ema(candles, slow);
  for (let i = slow - 1; i < n; i++) {
    macdLine[i] = fastEma[i]! - slowEma[i]!;
  }

  // Signal = EMA of MACD line over the *finite* values.
  if (n >= slow - 1 + signalPeriod) {
    let seed = 0;
    for (let i = slow - 1; i < slow - 1 + signalPeriod; i++) seed += macdLine[i]!;
    const prev = seed / signalPeriod;
    signalLine[slow - 1 + signalPeriod - 1] = prev;
    const k = 2 / (signalPeriod + 1);
    let e = prev;
    for (let i = slow - 1 + signalPeriod; i < n; i++) {
      e = macdLine[i]! * k + e * (1 - k);
      signalLine[i] = e;
      hist[i] = macdLine[i]! - e;
    }
  }
  return { macd: macdLine, signal: signalLine, histogram: hist };
}

// ---------------------------------------------------------------------------
// ADX (Average Directional Index) with Wilder's smoothing
// ---------------------------------------------------------------------------

export interface ADXOutput {
  adx: IndicatorOutput;
  plusDI: IndicatorOutput;
  minusDI: IndicatorOutput;
}

/**
 * Average Directional Index. Uses Wilder's smoothing (alpha = 1/period)
 * over up/down moves and true range. Returns +DI, -DI and ADX. ADX is
 * seeded by SMA of DX over the first `period` DX values (so it is defined
 * at index 2*period - 2).
 */
export function adx(candles: CandleInput, period = 14): ADXOutput {
  const n = candles.length;
  const adxArr = nanArray(n);
  const plusDI = nanArray(n);
  const minusDI = nanArray(n);

  if (period <= 0 || n < 2 * period) {
    return { adx: adxArr, plusDI, minusDI };
  }

  // Per-candle directional movements and true range.
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);

  tr[0] = candles[0]!.high - candles[0]!.low;
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = trueRange(c, p);
  }

  // Wilder's smoothing: first window = sum, then
  // smoothed[i] = smoothed[i-1] - smoothed[i-1]/period + sample
  const smTR = new Array<number>(n).fill(0);
  const smPlus = new Array<number>(n).fill(0);
  const smMinus = new Array<number>(n).fill(0);
  for (let i = 0; i < period; i++) {
    smTR[i] = tr[i]!;
    smPlus[i] = plusDM[i]!;
    smMinus[i] = minusDM[i]!;
  }
  for (let i = period; i < n; i++) {
    smTR[i] = smTR[i - 1]! - smTR[i - 1]! / period + tr[i]!;
    smPlus[i] = smPlus[i - 1]! - smPlus[i - 1]! / period + plusDM[i]!;
    smMinus[i] = smMinus[i - 1]! - smMinus[i - 1]! / period + minusDM[i]!;
  }

  // +DI / -DI defined from index `period - 1` onward.
  for (let i = period - 1; i < n; i++) {
    const pdi = safeDiv(100 * smPlus[i]!, smTR[i]!);
    const mdi = safeDiv(100 * smMinus[i]!, smTR[i]!);
    plusDI[i] = pdi;
    minusDI[i] = mdi;
  }

  // DX and ADX.
  const dx = new Array<number>(n).fill(0);
  for (let i = period - 1; i < n; i++) {
    const sumDI = (plusDI[i]! || 0) + (minusDI[i]! || 0);
    dx[i] = sumDI < EPS ? 0 : (Math.abs(plusDI[i]! - minusDI[i]!) * 100) / sumDI;
  }

  // ADX seeded with SMA of first `period` DX samples.
  let seed = 0;
  for (let i = period - 1; i < 2 * period - 1; i++) seed += dx[i]!;
  adxArr[2 * period - 2] = seed / period;
  let a = adxArr[2 * period - 2]!;
  for (let i = 2 * period - 1; i < n; i++) {
    a = (adxArr[i - 1]! * (period - 1) + dx[i]!) / period;
    adxArr[i] = a;
  }
  return { adx: adxArr, plusDI, minusDI };
}

// ---------------------------------------------------------------------------
// Supertrend
// ---------------------------------------------------------------------------

export interface SupertrendOutput {
  /** The supertrend line itself. */
  supertrend: IndicatorOutput;
  /** Direction: +1 = up trend, -1 = down trend. NaN until warmup complete. */
  direction: IndicatorOutput;
}

/**
 * Supertrend using ATR with `multiplier`. Output line flips above/below
 * the close when price breaks the opposite band. The first `period - 1`
 * samples are NaN.
 */
export function supertrend(
  candles: CandleInput,
  period = 10,
  multiplier = 3,
): SupertrendOutput {
  const n = candles.length;
  const st = nanArray(n);
  const dir = nanArray(n);

  if (period <= 0 || n < period) return { supertrend: st, direction: dir };

  // ATR (Wilder's smoothing) over `period`.
  const atrArr = atrRaw(candles, period);

  // Basic upper/lower bands.
  const basicUpper = new Array<number>(n).fill(NaN);
  const basicLower = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const c = candles[i]!;
    const mid = (c.high + c.low) / 2;
    const a = atrArr[i]!;
    basicUpper[i] = mid + multiplier * a;
    basicLower[i] = mid - multiplier * a;
  }

  // Final bands and Supertrend.
  const finalUpper = new Array<number>(n).fill(NaN);
  const finalLower = new Array<number>(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    const c = candles[i]!;
    if (i === period - 1) {
      finalUpper[i] = basicUpper[i]!;
      finalLower[i] = basicLower[i]!;
      st[i] = finalUpper[i]!; // start in down trend => line above
      dir[i] = -1;
      continue;
    }
    const prevUp = finalUpper[i - 1]!;
    const prevLo = finalLower[i - 1]!;
    finalUpper[i] =
      basicUpper[i]! < prevUp || candles[i - 1]!.close > prevUp
        ? basicUpper[i]!
        : prevUp;
    finalLower[i] =
      basicLower[i]! > prevLo || candles[i - 1]!.close < prevLo
        ? basicLower[i]!
        : prevLo;

    const prevDir = dir[i - 1]!;
    if (prevDir === -1) {
      // Currently in down trend (line above price).
      if (c.close > finalUpper[i]!) {
        dir[i] = 1;
        st[i] = finalLower[i]!;
      } else {
        dir[i] = -1;
        st[i] = finalUpper[i]!;
      }
    } else {
      // Currently in up trend.
      if (c.close < finalLower[i]!) {
        dir[i] = -1;
        st[i] = finalUpper[i]!;
      } else {
        dir[i] = 1;
        st[i] = finalLower[i]!;
      }
    }
  }
  return { supertrend: st, direction: dir };
}

/**
 * ATR (Wilder's smoothing). Exposed here as well because Supertrend needs
 * the internal raw series. Public `atr` is also re-exported from the
 * volatility module.
 */
function atrRaw(candles: CandleInput, period: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || n === 0) return out;

  // Initial sum of true range over first `period` TRs.
  let s = 0;
  if (n >= period) {
    for (let i = 0; i < period; i++) {
      s += trueRange(candles[i]!, i > 0 ? candles[i - 1] : undefined);
    }
    out[period - 1] = s / period;
    for (let i = period; i < n; i++) {
      const tr = trueRange(candles[i]!, candles[i - 1]);
      out[i] = (out[i - 1]! * (period - 1) + tr) / period;
    }
  }
  return out;
}

// Re-export helpers used by some tests for parity.
export const _trendInternal = {
  nanArray,
  priceSeries,
  atrRaw,
};
