// Pure indicator helpers used by the strategy engine.
//
// These return arrays of numbers aligned to the input candles; NaN is
// used as the "insufficient warmup" sentinel. All functions are fully
// deterministic and free of randomness.

import type { Candle } from '@/types';
import { trueRange } from '@/core/utils/candles';
import { isFiniteNum, mean, sum } from '@/core/utils/series';

/** Simple moving average over a numeric series. */
export function sma(values: ReadonlyArray<number>, period: number): number[] {
  const out: number[] = [];
  const p = Math.max(1, Math.floor(period));
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? NaN;
    acc += isFiniteNum(v) ? v : 0;
    if (i >= p) {
      const drop = values[i - p] ?? NaN;
      acc -= isFiniteNum(drop) ? drop : 0;
    }
    if (i + 1 >= p) {
      out.push(acc / p);
    } else {
      out.push(NaN);
    }
  }
  return out;
}

/** Exponential moving average over a numeric series. */
export function ema(values: ReadonlyArray<number>, period: number): number[] {
  const out: number[] = [];
  const p = Math.max(1, Math.floor(period));
  if (values.length === 0) return out;
  const k = 2 / (p + 1);
  // Seed with SMA of the first p samples to reduce warmup bias.
  let seed = 0;
  let count = 0;
  for (let i = 0; i < p && i < values.length; i++) {
    const v = values[i];
    if (isFiniteNum(v)) {
      seed += v;
      count++;
    }
  }
  let prev = count > 0 ? seed / count : NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNum(v)) {
      out.push(NaN);
      continue;
    }
    if (!isFiniteNum(prev)) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    if (i + 1 < p) {
      out.push(NaN);
    } else {
      out.push(prev);
    }
  }
  return out;
}

/** Average True Range over `period` bars. */
export function atrSeries(candles: ReadonlyArray<Candle>, period: number): number[] {
  const out: number[] = [];
  const p = Math.max(1, Math.floor(period));
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) {
      out.push(NaN);
      continue;
    }
    const prev = i > 0 ? candles[i - 1] : undefined;
    const tr = trueRange(c, prev);
    if (!isFiniteNum(tr)) {
      out.push(NaN);
      continue;
    }
    acc += tr;
    if (i >= p) {
      const dropCandle = candles[i - p];
      const dropPrev = i - p > 0 ? candles[i - p - 1] : undefined;
      const dropTr = dropCandle ? trueRange(dropCandle, dropPrev) : 0;
      acc -= isFiniteNum(dropTr) ? dropTr : 0;
    }
    if (i + 1 >= p) {
      out.push(acc / p);
    } else {
      out.push(NaN);
    }
  }
  return out;
}

/** Wilder-style RMA (used for ADX smoothing and ATR). */
export function rma(values: ReadonlyArray<number>, period: number): number[] {
  const out: number[] = [];
  const p = Math.max(1, Math.floor(period));
  let acc = NaN;
  let seeded = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? NaN;
    if (!seeded) {
      if (i + 1 < p || !isFiniteNum(v)) {
        out.push(NaN);
        continue;
      }
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const vj = values[j] ?? NaN;
        if (isFiniteNum(vj)) s += vj;
      }
      acc = s / p;
      seeded = true;
    } else {
      if (isFiniteNum(v) && isFiniteNum(acc)) {
        acc = (acc * (p - 1) + v) / p;
      }
    }
    out.push(isFiniteNum(acc) ? acc : NaN);
  }
  return out;
}

/** Wilder RSI over `period` bars. */
export function rsiSeries(closes: ReadonlyArray<number>, period: number): number[] {
  const out: number[] = [];
  const p = Math.max(1, Math.floor(period));
  if (closes.length === 0) return out;
  let avgGain = 0;
  let avgLoss = 0;
  let seeded = false;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      out.push(NaN);
      continue;
    }
    const a = closes[i - 1] ?? NaN;
    const b = closes[i] ?? NaN;
    if (!isFiniteNum(a) || !isFiniteNum(b)) {
      out.push(NaN);
      continue;
    }
    const change = b - a;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (!seeded) {
      avgGain += gain;
      avgLoss += loss;
      if (i + 1 >= p + 1) {
        avgGain /= p;
        avgLoss /= p;
        seeded = true;
      } else {
        out.push(NaN);
        continue;
      }
    } else {
      avgGain = (avgGain * (p - 1) + gain) / p;
      avgLoss = (avgLoss * (p - 1) + loss) / p;
    }
    if (avgLoss === 0) {
      out.push(100);
    } else {
      const rs = avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

/** MACD (macd, signal, histogram). */
export interface MacdOutput {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macdSeries(
  closes: ReadonlyArray<number>,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdOutput {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macd = closes.map((_, i) => {
    const a = emaFast[i];
    const b = emaSlow[i];
    if (!isFiniteNum(a) || !isFiniteNum(b)) return NaN;
    return a - b;
  });
  const signal = ema(macd, signalPeriod);
  const histogram = macd.map((m, i) => {
    const s = signal[i];
    if (!isFiniteNum(m) || !isFiniteNum(s)) return NaN;
    return m - s;
  });
  return { macd, signal, histogram };
}

/** Bollinger bands (middle, upper, lower). */
export interface BollingerOutput {
  middle: number[];
  upper: number[];
  lower: number[];
  bandwidth: number[];
}

export function bollinger(
  closes: ReadonlyArray<number>,
  period = 20,
  mult = 2,
): BollingerOutput {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  const p = Math.max(1, Math.floor(period));
  for (let i = 0; i < closes.length; i++) {
    if (i + 1 < p) {
      upper.push(NaN);
      lower.push(NaN);
      bandwidth.push(NaN);
      continue;
    }
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = closes[j] ?? NaN;
      if (isFiniteNum(v)) {
        s += v;
        s2 += v * v;
        n++;
      }
    }
    if (n === 0) {
      upper.push(NaN);
      lower.push(NaN);
      bandwidth.push(NaN);
      continue;
    }
    const m = s / n;
    const variance = s2 / n - m * m;
    const sd = variance > 0 ? Math.sqrt(variance) : 0;
    const u = m + mult * sd;
    const l = m - mult * sd;
    upper.push(u);
    lower.push(l);
    bandwidth.push(m === 0 ? 0 : (u - l) / m);
  }
  return { middle, upper, lower, bandwidth };
}

/**
 * Average Directional Index (Wilder). Returns the +DI, -DI, and ADX
 * series aligned to the input candles.
 */
export interface AdxOutput {
  plusDI: number[];
  minusDI: number[];
  adx: number[];
}

export function adxSeries(candles: ReadonlyArray<Candle>, period = 14): AdxOutput {
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const adx: number[] = [];
  const p = Math.max(1, Math.floor(period));
  const trArr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) {
      plusDI.push(NaN);
      minusDI.push(NaN);
      adx.push(NaN);
      trArr.push(NaN);
      plusDM.push(NaN);
      minusDM.push(NaN);
      continue;
    }
    const prev = i > 0 ? candles[i - 1] : undefined;
    if (!prev) {
      trArr.push(c.high - c.low);
      plusDM.push(0);
      minusDM.push(0);
    } else {
      const upMove = c.high - prev.high;
      const downMove = prev.low - c.low;
      const plusDMRaw = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDMRaw = downMove > upMove && downMove > 0 ? downMove : 0;
      trArr.push(trueRange(c, prev));
      plusDM.push(plusDMRaw);
      minusDM.push(minusDMRaw);
    }
    plusDI.push(NaN);
    minusDI.push(NaN);
    adx.push(NaN);
  }
  const trRma = rma(trArr, p);
  const plusRma = rma(plusDM, p);
  const minusRma = rma(minusDM, p);
  const dx: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const tr = trRma[i];
    const pu = plusRma[i];
    const mu = minusRma[i];
    if (!isFiniteNum(tr) || tr === 0 || !isFiniteNum(pu) || !isFiniteNum(mu)) {
      plusDI[i] = NaN;
      minusDI[i] = NaN;
      adx[i] = NaN;
      dx.push(NaN);
      continue;
    }
    const pdi = (pu / tr) * 100;
    const mdi = (mu / tr) * 100;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sumDI = pdi + mdi;
    if (sumDI === 0) {
      dx.push(0);
    } else {
      dx.push((Math.abs(pdi - mdi) / sumDI) * 100);
    }
  }
  const adxRma = rma(dx, p);
  for (let i = 0; i < candles.length; i++) adx[i] = adxRma[i];
  return { plusDI, minusDI, adx };
}

/** Mean of finite values in the slice, ignoring NaN. */
export function nanMean(arr: ReadonlyArray<number>, from = 0, to = arr.length): number {
  if (to <= from) return NaN;
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = arr[i];
    if (isFiniteNum(v)) {
      s += v;
      n++;
    }
  }
  if (n === 0) return NaN;
  return s / n;
}

/** Last finite value in the series, or NaN. */
export function lastFinite(arr: ReadonlyArray<number>): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (isFiniteNum(v)) return v;
  }
  return NaN;
}

/** Sum of finite values, ignoring NaN. */
export function nanSum(arr: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isFiniteNum(v)) s += v;
  }
  return s;
}

/** Helper: returns mean() of a series for backward compat. */
export function avgOf(arr: ReadonlyArray<number>): number {
  return mean(sanitizeInPlace(arr));
}

/** In-place NaN filter. */
function sanitizeInPlace(arr: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isFiniteNum(v)) out.push(v);
  }
  return out;
}

/** Re-export sum for tests. */
export { sum };
