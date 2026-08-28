// BitgetProvider - REST + WebSocket market data for Bitget spot.
//
// REST endpoint:  https://api.bitget.com/api/v2/spot/market/candles
// WS:            wss://ws.bitget.com/spot/v1/stream
//
// Bitget v2 does NOT support 2h or 3m granularities, so we fetch the nearest
// finer granularity (1m for 3m, 1H for 2h) and aggregate up. Never-throw
// contract mirrors BinanceProvider; multiple upstream servers are tried.

import { aggregateCandles, fromTuples, sortCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';
import { tfToSeconds, type Candle, type ConnectionStatus, type SymbolInfo, type TickerData, type Timeframe } from '@/types';
import type { CandleCallback, MarketDataProvider, StatusCallback, TickerCallback, Unsubscribe } from '../types';
import { createMultiStreamController } from '../_stream';
import {
  hasWebSocket,
  isBrowser,
  makeStatusEmitter,
  num,
  safeJsonFetchWithStatus,
  sanitizeCandle,
  sanitizeTicker,
  sleep,
  tsSeconds,
} from '../_utils';

const REST_BASES = ['https://api.bitget.com', 'https://api-na.bitget.com'];
const WS_BASES = ['wss://ws.bitget.com/spot/v1/stream', 'wss://ws.bitget.com/mix/v1/stream'];
const PROXY_BASE = '/api/bitget';

// Bitget v2 granularity strings actually supported by the API.
const GRAN_STRING: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '1m', // unsupported -> use 1m, aggregate 3
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '1H', // unsupported -> use 1H, aggregate 2
  '4h': '4H',
  '6h': '6H',
  '12h': '12H',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};

const GRAN_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1H': 3600,
  '4H': 14400,
  '6H': 21600,
  '12H': 43200,
  '1D': 86400,
  '1W': 604800,
  '1M': 2592000,
};

export interface BitgetProviderOptions {
  /** Use the /api/bitget proxy instead of the upstream base. */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (used in tests). */
  WebSocketCtor?: new (url: string) => WebSocket;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

export class BitgetProvider implements MarketDataProvider {
  public readonly name = 'bitget';
  private readonly opts: Required<Omit<BitgetProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(options: BitgetProviderOptions = {}) {
    this.opts = {
      useProxy: options.useProxy ?? false,
      fetchImpl: options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch),
      WebSocketCtor: options.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as new (url: string) => WebSocket)),
      sleepFn: options.sleepFn ?? sleep,
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

  private restBases(): string[] {
    return this.opts.useProxy ? [PROXY_BASE] : REST_BASES;
  }

  private wsBases(): string[] {
    return this.opts.useProxy ? [`${PROXY_BASE}/spot/v1/stream`] : WS_BASES;
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const bitgetSymbol = symbol.providerIds[this.name];
    if (!bitgetSymbol) return [];
    if (!isFiniteNum(limit) || limit <= 0) return [];
    const cappedLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const gran = GRAN_STRING[timeframe];
    const targetSec = tfToSeconds(timeframe);
    const baseSec = GRAN_SECONDS[gran] ?? 60;
    const multiplier = Math.max(1, Math.ceil(targetSec / baseSec));
    const fetchLimit = Math.min(1000, cappedLimit * multiplier);

    const params = new URLSearchParams({
      symbol: bitgetSymbol.toUpperCase(),
      granularity: gran,
      limit: String(fetchLimit),
    });
    if (isFiniteNum(endTime)) {
      // Bitget v2 uses end time in ms.
      params.set('endTime', String(Math.floor((endTime as number) * 1000)));
    }

    for (const base of this.restBases()) {
      const url = `${base}/api/v2/spot/market/candles?${params.toString()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.status === 451 || res.status === 403 || res.status === 407) continue;
      const body = res.data as { data?: unknown[] } | null;
      const rows = body?.data;
      if (Array.isArray(rows) && rows.length > 0) {
        // Bitget rows: [tsMs, open, high, low, close, vol, ...] (newest-first).
        const tuples = (rows as unknown[][])
          .map((row) => {
            const ts = tsSeconds(row[0]);
            return [ts, num(row[1], NaN), num(row[2], NaN), num(row[3], NaN), num(row[4], NaN), num(row[5], 0)];
          })
          .reverse();
        let candles = sortCandles(fromTuples(tuples)).filter((c) => sanitizeCandle(c) !== null) as Candle[];
        if (multiplier > 1) {
          candles = aggregateCandles(candles, timeframe);
        }
        if (candles.length > cappedLimit) {
          candles = candles.slice(candles.length - cappedLimit);
        }
        return candles;
      }
      if (res.ok) return [];
    }
    return [];
  }

  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const bitgetSymbol = symbol.providerIds[this.name];
    if (!bitgetSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const gran = GRAN_STRING[timeframe];
    const channel = `candle${gran}`;
    const args = [{ instType: 'SPOT', channel, instId: bitgetSymbol.toUpperCase() }];
    const urls = this.wsBases();
    const emitStatus = makeStatusEmitter(onStatus);
    const controller = createMultiStreamController({
      urls,
      WebSocketCtor: this.opts.WebSocketCtor,
      sleepFn: this.opts.sleepFn,
      onStatus: emitStatus,
      onOpen: (ws) => {
        try {
          ws.send(JSON.stringify({ op: 'subscribe', args }));
        } catch {
          /* ignore */
        }
      },
      onMessage: (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        const obj = parsed as Record<string, unknown>;
        const arg = obj.arg as Record<string, unknown> | undefined;
        if (!arg || typeof arg.channel !== 'string' || !arg.channel.startsWith('candle')) return;
        const data = obj.data as unknown[] | undefined;
        const row = data?.[0];
        if (!Array.isArray(row)) return;
        const candle = sanitizeCandle({
          time: tsSeconds(row[0]),
          open: num(row[1], NaN),
          high: num(row[2], NaN),
          low: num(row[3], NaN),
          close: num(row[4], NaN),
          volume: num(row[5], 0),
        });
        if (candle) onCandle(candle);
      },
    });
    return () => controller.close();
  }

  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const bitgetSymbol = symbol.providerIds[this.name];
    if (!bitgetSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const args = [{ instType: 'SPOT', channel: 'tickers', instId: bitgetSymbol.toUpperCase() }];
    const urls = this.wsBases();
    const emitStatus = makeStatusEmitter(onStatus);
    const controller = createMultiStreamController({
      urls,
      WebSocketCtor: this.opts.WebSocketCtor,
      sleepFn: this.opts.sleepFn,
      onStatus: emitStatus,
      onOpen: (ws) => {
        try {
          ws.send(JSON.stringify({ op: 'subscribe', args }));
        } catch {
          /* ignore */
        }
      },
      onMessage: (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        const obj = parsed as Record<string, unknown>;
        const arg = obj.arg as Record<string, unknown> | undefined;
        if (!arg || typeof arg.channel !== 'string' || arg.channel !== 'tickers') return;
        const d = obj.data as Record<string, unknown> | undefined;
        if (!d) return;
        const ticker = sanitizeTicker(
          {
            symbol: symbol.display,
            price: num(d.last, 0),
            change24h: num(d.priceChange, 0),
            changePercent24h: num(d.priceChangePercent, 0),
            high24h: num(d.high24h, 0),
            low24h: num(d.low24h, 0),
            volume24h: num(d.baseVolume, 0),
            timestamp: tsSeconds(d.ts),
          },
          symbol.display,
        );
        if (ticker.price > 0) onTicker(ticker);
      },
    });
    return () => controller.close();
  }
}
