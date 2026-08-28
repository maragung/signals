import type { Candle, Timeframe } from '@/types';
import { tfToMs } from '@/types';
import { isFiniteNum } from './series';

// Convert a number array of [t,o,h,l,c,v] tuples into Candle[]
// Accepts either numbers or numeric strings (Binance kline format returns
// strings for OHLCV values).
export function fromTuples(tuples: ArrayLike<unknown>): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i] as unknown[] | undefined;
    if (!t) continue;
    const time = Number(t[0]);
    const open = Number(t[1]);
    const high = Number(t[2]);
    const low = Number(t[3]);
    const close = Number(t[4]);
    const volume = Number(t[5]);
    if (
      isFiniteNum(time) &&
      isFiniteNum(open) &&
      isFiniteNum(high) &&
      isFiniteNum(low) &&
      isFiniteNum(close)
    ) {
      out.push({
        time: Math.floor(time),
        open,
        high,
        low,
        close,
        volume: isFiniteNum(volume) ? volume : 0,
      });
    }
  }
  return out;
}

// Sort candles by time ascending
export function sortCandles(arr: Candle[]): Candle[] {
  return arr.slice().sort((a, b) => a.time - b.time);
}

// Deduplicate by time (keep last)
export function dedupeByTime(arr: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of arr) map.set(c.time, c);
  return sortCandles(Array.from(map.values()));
}

// Merge two candle arrays and dedupe
export function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  return dedupeByTime([...a, ...b]);
}

// Update or insert the latest candle in-place (returns new array)
export function upsertCandle(arr: Candle[], candle: Candle): Candle[] {
  if (arr.length === 0) return [candle];
  const last = arr[arr.length - 1];
  if (last.time === candle.time) {
    const merged: Candle = {
      time: candle.time,
      open: last.open,
      high: Math.max(last.high, candle.high),
      low: Math.min(last.low, candle.low),
      close: candle.close,
      volume: last.volume + candle.volume,
    };
    return [...arr.slice(0, -1), merged];
  }
  if (candle.time > last.time) return [...arr, candle];
  // out of order - insert in correct place
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]!.time === candle.time) {
      const merged: Candle = {
        time: candle.time,
        open: arr[i]!.open,
        high: Math.max(arr[i]!.high, candle.high),
        low: Math.min(arr[i]!.low, candle.low),
        close: candle.close,
        volume: arr[i]!.volume + candle.volume,
      };
      return [...arr.slice(0, i), merged, ...arr.slice(i + 1)];
    }
    if (arr[i]!.time < candle.time) {
      return [...arr.slice(0, i + 1), candle, ...arr.slice(i + 1)];
    }
  }
  return [candle, ...arr];
}

// Filter out candles with NaN/Infinity
export function sanitizeCandles(arr: Candle[]): Candle[] {
  return arr.filter(
    (c) =>
      isFiniteNum(c.time) &&
      isFiniteNum(c.open) &&
      isFiniteNum(c.high) &&
      isFiniteNum(c.low) &&
      isFiniteNum(c.close) &&
      isFiniteNum(c.volume) &&
      c.high >= c.low &&
      c.high >= c.open &&
      c.high >= c.close &&
      c.low <= c.open &&
      c.low <= c.close,
  );
}

// Aggregate smaller candles into a higher timeframe (deterministic, no provider dependency)
export function aggregateCandles(candles: Candle[], target: Timeframe): Candle[] {
  if (candles.length === 0) return [];
  const stepMs = tfToMs(target);
  const out: Candle[] = [];
  let bucketStart = Math.floor(candles[0]!.time * 1000 / stepMs) * stepMs;
  let bucketEnd = bucketStart + stepMs;
  let bucket: Candle | null = null;

  for (const c of candles) {
    const tMs = c.time * 1000;
    if (tMs >= bucketEnd) {
      if (bucket) out.push(bucket);
      bucketStart = Math.floor(tMs / stepMs) * stepMs;
      bucketEnd = bucketStart + stepMs;
      bucket = null;
    }
    if (!bucket) {
      bucket = { time: bucketStart / 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// Get the previous candle that is fully closed
export function lastClosedCandle(candles: Candle[], timeframe: Timeframe, nowMs: number): Candle | undefined {
  if (candles.length === 0) return undefined;
  const stepMs = tfToMs(timeframe);
  const last = candles[candles.length - 1]!;
  // If the last candle is the current (open) one, the previous is the closed one
  const lastIsOpen = nowMs - last.time * 1000 < stepMs;
  if (lastIsOpen && candles.length >= 2) return candles[candles.length - 2];
  return last;
}

// Compute simple log returns between consecutive closes
export function logReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1]!.close;
    const b = candles[i]!.close;
    if (a <= 0 || b <= 0) {
      out.push(0);
    } else {
      out.push(Math.log(b / a));
    }
  }
  return out;
}

// True range for ATR calculations
export function trueRange(c: Candle, prev?: Candle): number {
  if (!prev) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}
