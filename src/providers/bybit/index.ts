// BybitProvider - REST + WebSocket market data for Bybit spot.
//
// REST endpoint:  https://api.bybit.com/v5/market/kline?category=spot
// WS:            wss://stream.bybit.com/v5/public/spot
//
// Mirrors BinanceProvider's never-throw contract: getHistoricalCandles returns
// [] on any failure, and subscriptions return an unsubscribe fn while emitting
// ConnectionStatus via onStatus. Multiple upstream servers are tried for both
// REST and WS resilience.

import { fromTuples, sortCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';
import type { Candle, ConnectionStatus, SymbolInfo, TickerData, Timeframe } from '@/types';
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

const REST_BASES = ['https://api.bybit.com', 'https://api.bytick.com', 'https://api2.bybit.com'];
const WS_BASES = ['wss://stream.bybit.com/v5/public/spot', 'wss://stream.bybit.gg/v5/public/spot'];
const PROXY_BASE = '/api/bybit';

const INTERVAL_MAP: Record<Timeframe, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
  '1w': 'W',
  '1M': 'M',
};

export interface BybitProviderOptions {
  /** Use the /api/bybit proxy instead of the upstream base. */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (used in tests). */
  WebSocketCtor?: new (url: string) => WebSocket;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

export class BybitProvider implements MarketDataProvider {
  public readonly name = 'bybit';
  private readonly opts: Required<Omit<BybitProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(options: BybitProviderOptions = {}) {
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
    // WebSockets cannot be relayed through the REST /api proxy, so live
    // streams always connect directly to the provider's public wss endpoint.
    return WS_BASES;
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const bybitSymbol = symbol.providerIds[this.name];
    if (!bybitSymbol) return [];
    if (!isFiniteNum(limit) || limit <= 0) return [];
    const cappedLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const interval = INTERVAL_MAP[timeframe];
    const params = new URLSearchParams({
      category: 'spot',
      symbol: bybitSymbol.toUpperCase(),
      interval,
      limit: String(cappedLimit),
    });
    if (isFiniteNum(endTime)) {
      params.set('endTime', String(Math.floor((endTime as number) * 1000)));
    }

    for (const base of this.restBases()) {
      const url = `${base}/v5/market/kline?${params.toString()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.status === 451 || res.status === 403 || res.status === 407) continue;
      const body = res.data as { result?: { list?: unknown[] } } | null;
      const list = body?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        // Rows: [startTimeMs, open, high, low, close, volume, turnover, ...]
        const tuples = (list as unknown[][]).map((row) => {
          const start = tsSeconds(row[0]);
          return [start, num(row[1], NaN), num(row[2], NaN), num(row[3], NaN), num(row[4], NaN), num(row[5], 0)];
        });
        return sortCandles(fromTuples(tuples)).filter((c) => sanitizeCandle(c) !== null) as Candle[];
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
    const bybitSymbol = symbol.providerIds[this.name];
    if (!bybitSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const interval = INTERVAL_MAP[timeframe];
    const args = [`kline.${bybitSymbol.toUpperCase()}.${interval}`];
    const urls = this.wsBases().map((b) => b);
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
        if (typeof obj.topic !== 'string' || !obj.topic.startsWith('kline')) return;
        const data = obj.data as Record<string, unknown>[] | undefined;
        const d = data?.[0];
        if (!d) return;
        const candle = sanitizeCandle({
          time: tsSeconds(d.start),
          open: num(d.open, NaN),
          high: num(d.high, NaN),
          low: num(d.low, NaN),
          close: num(d.close, NaN),
          volume: num(d.volume, 0),
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
    const bybitSymbol = symbol.providerIds[this.name];
    if (!bybitSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const args = [`tickers.${bybitSymbol.toUpperCase()}`];
    const urls = this.wsBases().map((b) => b);
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
        if (typeof obj.topic !== 'string' || !obj.topic.startsWith('tickers')) return;
        const data = obj.data as Record<string, unknown>[] | undefined;
        const d = data?.[0];
        if (!d) return;
        const ticker = sanitizeTicker(
          {
            symbol: symbol.display,
            price: num(d.lastPrice, 0),
            change24h: num(d.price24h, 0),
            changePercent24h: num(d.price24hPcnt, 0) * 100,
            high24h: num(d.highPrice24h, 0),
            low24h: num(d.lowPrice24h, 0),
            volume24h: num(d.volume24h, 0),
            timestamp: tsSeconds(d.timestamp),
          },
          symbol.display,
        );
        if (ticker.price > 0) onTicker(ticker);
      },
    });

    return () => controller.close();
  }
}
