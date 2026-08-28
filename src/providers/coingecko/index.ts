// CoinGeckoProvider - REST-only market data using CoinGecko's free public API.
//
// Real-time websocket is not available on the free tier; the provider polls
// every 30 seconds and approximates the "live" feed by transforming the
// latest tick into a candle/ticker event.
//
// XAU/USD is approximated using PAX Gold (pax-gold) as a proxy. The user
// must be informed in UI that this is a derived value, not a direct gold
// spot price.

import { aggregateCandles, sortCandles } from '@/core/utils/candles';
import { tfToMs } from '@/types';
import type { Candle, ConnectionStatus, SymbolInfo, TickerData, Timeframe } from '@/types';
import {
  aggregateTicksToCandles,
  isBrowser,
  makeStatusEmitter,
  num,
  safeJsonFetch,
  sanitizeCandle,
  sanitizeTicker,
  sleep,
  tsSeconds,
} from '../_utils';
import type { MarketDataProvider, StatusCallback, Unsubscribe } from '../types';

const REST_BASE = 'https://api.coingecko.com/api/v3';
const PROXY_BASE = '/api/coingecko';
const POLL_INTERVAL_MS = 30_000;

export interface CoinGeckoProviderOptions {
  /** Use /api/coingecko proxy (default true - avoids CORS in browser). */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Polling interval in ms (default 30s). Set to 0 to disable. */
  pollIntervalMs?: number;
}

interface CoinGeckoMarketChart {
  prices?: [number, number][];
  market_caps?: [number, number][];
  total_volumes?: [number, number][];
}

interface CoinGeckoCoin {
  id?: string;
  symbol?: string;
  name?: string;
  market_data?: {
    current_price?: Record<string, number>;
    price_change_24h?: number;
    price_change_percentage_24h?: number;
    high_24h?: Record<string, number>;
    low_24h?: Record<string, number>;
    total_volume?: Record<string, number>;
    last_updated?: number;
  };
}

export class CoinGeckoProvider implements MarketDataProvider {
  public readonly name = 'coingecko';
  private readonly opts: Required<Omit<CoinGeckoProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();
  private readonly activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly activeIntervals = new Set<ReturnType<typeof setInterval>>();

  constructor(options: CoinGeckoProviderOptions = {}) {
    this.opts = {
      useProxy: options.useProxy ?? true,
      fetchImpl: options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch),
      sleepFn: options.sleepFn ?? sleep,
      pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    };
  }

  registerSymbol(symbol: SymbolInfo): void {
    if (symbol.providerIds[this.name]) {
      this.symbols.set(symbol.id, symbol);
    }
  }

  getSymbolInfo(id: string): SymbolInfo | undefined {
    return this.symbols.get(id);
  }

  private restBase(): string {
    return this.opts.useProxy ? PROXY_BASE : REST_BASE;
  }

  private coinId(symbol: SymbolInfo): string | undefined {
    return symbol.providerIds[this.name];
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const id = this.coinId(symbol);
    if (!id) return [];
    if (!Number.isFinite(limit) || limit <= 0) return [];

    // Map limit to CoinGecko's `days` parameter. CoinGecko has fixed
    // resolutions beyond 90 days (daily), so for >90d we request the full
    // window and then aggregate.
    const approxDays = estimateDays(limit, timeframe);
    const vsCurrency = symbol.quote.toLowerCase() === 'usd' ? 'usd' : symbol.quote.toLowerCase();
    const params = new URLSearchParams({ vs_currency: vsCurrency, days: String(approxDays) });
    const url = `${this.restBase()}/coins/${encodeURIComponent(id)}/market_chart?${params.toString()}`;
    const data = (await safeJsonFetch(url, {}, 20000, this.opts.fetchImpl)) as CoinGeckoMarketChart | null;
    if (!data || !Array.isArray(data.prices)) return [];

    const bucketMs = tfToMs(timeframe);
    const ticks: [number, number][] = [];
    for (let i = 0; i < data.prices.length; i++) {
      const p = data.prices[i];
      if (!p) continue;
      ticks.push([p[0], num(p[1], NaN)]);
    }
    let candles = aggregateTicksToCandles(ticks, bucketMs);

    // If we have volume series, attribute volume to candles proportionally by
    // averaging. This is a rough approximation because CoinGecko gives one
    // volume tick per period that doesn't always align with the bucket.
    if (Array.isArray(data.total_volumes) && data.total_volumes.length > 0) {
      const volMap = new Map<number, number>();
      for (let i = 0; i < data.total_volumes.length; i++) {
        const v = data.total_volumes[i];
        if (!v) continue;
        volMap.set(Math.floor(v[0] / 1000), num(v[1], 0));
      }
      candles = candles.map((c) => {
        // Find the nearest volume tick within the bucket window.
        const startMs = c.time * 1000;
        const v = volMap.get(Math.floor(startMs / 1000)) ?? 0;
        return { ...c, volume: v };
      });
    }

    candles = sortCandles(candles.filter((c) => sanitizeCandle(c) !== null) as Candle[]);

    // Apply endTime filter and limit
    if (Number.isFinite(endTime)) {
      const end = endTime as number;
      candles = candles.filter((c) => c.time <= end);
    }
    if (candles.length > limit) {
      candles = candles.slice(candles.length - limit);
    }

    // For XAU/USD we apply a final aggregation step in case the bucket
    // didn't align with timeframe (CoinGecko is sparse for low-volume assets).
    if (symbol.category === 'metal') {
      candles = aggregateCandles(candles, timeframe);
    }
    return candles;
  }

  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: (c: Candle) => void,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const id = this.coinId(symbol);
    if (!id) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const emitStatus = makeStatusEmitter(onStatus);
    emitStatus('connecting');
    let lastTime = 0;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        // Use the 1d ticker endpoint as a heartbeat and the market chart
        // for incremental candles. The `lastTime` tracker prevents emitting
        // candles we've already seen.
        const params = new URLSearchParams({ localization: 'false', tickers: 'false', community_data: 'false', developer_data: 'false' });
        const url = `${this.restBase()}/coins/${encodeURIComponent(id)}?${params.toString()}`;
        const coin = (await safeJsonFetch(url, {}, 15000, this.opts.fetchImpl)) as CoinGeckoCoin | null;
        if (cancelled) return;
        if (coin && coin.market_data) {
          const md = coin.market_data;
          const vsKey = symbol.quote.toLowerCase() === 'usd' ? 'usd' : symbol.quote.toLowerCase();
          const price = num(md.current_price?.[vsKey], NaN);
          if (Number.isFinite(price)) {
            const bucketMs = tfToMs(timeframe);
            const nowMs = Date.now();
            const candleTime = Math.floor(nowMs / bucketMs) * bucketMs;
            const candleTimeSec = Math.floor(candleTime / 1000);
            if (candleTimeSec !== lastTime) {
              const candle: Candle = {
                time: candleTimeSec,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: num(md.total_volume?.[vsKey], 0),
              };
              const safe = sanitizeCandle(candle);
              if (safe) {
                lastTime = safe.time;
                onCandle(safe);
                emitStatus('connected');
              }
            }
          }
        }
      } catch {
        emitStatus('error');
      }
    };

    void poll();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.opts.pollIntervalMs > 0 && isBrowser()) {
      timer = setInterval(() => {
        void poll();
      }, this.opts.pollIntervalMs);
      this.activeIntervals.add(timer);
    }
    emitStatus('connected');

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
        this.activeIntervals.delete(timer);
        timer = null;
      }
      emitStatus('closed');
    };
  }

  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: (t: TickerData) => void,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const id = this.coinId(symbol);
    if (!id) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const emitStatus = makeStatusEmitter(onStatus);
    emitStatus('connecting');
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const params = new URLSearchParams({ localization: 'false', tickers: 'false', community_data: 'false', developer_data: 'false' });
        const url = `${this.restBase()}/coins/${encodeURIComponent(id)}?${params.toString()}`;
        const coin = (await safeJsonFetch(url, {}, 15000, this.opts.fetchImpl)) as CoinGeckoCoin | null;
        if (cancelled || !coin || !coin.market_data) return;
        const md = coin.market_data;
        const vsKey = symbol.quote.toLowerCase() === 'usd' ? 'usd' : symbol.quote.toLowerCase();
        const ticker = sanitizeTicker(
          {
            symbol: symbol.display,
            price: num(md.current_price?.[vsKey], 0),
            change24h: num(md.price_change_24h, 0),
            changePercent24h: num(md.price_change_percentage_24h, 0),
            high24h: num(md.high_24h?.[vsKey], 0),
            low24h: num(md.low_24h?.[vsKey], 0),
            volume24h: num(md.total_volume?.[vsKey], 0),
            timestamp: tsSeconds(md.last_updated),
          },
          symbol.display,
        );
        if (ticker.price > 0) {
          onTicker(ticker);
          emitStatus('connected');
        }
      } catch {
        emitStatus('error');
      }
    };

    void poll();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.opts.pollIntervalMs > 0 && isBrowser()) {
      timer = setInterval(() => {
        void poll();
      }, this.opts.pollIntervalMs);
      this.activeIntervals.add(timer);
    }
    emitStatus('connected');

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
        this.activeIntervals.delete(timer);
        timer = null;
      }
      emitStatus('closed');
    };
  }

  /** For tests/cleanup. */
  dispose(): void {
    for (const t of this.activeIntervals) clearInterval(t);
    for (const t of this.activeTimers) clearTimeout(t);
    this.activeIntervals.clear();
    this.activeTimers.clear();
  }
}

/**
 * Estimate the number of days to request from CoinGecko given a target
 * number of candles and a timeframe. Always biased a little high so we
 * don't truncate the requested range.
 */
function estimateDays(limit: number, tf: Timeframe): number {
  const ms = limit * tfToMs(tf);
  const days = Math.ceil(ms / 86_400_000);
  // CoinGecko supports 1, 7, 14, 30, 90, 180, 365, max. For simplicity we
  // return the exact day count; the API will downsample automatically for
  // longer windows.
  if (days <= 1) return 1;
  if (days <= 7) return 7;
  if (days <= 14) return 14;
  if (days <= 30) return 30;
  if (days <= 90) return 90;
  if (days <= 180) return 180;
  if (days <= 365) return 365;
  return Math.min(2000, days);
}
