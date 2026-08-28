// OkxProvider - REST + WebSocket market data for OKX spot.
//
// REST endpoint:  https://www.okx.com/api/v5/market/history-candles
// WS:            wss://ws.okx.com:8443/ws/v5/public
//
// Never-throw contract mirrors BinanceProvider. Multiple upstream servers are
// tried for both REST and WS resilience.

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

const REST_BASES = ['https://www.okx.com', 'https://okx.com'];
const WS_BASES = ['wss://ws.okx.com:8443/ws/v5/public', 'wss://wsaws.okx.com:8443/ws/v5/public'];
const PROXY_BASE = '/api/okx';

const BAR_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6H',
  '12h': '12H',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};

export interface OkxProviderOptions {
  /** Use the /api/okx proxy instead of the upstream base. */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (used in tests). */
  WebSocketCtor?: new (url: string) => WebSocket;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

export class OkxProvider implements MarketDataProvider {
  public readonly name = 'okx';
  private readonly opts: Required<Omit<OkxProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(options: OkxProviderOptions = {}) {
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
    return this.opts.useProxy ? [`${PROXY_BASE}/v5/public`] : WS_BASES;
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const okxSymbol = symbol.providerIds[this.name];
    if (!okxSymbol) return [];
    if (!isFiniteNum(limit) || limit <= 0) return [];
    const cappedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const bar = BAR_MAP[timeframe];
    const params = new URLSearchParams({
      instId: okxSymbol.toUpperCase(),
      bar,
      limit: String(cappedLimit),
    });
    if (isFiniteNum(endTime)) {
      params.set('after', String(Math.floor((endTime as number) * 1000)));
    }

    for (const base of this.restBases()) {
      const url = `${base}/api/v5/market/history-candles?${params.toString()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.status === 451 || res.status === 403 || res.status === 407) continue;
      const body = res.data as { data?: unknown[] } | null;
      const rows = body?.data;
      if (Array.isArray(rows) && rows.length > 0) {
        // Rows: [tsMs, open, high, low, close, vol, volCcy]. Newest-first.
        const tuples = (rows as unknown[][])
          .map((row) => {
            const ts = tsSeconds(row[0]);
            return [ts, num(row[1], NaN), num(row[2], NaN), num(row[3], NaN), num(row[4], NaN), num(row[5], 0)];
          })
          .reverse();
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
    const okxSymbol = symbol.providerIds[this.name];
    if (!okxSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const bar = BAR_MAP[timeframe];
    const args = [{ channel: `candle${bar}`, instId: okxSymbol.toUpperCase() }];
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
    const okxSymbol = symbol.providerIds[this.name];
    if (!okxSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const args = [{ channel: 'tickers', instId: okxSymbol.toUpperCase() }];
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
        const data = obj.data as Record<string, unknown>[] | undefined;
        const d = data?.[0];
        if (!d) return;
        const ticker = sanitizeTicker(
          {
            symbol: symbol.display,
            price: num(d.last, 0),
            change24h: num(d.open24h, 0) ? num(d.last, 0) - num(d.open24h, 0) : 0,
            changePercent24h: num(d.percentChange24h, 0),
            high24h: num(d.high24h, 0),
            low24h: num(d.low24h, 0),
            volume24h: num(d.vol24h, 0),
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
