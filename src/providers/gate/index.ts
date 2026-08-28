// GateProvider - REST + WebSocket market data for Gate.io spot.
//
// REST endpoint:  https://api.gateio.ws/api/v4/spot/candlesticks
// WS:            wss://api.gateio.ws/ws/v4
//
// Never-throw contract mirrors BinanceProvider. Multiple upstream servers are
// tried for both REST and WS resilience.

import { fromTuples, sortCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';
import type { Candle, ConnectionStatus, SymbolInfo, TickerData, Timeframe } from '@/types';
import type { CandleCallback, MarketDataProvider, StatusCallback, TickerCallback, Unsubscribe } from '../types';
import { createMultiStreamController } from '../_stream';
import { startPollingStream } from '../_poll';
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

const REST_BASES = ['https://api.gateio.ws', 'https://api.gate.io'];
const WS_BASES = ['wss://api.gateio.ws/ws/v4', 'wss://ws.gateio.ws/v4'];
const PROXY_BASE = '/api/gate';

const INTERVAL_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '6h': '6h',
  '12h': '12h',
  '1d': '1d',
  '1w': '1w',
  '1M': '1M',
};

export interface GateProviderOptions {
  /** Use the /api/gate proxy instead of the upstream base. */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (used in tests). */
  WebSocketCtor?: new (url: string) => WebSocket;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Live-update poll interval in ms when using the server proxy (default 2000). */
  pollIntervalMs?: number;
}

export class GateProvider implements MarketDataProvider {
  public readonly name = 'gate';
  private readonly opts: Required<Omit<GateProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(options: GateProviderOptions = {}) {
    this.opts = {
      useProxy: options.useProxy ?? false,
      fetchImpl: options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch),
      WebSocketCtor: options.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as new (url: string) => WebSocket)),
      sleepFn: options.sleepFn ?? sleep,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
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
    const gateSymbol = symbol.providerIds[this.name];
    if (!gateSymbol) return [];
    if (!isFiniteNum(limit) || limit <= 0) return [];
    const cappedLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const interval = INTERVAL_MAP[timeframe];
    const params = new URLSearchParams({
      currency_pair: gateSymbol.toUpperCase(),
      interval,
      limit: String(cappedLimit),
    });
    if (isFiniteNum(endTime)) {
      params.set('to', String(Math.floor(endTime as number)));
    }

    for (const base of this.restBases()) {
      const url = `${base}/api/v4/spot/candlesticks?${params.toString()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.status === 451 || res.status === 403 || res.status === 407) continue;
      const rows = res.data as unknown[] | null;
      if (Array.isArray(rows) && rows.length > 0) {
        // Gate rows: [tsSec, volume, close, high, low, open, quoteVolume, ...]
        const tuples = (rows as unknown[][]).map((row) => {
          const ts = tsSeconds(row[0]);
          return [ts, num(row[5], NaN), num(row[3], NaN), num(row[4], NaN), num(row[2], NaN), num(row[1], 0)];
        });
        return sortCandles(fromTuples(tuples)).filter((c) => sanitizeCandle(c) !== null) as Candle[];
      }
      if (res.ok) return [];
    }
    return [];
  }

  /** Latest single candle (via REST, through the proxy when useProxy is set). */
  async fetchLatestCandle(symbol: SymbolInfo, timeframe: Timeframe): Promise<Candle | null> {
    const candles = await this.getHistoricalCandles(symbol, timeframe, 1);
    return candles.length > 0 ? candles[candles.length - 1]! : null;
  }

  /** Latest ticker (via REST spot tickers endpoint, through the proxy). */
  async fetchTicker(symbol: SymbolInfo): Promise<TickerData | null> {
    const id = symbol.providerIds[this.name];
    if (!id) return null;
    for (const base of this.restBases()) {
      const url = `${base}/api/v4/spot/tickers?currency_pair=${id.toUpperCase()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.status === 451 || res.status === 403 || res.status === 407) continue;
      const rows = res.data as unknown[] | null;
      const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) {
        if (res.ok) return null;
        continue;
      }
      const ticker = sanitizeTicker(
        {
          symbol: symbol.display,
          price: num(row.last, 0),
          change24h: num(row.change_value, 0),
          changePercent24h: num(row.change_percentage, 0),
          high24h: num(row.high, 0),
          low24h: num(row.low, 0),
          volume24h: num(row.base_volume, 0),
          timestamp: tsSeconds(row.utc_quote_ts ?? row.ts),
        },
        symbol.display,
      );
      return ticker.price > 0 ? ticker : null;
    }
    return null;
  }

  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const gateSymbol = symbol.providerIds[this.name];
    if (!gateSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (this.opts.useProxy) {
      return startPollingStream({
        candleFetcher: () => this.fetchLatestCandle(symbol, timeframe),
        intervalMs: this.opts.pollIntervalMs,
        onCandle,
        onStatus,
      });
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const interval = INTERVAL_MAP[timeframe];
    const payload = [`${gateSymbol.toUpperCase()},${interval}`];
    const urls = this.wsBases();
    const emitStatus = makeStatusEmitter(onStatus);
    const controller = createMultiStreamController({
      urls,
      WebSocketCtor: this.opts.WebSocketCtor,
      sleepFn: this.opts.sleepFn,
      onStatus: emitStatus,
      onOpen: (ws) => {
        try {
          ws.send(JSON.stringify({ channel: 'spot.candlesticks', event: 'subscribe', payload }));
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
        if (obj.channel !== 'spot.candlesticks' || obj.event !== 'update') return;
        const result = obj.result as unknown[] | undefined;
        const row = Array.isArray(result) ? result[0] : undefined;
        if (!Array.isArray(row)) return;
        const candle = sanitizeCandle({
          time: tsSeconds(row[0]),
          open: num(row[5], NaN),
          high: num(row[3], NaN),
          low: num(row[4], NaN),
          close: num(row[2], NaN),
          volume: num(row[1], 0),
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
    const gateSymbol = symbol.providerIds[this.name];
    if (!gateSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (this.opts.useProxy) {
      return startPollingStream({
        tickerFetcher: () => this.fetchTicker(symbol),
        intervalMs: this.opts.pollIntervalMs,
        onTicker,
        onStatus,
      });
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    const payload = [gateSymbol.toUpperCase()];
    const urls = this.wsBases();
    const emitStatus = makeStatusEmitter(onStatus);
    const controller = createMultiStreamController({
      urls,
      WebSocketCtor: this.opts.WebSocketCtor,
      sleepFn: this.opts.sleepFn,
      onStatus: emitStatus,
      onOpen: (ws) => {
        try {
          ws.send(JSON.stringify({ channel: 'spot.tickers', event: 'subscribe', payload }));
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
        if (obj.channel !== 'spot.tickers' || obj.event !== 'update') return;
        const d = obj.result as Record<string, unknown> | undefined;
        if (!d) return;
        const ticker = sanitizeTicker(
          {
            symbol: symbol.display,
            price: num(d.last, 0),
            change24h: num(d.change_value, 0),
            changePercent24h: num(d.change_percentage, 0),
            high24h: num(d.high, 0),
            low24h: num(d.low, 0),
            volume24h: num(d.base_volume, 0),
            timestamp: tsSeconds(d.utc_quote_ts ?? d.ts),
          },
          symbol.display,
        );
        if (ticker.price > 0) onTicker(ticker);
      },
    });
    return () => controller.close();
  }
}
