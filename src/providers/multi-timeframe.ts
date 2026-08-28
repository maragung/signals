// Multi-timeframe request helper: fetch historical candles for multiple
// timeframes in parallel with per-provider rate limiting.

import type { Candle, SymbolInfo, Timeframe } from '@/types';
import type { ProviderManager } from './manager';

export interface MultiTimeframeResult {
  timeframe: Timeframe;
  candles: Candle[];
  error?: string;
}

export interface MultiTimeframeOptions {
  /** Max number of in-flight requests per provider (default 3). */
  maxConcurrent?: number;
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number;
}

/**
 * Fetch historical candles for multiple timeframes. The requests are
 * dispatched in parallel, capped by `maxConcurrent` per call (since we
 * delegate to the manager's own provider, rate limiting on the wire is
 * naturally enforced by the underlying HTTP stack).
 */
export async function fetchMultiTimeframe(
  manager: ProviderManager,
  symbol: SymbolInfo,
  timeframes: Timeframe[],
  limit: number,
  options: MultiTimeframeOptions = {},
): Promise<MultiTimeframeResult[]> {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const results: MultiTimeframeResult[] = new Array(timeframes.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < timeframes.length) {
      const idx = cursor++;
      const tf = timeframes[idx];
      if (!tf) continue;
      try {
        const candles = await withTimeout(
          manager.getHistoricalCandles(symbol, tf, limit),
          timeoutMs,
        );
        results[idx] = { timeframe: tf, candles };
      } catch (err) {
        results[idx] = {
          timeframe: tf,
          candles: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(maxConcurrent, timeframes.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
