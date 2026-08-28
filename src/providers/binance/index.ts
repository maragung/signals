// BinanceProvider - REST + WebSocket market data for Binance USDT/BTC pairs.
//
// REST endpoint: https://api.binance.com/api/v3/klines
// WebSocket:     wss://stream.binance.com:9443/ws/<symbol>@kline_<interval>
// Ticker stream: wss://stream.binance.com:9443/ws/<symbol>@ticker
//
// The provider is constructed with optional transport hooks (createWebSocket,
// jsonFetch) so it can be unit tested without real network access.

import { fromTuples, sortCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';
import type {
  Candle,
  CandleCallback,
  ConnectionStatus,
  StatusCallback,
  TickerCallback,
  Unsubscribe,
} from '@/types';
import type { SymbolInfo, Timeframe } from '@/types';
import { TIMEFRAME_TO_BINANCE, type MarketDataProvider } from '../types';
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

// Multiple upstream REST + WS servers for resilience. The first entry MUST
// remain the canonical Binance endpoint so the existing MockWebSocket tests
// (which expect wss://stream.binance.com:9443/ws) keep passing.
const REST_BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://data-api.binance.vision',
];
const WS_BASES = [
  'wss://stream.binance.com:9443/ws',
  'wss://stream.binance.com:443/ws',
];
const PROXY_BASE = '/api/binance';

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_CHECK_MS = 5_000;

export interface BinanceProviderOptions {
  /** Force the use of the /api/binance proxy instead of api.binance.com. */
  useProxy?: boolean;
  /** Override fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (used in tests). */
  WebSocketCtor?: new (url: string) => WebSocket;
  /** Sleep override (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Minimal WebSocket interface used by the provider. */
export interface ProviderWebSocket extends WebSocket {
  // Re-export for typing; nothing custom needed.
}

export class BinanceProvider implements MarketDataProvider {
  public readonly name = 'binance';
  private readonly opts: Required<Omit<BinanceProviderOptions, 'useProxy'>> & { useProxy: boolean };
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(options: BinanceProviderOptions = {}) {
    this.opts = {
      useProxy: options.useProxy ?? false,
      fetchImpl: options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch not available'))) as unknown as typeof fetch),
      WebSocketCtor: options.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as new (url: string) => WebSocket)),
      sleepFn: options.sleepFn ?? sleep,
    };
  }

  /** Register a symbol so the provider can return it from getSymbolInfo. */
  registerSymbol(symbol: SymbolInfo): void {
    if (symbol.providerIds[this.name]) {
      this.symbols.set(symbol.id, symbol);
    }
  }

  getSymbolInfo(id: string): SymbolInfo | undefined {
    return this.symbols.get(id);
  }

  private restBase(): string {
    return this.opts.useProxy ? PROXY_BASE : REST_BASES[0]!;
  }

  private restBases(): string[] {
    return this.opts.useProxy ? [PROXY_BASE] : REST_BASES;
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const binanceSymbol = symbol.providerIds[this.name];
    if (!binanceSymbol) return [];
    if (!isFiniteNum(limit) || limit <= 0) return [];
    const cappedLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const interval = TIMEFRAME_TO_BINANCE[timeframe];
    const params = new URLSearchParams({
      symbol: binanceSymbol.toUpperCase(),
      interval,
      limit: String(cappedLimit),
    });
    if (isFiniteNum(endTime)) {
      // Binance expects ms.
      params.set('endTime', String(Math.floor((endTime as number) * 1000)));
    }
    // Try each upstream REST base in order; return the first non-empty result.
    let lastData: unknown = null;
    for (const base of this.restBases()) {
      const url = `${base}/api/v3/klines?${params.toString()}`;
      const res = await safeJsonFetchWithStatus(url, {}, 15000, this.opts.fetchImpl);
      if (res.data !== null && Array.isArray(res.data)) {
        lastData = res.data;
        break;
      }
      // If the upstream explicitly geo-blocked us (451/403/407) there is no
      // point retrying the same host family; fall through to the next base.
      if (res.status === 451 || res.status === 403 || res.status === 407) {
        continue;
      }
      // Null body but 2xx — treat as empty and stop (Binance returned []).
      if (res.ok) {
        lastData = res.data;
        break;
      }
    }
    const data = lastData;
    if (!Array.isArray(data)) return [];
    // Binance returns open time in ms; convert to seconds (our canonical unit).
    const tuples = (data as number[][]).map((row) => {
      if (Array.isArray(row) && row.length > 0 && typeof row[0] === 'number' && row[0] > 1e12) {
        return [Math.floor(row[0] / 1000), ...row.slice(1)];
      }
      return row;
    });
    return sortCandles(fromTuples(tuples));
  }

  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    return this.startKlineStream(symbol, timeframe, onCandle, onStatus);
  }

  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    return this.startTickerStream(symbol, onTicker, onStatus);
  }

  // ---------------- internal: kline stream ----------------

  private startKlineStream(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const binanceSymbol = symbol.providerIds[this.name];
    if (!binanceSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      // Server-side or no WS - report error and don't connect.
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }

    const stream = `${binanceSymbol.toLowerCase()}@kline_${TIMEFRAME_TO_BINANCE[timeframe]}`;
    const emitStatus = makeStatusEmitter(onStatus);
    const urls = WS_BASES.map((b) => `${b}/${stream}`);
    return this.startWsWithFallback(urls, emitStatus, (raw) => {
      const parsed = parseWsJson(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      const k = obj.k as Record<string, unknown> | undefined;
      if (!k) return;
      const candle = sanitizeCandle({
        time: tsSeconds(k.t),
        open: num(k.o, NaN),
        high: num(k.h, NaN),
        low: num(k.l, NaN),
        close: num(k.c, NaN),
        volume: num(k.v, 0),
      });
      if (candle) onCandle(candle);
    });
  }

  // ---------------- internal: ticker stream ----------------

  private startTickerStream(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const binanceSymbol = symbol.providerIds[this.name];
    if (!binanceSymbol) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    if (!isBrowser() || !hasWebSocket()) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }

    const stream = `${binanceSymbol.toLowerCase()}@ticker`;
    const emitStatus = makeStatusEmitter(onStatus);
    const urls = WS_BASES.map((b) => `${b}/${stream}`);
    return this.startWsWithFallback(urls, emitStatus, (raw) => {
      const parsed = parseWsJson(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      const ticker = sanitizeTicker(
        {
          symbol: typeof obj.s === 'string' ? (obj.s as string) : symbol.display,
          price: num(obj.c, 0),
          change24h: num(obj.p, 0),
          changePercent24h: num(obj.P, 0),
          high24h: num(obj.h, 0),
          low24h: num(obj.l, 0),
          volume24h: num(obj.v, 0),
          timestamp: tsSeconds(obj.E),
        },
        symbol.display,
      );
      if (ticker.price > 0) onTicker(ticker);
    });
  }

  /**
   * Drive `createStreamController` across multiple WS URLs. If a base emits
   * `error` before any connection succeeded we move to the next URL; only once
   * every URL has failed do we surface `error` to the consumer (which lets the
   * manager fail over to the next provider). The existing `createStreamController`
   * itself is left untouched (its behavior/tests are unchanged).
   */
  private startWsWithFallback(
    urls: string[],
    onStatus: StatusCallback,
    onMessage: (raw: string) => void,
  ): Unsubscribe {
    let idx = 0;
    let closed = false;
    let controller: { close: () => void } | null = null;

    const connectNext = () => {
      if (closed || idx >= urls.length) {
        if (!closed) onStatus('error');
        return;
      }
      if (controller) controller.close();
      const url = urls[idx]!;
      controller = createStreamController({
        url,
        symbol: undefined as unknown as SymbolInfo,
        kind: 'kline',
        onStatus: (s) => {
          if (s === 'closed' && !closed) return; // internal transition
          if (s === 'error') {
            if (idx < urls.length - 1) {
              idx += 1;
              connectNext();
              return;
            }
            onStatus('error');
            return;
          }
          onStatus(s);
        },
        WebSocketCtor: this.opts.WebSocketCtor,
        sleepFn: this.opts.sleepFn,
        onMessage,
      });
    };

    connectNext();
    return () => {
      closed = true;
      controller?.close();
    };
  }
}

// ---------------- shared stream controller ----------------

interface StreamControllerOptions {
  url: string;
  symbol: SymbolInfo;
  kind: 'kline' | 'ticker';
  WebSocketCtor: new (url: string) => WebSocket;
  sleepFn: (ms: number) => Promise<void>;
  onStatus: (s: ConnectionStatus) => void;
  onMessage: (raw: string) => void;
}

/** A simple WebSocket wrapper that handles reconnection and heartbeat detection. */
function createStreamController(opts: StreamControllerOptions): { close: () => void } {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let lastMessage = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const connect = () => {
    if (closed) return;
    opts.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      ws = new opts.WebSocketCtor(opts.url);
    } catch {
      opts.onStatus('error');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempt = 0;
      lastMessage = Date.now();
      opts.onStatus('connected');
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastMessage > HEARTBEAT_TIMEOUT_MS) {
          // No message for 60s - assume connection is dead.
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        }
      }, HEARTBEAT_CHECK_MS);
    };

    ws.onmessage = (ev: MessageEvent) => {
      lastMessage = Date.now();
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      try {
        opts.onMessage(data);
      } catch {
        /* listener error: swallow */
      }
    };

    ws.onerror = () => {
      opts.onStatus('error');
    };

    ws.onclose = () => {
      clearHeartbeat();
      if (closed) {
        opts.onStatus('closed');
        return;
      }
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    // backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const baseDelay = delays[Math.min(attempt, delays.length - 1)] ?? 30000;
    const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
    const wait = Math.max(0, Math.floor(baseDelay + jitter));
    attempt += 1;
    opts.onStatus('reconnecting');
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };

  // Kick off connection asynchronously so caller receives 'connecting' cleanly.
  queueMicrotask(connect);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearHeartbeat();
      clearReconnect();
      if (ws) {
        try {
          ws.onclose = null;
          ws.onerror = null;
          ws.onmessage = null;
          ws.onopen = null;
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      opts.onStatus('closed');
    },
  };
}

function parseWsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
