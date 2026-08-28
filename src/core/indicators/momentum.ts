// Momentum indicators: RSI, StochasticRSI, Stochastic, CCI, ROC,
// Williams %R, MFI.
//
// All functions are pure and return arrays of the same length as the
// candle input. NaN is used for indices in the warmup period or whenever
// a guard rejects an underlying value.

import type { Candle } from '@/types';
import { EPS, isFiniteNum, mean, safeDiv } from '@/core/utils/series';
import type { CandleInput, IndicatorOutput } from './types';

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
    const v = pick(candles[i]!);
    out[i] = isFiniteNum(v) ? v : NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relative Strength Index
// ---------------------------------------------------------------------------

/**
 * Wilder's RSI. First valid value appears at index `period` (not
 * `period - 1`) because we need `period` deltas before computing the
 * averages.
 */
export function rsi(candles: CandleInput, period = 14): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n <= period) return out;

  const closes = priceSeries(candles, (c) => c.close);

  // Average gain / loss seed using the first `period` changes.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (!isFiniteNum(avgGain) || !isFiniteNum(avgLoss)) return NaN;
  if (avgGain < EPS && avgLoss < EPS) return 50;
  if (avgLoss < EPS) return 100;
  if (avgGain < EPS) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// Stochastic RSI
// ---------------------------------------------------------------------------

export interface StochRSIOutput {
  k: IndicatorOutput;
  d: IndicatorOutput;
}

/**
 * Stochastic RSI: apply the Stochastic formula to the RSI series.
 *   StochRSI = (RSI - min(RSI, period)) / (max(RSI, period) - min(RSI, period))
 * Then K = SMA(StochRSI, kSmooth), D = SMA(K, dSmooth).
 */
export function stochRsi(
  candles: CandleInput,
  rsiPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochRSIOutput {
  const n = candles.length;
  const kArr = nanArray(n);
  const dArr = nanArray(n);

  const rsiArr = rsi(candles, rsiPeriod);
  if (n < rsiPeriod + 1) return { k: kArr, d: dArr };

  // The Stochastic needs `rsiPeriod` RSI samples to start producing values.
  // RSI[rsiPeriod] is the first valid value. The stochastic value at
  // index i uses RSI[i-rsiPeriod+1 .. i].
  for (let i = rsiPeriod; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i - rsiPeriod + 1; j <= i; j++) {
      const v = rsiArr[j]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const range = hi - lo;
    kArr[i] = range < EPS ? 0 : ((rsiArr[i]! - lo) / range) * 100;
  }

  // K smoothing: SMA of last kSmooth raw StochRSI values.
  for (let i = rsiPeriod + kSmooth - 1; i < n; i++) {
    let s = 0;
    for (let j = i - kSmooth + 1; j <= i; j++) s += kArr[j]!;
    kArr[i] = s / kSmooth;
  }

  // D smoothing: SMA of last dSmooth K values.
  for (let i = rsiPeriod + kSmooth - 1 + dSmooth - 1; i < n; i++) {
    let s = 0;
    for (let j = i - dSmooth + 1; j <= i; j++) s += kArr[j]!;
    dArr[i] = s / dSmooth;
  }
  return { k: kArr, d: dArr };
}

// ---------------------------------------------------------------------------
// Stochastic Oscillator
// ---------------------------------------------------------------------------

export interface StochasticOutput {
  k: IndicatorOutput;
  d: IndicatorOutput;
}

/**
 * Classic stochastic oscillator. %K uses the highest high and lowest low
 * over `kPeriod`, then is optionally smoothed. %D is the SMA of %K over
 * `dPeriod`. The first valid %K appears at index `kPeriod - 1`.
 */
export function stochastic(
  candles: CandleInput,
  kPeriod = 14,
  dPeriod = 3,
  smoothK = 1,
): StochasticOutput {
  const n = candles.length;
  const rawK = nanArray(n);
  const kArr = nanArray(n);
  const dArr = nanArray(n);
  if (kPeriod <= 0 || n < kPeriod) return { k: kArr, d: dArr };

  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let close = NaN;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const c = candles[j]!;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      close = c.close;
    }
    const range = hi - lo;
    rawK[i] = !isFiniteNum(close) || range < EPS ? 0 : ((close - lo) / range) * 100;
  }

  // Smooth %K.
  for (let i = kPeriod - 1 + smoothK - 1; i < n; i++) {
    let s = 0;
    for (let j = i - smoothK + 1; j <= i; j++) s += rawK[j]!;
    kArr[i] = s / smoothK;
  }

  // %D = SMA of smoothed %K.
  const kStart = kPeriod - 1 + smoothK - 1;
  for (let i = kStart + dPeriod - 1; i < n; i++) {
    let s = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) s += kArr[j]!;
    dArr[i] = s / dPeriod;
  }
  return { k: kArr, d: dArr };
}

// ---------------------------------------------------------------------------
// Commodity Channel Index
// ---------------------------------------------------------------------------

/**
 * CCI over `period` candles. Uses typical price (H+L+C)/3 and the mean
 * absolute deviation. First valid value at index `period - 1`.
 */
export function cci(candles: CandleInput, period = 20): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;

  const typical = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    typical[i] = (c.high + c.low + c.close) / 3;
  }
  // Lambert's constant for CCI = 0.015.
  for (let i = period - 1; i < n; i++) {
    const window = typical.slice(i - period + 1, i + 1);
    const m = mean(window);
    let dev = 0;
    for (let j = 0; j < window.length; j++) dev += Math.abs(window[j]! - m);
    dev /= period;
    // When the mean absolute deviation is effectively 0, all typical prices
    // in the window are equal. By convention CCI is defined as 0 here.
    out[i] = dev < EPS ? 0 : ((typical[i]! - m) * 0.015) / dev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate of Change
// ---------------------------------------------------------------------------

/**
 * Rate of Change, expressed as a percentage:
 *   ROC_i = (close[i] - close[i-period]) / close[i-period] * 100
 * First valid value at index `period`.
 */
export function roc(candles: CandleInput, period = 10): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n <= period) return out;

  const closes = priceSeries(candles, (c) => c.close);
  for (let i = period; i < n; i++) {
    const prev = closes[i - period]!;
    out[i] = safeDiv((closes[i]! - prev) * 100, prev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Williams %R
// ---------------------------------------------------------------------------

/**
 * Williams %R = ((highestHigh - close) / (highestHigh - lowestLow)) * -100
 * First valid value at index `period - 1`.
 */
export function williamsR(candles: CandleInput, period = 14): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let close = NaN;
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j]!;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      close = c.close;
    }
    const range = hi - lo;
    if (!isFiniteNum(close) || range < EPS) {
      out[i] = NaN;
    } else {
      out[i] = ((hi - close) / range) * -100;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Money Flow Index
// ---------------------------------------------------------------------------

/**
 * Money Flow Index. Positive / negative money flow is determined by the
 * sign of `close - prevClose`. MFV per candle is `sign * typical * volume`.
 * MFI is the ratio of positive to total money flow over `period`,
 * rescaled to 0..100.
 */
export function mfi(candles: CandleInput, period = 14): IndicatorOutput {
  const n = candles.length;
  const out = nanArray(n);
  if (period <= 0 || n <= period) return out;

  const typical = new Array<number>(n);
  const sign = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    typical[i] = (c.high + c.low + c.close) / 3;
  }
  for (let i = 1; i < n; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff > 0) sign[i] = 1;
    else if (diff < 0) sign[i] = -1;
  }

  for (let i = period; i < n; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const t = typical[j]!;
      const v = candles[j]!.volume;
      if (!isFiniteNum(t) || !isFiniteNum(v)) continue;
      const mfv = sign[j]! * t * v;
      if (mfv > 0) pos += mfv;
      else if (mfv < 0) neg += -mfv;
    }
    const total = pos + neg;
    if (total < EPS) {
      out[i] = 50;
    } else if (neg < EPS) {
      out[i] = 100;
    } else if (pos < EPS) {
      out[i] = 0;
    } else {
      out[i] = 100 - 100 / (1 + pos / neg);
    }
  }
  return out;
}
