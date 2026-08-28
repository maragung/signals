// Shared utilities for providers: safe fetch, environment checks, jitter, sanitization.

import { isFiniteNum } from '@/core/utils/series';
import type { Candle, ConnectionStatus, TickerData } from '@/types';

/** Returns true if the code is running in a browser. */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/** Returns true if WebSocket is available. */
export function hasWebSocket(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined';
}

/**
 * Like {@link safeJsonFetch} but also returns the HTTP status code so callers
 * can detect geo-block responses (451/403/407) and still return `[]`. The
 * Promise never rejects; network failures surface as `{ data: null, status: 0 }`.
 */
export interface JsonWithStatus {
  /** Parsed JSON body, or null if the request failed / body was not JSON. */
  data: unknown;
  /** HTTP status code, or 0 if the request never completed (network error/abort). */
  status: number;
  /** Whether the response had a 2xx status. */
  ok: boolean;
}

export async function safeJsonFetchWithStatus(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
  fetchImpl?: typeof fetch,
): Promise<JsonWithStatus> {
  const f: typeof fetch =
    fetchImpl ??
    (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { data, status: res.status, ok: res.ok };
  } catch {
    return { data: null, status: 0, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Safe fetch wrapper: never throws, returns either parsed JSON or null.
 * Always sanitizes the response when applicable.
 */
export async function safeJsonFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const f: typeof fetch =
    fetchImpl ??
    (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Sanitize a single number, returning fallback if not finite. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'string') {
    const v = Number(value);
    return isFiniteNum(v) ? v : fallback;
  }
  return isFiniteNum(value) ? (value as number) : fallback;
}

/** Sanitize a number, returning NaN if not finite. */
export function numOrNaN(value: unknown): number {
  if (typeof value === 'string') {
    const v = Number(value);
    return isFiniteNum(v) ? v : NaN;
  }
  return isFiniteNum(value) ? (value as number) : NaN;
}

/** Sanitize a unix timestamp in seconds (ms timestamps are converted). */
export function tsSeconds(value: unknown): number {
  const n = numOrNaN(value);
  if (!isFiniteNum(n)) return 0;
  // Heuristic: if it's > 10^12 assume ms and convert to seconds.
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Sanitize a TickerData record, ensuring all numeric fields are finite. */
export function sanitizeTicker(t: Partial<TickerData>, fallbackSymbol: string): TickerData {
  const symbol = typeof t.symbol === 'string' && t.symbol.length > 0 ? t.symbol : fallbackSymbol;
  return {
    symbol,
    price: num(t.price, 0),
    change24h: num(t.change24h, 0),
    changePercent24h: num(t.changePercent24h, 0),
    high24h: num(t.high24h, 0),
    low24h: num(t.low24h, 0),
    volume24h: num(t.volume24h, 0),
    timestamp: num(t.timestamp, Math.floor(Date.now() / 1000)),
  };
}

/** Sanitize a single candle. Returns null if essential fields are missing. */
export function sanitizeCandle(c: Partial<Candle> | undefined): Candle | null {
  if (!c) return null;
  const time = num(c.time, NaN);
  const open = num(c.open, NaN);
  const high = num(c.high, NaN);
  const low = num(c.low, NaN);
  const close = num(c.close, NaN);
  if (!isFiniteNum(time) || !isFiniteNum(open) || !isFiniteNum(high) || !isFiniteNum(low) || !isFiniteNum(close)) {
    return null;
  }
  if (high < low) return null;
  return {
    time: Math.floor(time),
    open,
    high,
    low,
    close,
    volume: num(c.volume, 0),
  };
}

/** Returns a pseudo-random number in [0, 1). */
export function randomFloat(): number {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return (arr[0] ?? 0) / 0x100000000;
  }
  return Math.random();
}

/** Compute exponential backoff delay with jitter, capped at maxMs. */
export function backoffDelay(
  attempt: number,
  baseMs = 1000,
  maxMs = 30000,
  jitterRatio = 0.2,
): number {
  // attempt is 0-indexed; the sequence is base, 2*base, 4*base, 8*base, ...
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const jitter = exp * jitterRatio * (randomFloat() * 2 - 1); // ±jitterRatio
  return Math.max(0, Math.floor(exp + jitter));
}

/** Status transition helper that only fires on changes. */
export function makeStatusEmitter(onStatus: (s: ConnectionStatus) => void): (s: ConnectionStatus) => void {
  let current: ConnectionStatus = 'idle';
  return (next) => {
    if (next === current) return;
    current = next;
    try {
      onStatus(next);
    } catch {
      /* swallow listener errors */
    }
  };
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aggregate raw tick prices into OHLCV candles bucketed by timeframe. */
export function aggregateTicksToCandles(
  ticks: ArrayLike<[number, number]>,
  bucketMs: number,
): Candle[] {
  if (ticks.length === 0) return [];
  const buckets = new Map<number, Candle>();
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (!t) continue;
    const [ts, price] = t;
    if (!isFiniteNum(ts) || !isFiniteNum(price)) continue;
    const tMs = ts > 1e12 ? ts : ts * 1000;
    const start = Math.floor(tMs / bucketMs) * bucketMs;
    const existing = buckets.get(start);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += 0; // tick-only; no volume
    } else {
      buckets.set(start, {
        time: Math.floor(start / 1000),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}
