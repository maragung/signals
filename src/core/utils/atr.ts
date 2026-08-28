import type { Candle } from '@/types';
import { trueRange } from './candles';
import { isFiniteNum } from './series';

// Wilder's ATR
export function buildATRSeries(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  // initial average
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(candles[i]!, candles[i - 1]);
  }
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i]!, candles[i - 1]);
    out[i] = (out[i - 1]! * (period - 1) + tr) / period;
  }
  return out.map((v) => (isFiniteNum(v) ? v : NaN));
}
