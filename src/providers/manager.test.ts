// Tests for the ProviderManager and the Binance stream controller.
//
// We mock the global WebSocket, fetch, and setTimeout timers so the
// reconnect loop and throttling can be exercised deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, ConnectionStatus, SymbolInfo, TickerData } from '@/types';
import { BinanceProvider } from './binance';
import { CoinGeckoProvider } from './coingecko';
import { ProviderManager, BACKOFF_SEQUENCE_MS } from './manager';
import type { CandleCallback, MarketDataProvider, StatusCallback, Unsubscribe } from './types';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockSocket extends EventTarget {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send: (data: string) => void;
  close: () => void;
}

class MockWebSocket implements MockSocket {
  public readonly url: string;
  public readyState = 0;
  public onopen: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public send = vi.fn();
  public close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.(new CloseEvent('close')), 0);
  });
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  /** Manually fire open. */
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  /** Manually fire a message. */
  fireMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }
  /** Manually fire an error. */
  fireError(): void {
    this.onerror?.(new Event('error'));
  }
  /** Manually fire a close. */
  fireClose(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances.length = 0;
  }
}

// Capture the most recent setTimeout calls so we can manually advance time
// without using fake timers (which are flaky with vitest's jsdom).
type TimerHandle = { id: number; at: number; fn: () => void };

let timerId = 0;
const pendingTimers: TimerHandle[] = [];
let realSetTimeout: typeof setTimeout;
let realClearTimeout: typeof clearTimeout;
let realSetInterval: typeof setInterval;
let realClearInterval: typeof clearInterval;
let virtualNow = 0;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    id: 'BTCUSD',
    display: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    category: 'crypto',
    providerIds: { binance: 'BTCUSDT', coingecko: 'bitcoin' },
    pricePrecision: 2,
    volumePrecision: 2,
    ...overrides,
  };
}

function makeCandle(time: number, close = 100): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

function flush(ms: number): void {
  // Advance virtual time and fire any due timers.
  virtualNow += ms;
  // Use real timers (microtask flush) to let queued callbacks run.
  return new Promise((resolve) => realSetTimeout(resolve, 0)) as unknown as void;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.reset();
  pendingTimers.length = 0;
  timerId = 0;
  virtualNow = 0;
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;

  // Provide a WebSocket on the global so BinanceProvider's isBrowser check
  // passes. We do this unconditionally so the manager path executes.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  // Also pin window for isBrowser().
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    (globalThis as unknown as { window: unknown }).window = { document: {} };
  }
});

afterEach(() => {
  // Restore globals and drop any leftover timers.
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  pendingTimers.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: dedup
// ---------------------------------------------------------------------------

describe('ProviderManager dedup', () => {
  it('drops out-of-order candles older than the most recent', () => {
    const manager = new ProviderManager({ throttleMs: 0 });
    const seen: Candle[] = [];
    const statuses: ConnectionStatus[] = [];

    // Use a fake provider that emits candles synchronously.
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, onCandle, onStatus): Unsubscribe => {
        onStatus('connected');
        onCandle(makeCandle(1000, 100));
        onCandle(makeCandle(2000, 110));
        onCandle(makeCandle(1500, 105)); // out of order
        onCandle(makeCandle(1000, 102)); // duplicate of an old time
        onStatus('closed');
        return () => undefined;
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);

    const unsub = manager.subscribeCandles(
      makeSymbol(),
      '1m',
      (c) => seen.push(c),
      (s) => statuses.push(s),
    );
    unsub();

    expect(seen.map((c) => c.time)).toEqual([1000, 2000]);
    expect(seen[0]?.close).toBe(100);
    expect(seen[1]?.close).toBe(110);
  });

  it('merges same-timestamp updates keeping latest close, max high, min low, sum volume', async () => {
    const manager = new ProviderManager({ throttleMs: 0 });
    const seen: Candle[] = [];
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, onCandle, onStatus): Unsubscribe => {
        onStatus('connected');
        onCandle({ time: 1000, open: 100, high: 102, low: 99, close: 101, volume: 5 });
        onCandle({ time: 1000, open: 100, high: 105, low: 98, close: 104, volume: 7 });
        onStatus('closed');
        return () => undefined;
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    manager.subscribeCandles(
      makeSymbol(),
      '1m',
      (c) => seen.push(c),
      () => undefined,
    );
    // Synchronous same-tick same-time updates: the manager buffers
    // them via a microtask so they can be merged into a single
    // emission. We await one microtask to let the emission fire.
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    const merged = seen[0]!;
    expect(merged.open).toBe(100); // open is from the first emission
    expect(merged.high).toBe(105);
    expect(merged.low).toBe(98);
    expect(merged.close).toBe(104);
    expect(merged.volume).toBe(12);
  });

  it('drops candles with NaN/Inf fields via sanitize', () => {
    const manager = new ProviderManager({ throttleMs: 0 });
    const seen: Candle[] = [];
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, onCandle, onStatus): Unsubscribe => {
        onStatus('connected');
        onCandle({ time: 1000, open: 100, high: NaN, low: 99, close: 101, volume: 1 });
        onCandle({ time: 2000, open: 100, high: 102, low: 99, close: 101, volume: 1 });
        onStatus('closed');
        return () => undefined;
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    manager.subscribeCandles(makeSymbol(), '1m', (c) => seen.push(c), () => undefined);
    expect(seen.map((c) => c.time)).toEqual([2000]);
  });
});

// ---------------------------------------------------------------------------
// Tests: provider selection
// ---------------------------------------------------------------------------

describe('ProviderManager pickProvider', () => {
  it('prefers binance over coingecko when both support the symbol', () => {
    const manager = new ProviderManager();
    const binance = new BinanceProvider();
    const coingecko = new CoinGeckoProvider();
    const symbol = makeSymbol();
    binance.registerSymbol(symbol);
    coingecko.registerSymbol(symbol);
    manager.registerProvider(binance);
    manager.registerProvider(coingecko);
    expect(manager.pickProvider(symbol)?.name).toBe('binance');
  });

  it('falls back to coingecko when binance does not support the symbol', () => {
    const manager = new ProviderManager();
    const binance = new BinanceProvider();
    const coingecko = new CoinGeckoProvider();
    const ethBtc = makeSymbol({ id: 'ETHBTC', providerIds: { binance: 'ETHBTC' } });
    const btc = makeSymbol();
    binance.registerSymbol(ethBtc);
    coingecko.registerSymbol(btc);
    manager.registerProvider(binance);
    manager.registerProvider(coingecko);
    // btc is coingecko-only because we only registered ethBtc with binance
    expect(manager.pickProvider(btc)?.name).toBe('coingecko');
  });

  it('returns undefined when no provider supports the symbol', () => {
    const manager = new ProviderManager();
    manager.registerProvider(new BinanceProvider());
    expect(manager.pickProvider(makeSymbol())).toBeUndefined();
  });

  it('respects an explicit preference ordering', () => {
    const manager = new ProviderManager({ preference: ['coingecko', 'binance'] });
    const binance = new BinanceProvider();
    const coingecko = new CoinGeckoProvider();
    const s = makeSymbol();
    binance.registerSymbol(s);
    coingecko.registerSymbol(s);
    manager.registerProvider(binance);
    manager.registerProvider(coingecko);
    expect(manager.pickProvider(s)?.name).toBe('coingecko');
  });
});

// ---------------------------------------------------------------------------
// Tests: throttling
// ---------------------------------------------------------------------------

describe('ProviderManager throttling', () => {
  it('coalesces bursts to <=10 emissions per second', () => {
    vi.useFakeTimers();
    try {
      const manager = new ProviderManager({ throttleMs: 100 });
      const seen: Candle[] = [];
      const provider: MarketDataProvider = {
        name: 'fake',
        getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
        getHistoricalCandles: async () => [],
        subscribeCandles: (_s, _t, onCandle, onStatus): Unsubscribe => {
          onStatus('connected');
          // Emit 20 updates very quickly, each with a new timestamp.
          let t = 1000;
          for (let i = 0; i < 20; i++) {
            t += 1;
            onCandle(makeCandle(t, 100 + i));
          }
          onStatus('closed');
          return () => undefined;
        },
        subscribeTicker: () => () => undefined,
      };
      manager.registerProvider(provider);
      manager.subscribeCandles(makeSymbol(), '1m', (c) => seen.push(c), () => undefined);
      // First emission goes through immediately (lastEmitTime=0 initial).
      expect(seen.length).toBe(1);
      expect(seen[0]?.close).toBe(100);
      // Advance the throttle window so the coalesced trailing emission fires.
      vi.advanceTimersByTime(200);
      // A burst of 20 must collapse to exactly 2 emissions: one immediate
      // (the first candle) and one trailing (the last candle received).
      expect(seen.length).toBe(2);
      expect(seen[0]?.close).toBe(100);
      expect(seen[seen.length - 1]?.close).toBe(119);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throttle when window has elapsed between emissions', async () => {
    const manager = new ProviderManager({ throttleMs: 10 });
    const seen: number[] = [];
    let emit: ((c: Candle) => void) | null = null;
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, onCandle, onStatus): Unsubscribe => {
        onStatus('connected');
        emit = onCandle;
        return () => undefined;
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    manager.subscribeCandles(makeSymbol(), '1m', (c) => seen.push(c.time), () => undefined);
    expect(emit).not.toBeNull();
    // Three emissions spaced 30ms apart - each should pass through.
    const a = realSetTimeout(() => emit?.(makeCandle(1000)), 0);
    await new Promise((r) => realSetTimeout(r, 30));
    const b = realSetTimeout(() => emit?.(makeCandle(2000)), 0);
    await new Promise((r) => realSetTimeout(r, 30));
    const c = realSetTimeout(() => emit?.(makeCandle(3000)), 0);
    await new Promise((r) => realSetTimeout(r, 30));
    realClearTimeout(a);
    realClearTimeout(b);
    realClearTimeout(c);
    expect(seen).toEqual([1000, 2000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// Tests: Binance reconnection (exponential backoff)
// ---------------------------------------------------------------------------

describe('BinanceProvider reconnection', () => {
  it('reconnects with the documented backoff sequence', async () => {
    vi.useFakeTimers();
    const scheduled: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    // Wrap vitest's setTimeout to record calls.
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms: number, ...rest: unknown[]) => {
      scheduled.push(ms);
      return origSetTimeout.call(globalThis, fn, ms, ...rest) as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const restore = () => {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    };

    try {
      const provider = new BinanceProvider({
        useProxy: false,
        WebSocketCtor: MockWebSocket as unknown as new (url: string) => WebSocket,
        sleepFn: async () => undefined,
      });
      const symbol = makeSymbol();
      provider.registerSymbol(symbol);
      const statuses: ConnectionStatus[] = [];
      const unsub = provider.subscribeCandles(symbol, '1m', () => undefined, (s) => statuses.push(s));

      // Flush the queueMicrotask that creates the WebSocket.
      await Promise.resolve();
      await Promise.resolve();

      // First socket -> open
      const ws1 = MockWebSocket.instances[0]!;
      expect(ws1).toBeDefined();
      ws1.fireOpen();
      expect(statuses).toContain('connected');

      // Force a close to trigger reconnect.
      ws1.fireClose();
      // The first reconnect timer should be ~1000ms (with jitter ±20%).
      const reconnectCall = scheduled.find((ms) => ms >= 800 && ms <= 1200);
      expect(reconnectCall).toBeDefined();

      unsub();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('exposes the documented backoff sequence', () => {
    expect(BACKOFF_SEQUENCE_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it('reports error when symbol is not supported by the provider', () => {
    const provider = new BinanceProvider();
    const statuses: ConnectionStatus[] = [];
    const unsub = provider.subscribeCandles(
      makeSymbol({ providerIds: {} }), // no binance id
      '1m',
      () => undefined,
      (s) => statuses.push(s),
    );
    // Use a microtask to allow the queued error to fire.
    return new Promise<void>((resolve) => {
      realSetTimeout(() => {
        expect(statuses).toContain('error');
        unsub();
        resolve();
      }, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: getHistoricalCandles error path (no throw)
// ---------------------------------------------------------------------------

describe('ProviderManager getHistoricalCandles', () => {
  it('returns [] when no provider matches', async () => {
    const manager = new ProviderManager();
    const out = await manager.getHistoricalCandles(makeSymbol(), '1m', 100);
    expect(out).toEqual([]);
  });

  it('returns [] when the provider throws', async () => {
    const manager = new ProviderManager();
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => {
        throw new Error('boom');
      },
      subscribeCandles: () => () => undefined,
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    const out = await manager.getHistoricalCandles(makeSymbol(), '1m', 100);
    expect(out).toEqual([]);
  });

  it('sanitizes provider output (drops candles with NaN)', async () => {
    const manager = new ProviderManager();
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [
        { time: 1000, open: 1, high: 2, low: 1, close: 1, volume: 1 },
        { time: 2000, open: NaN as unknown as number, high: 2, low: 1, close: 1, volume: 1 },
        { time: 3000, open: 1, high: 2, low: 1, close: 1, volume: 1 },
      ],
      subscribeCandles: () => () => undefined,
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    const out = await manager.getHistoricalCandles(makeSymbol(), '1m', 100);
    expect(out.map((c) => c.time)).toEqual([1000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// Tests: independent subscriptions
// ---------------------------------------------------------------------------

describe('ProviderManager independent subscriptions', () => {
  it('closing one subscription does not affect another', () => {
    const manager = new ProviderManager({ throttleMs: 0 });
    const aStatuses: ConnectionStatus[] = [];
    const bStatuses: ConnectionStatus[] = [];
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, _onCandle, onStatus): Unsubscribe => {
        onStatus('connected');
        return () => {
          onStatus('closed');
        };
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);

    const unsubA = manager.subscribeCandles(makeSymbol(), '1m', () => undefined, (s) => aStatuses.push(s));
    const unsubB = manager.subscribeCandles(makeSymbol(), '5m', () => undefined, (s) => bStatuses.push(s));

    unsubA();
    // Subscription A receives 'closed'; subscription B is untouched.
    expect(aStatuses).toEqual(['connected', 'closed']);
    expect(bStatuses).toEqual(['connected']);

    unsubB();
    expect(bStatuses).toEqual(['connected', 'closed']);
  });
});

// ---------------------------------------------------------------------------
// Tests: ticker passthrough
// ---------------------------------------------------------------------------

describe('ProviderManager subscribeTicker', () => {
  it('forwards ticker updates from the provider', () => {
    const manager = new ProviderManager();
    const seen: TickerData[] = [];
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: () => () => undefined,
      subscribeTicker: (_s, onTicker, onStatus): Unsubscribe => {
        onStatus('connected');
        onTicker({
          symbol: 'BTC/USD',
          price: 50000,
          change24h: 1000,
          changePercent24h: 2,
          high24h: 51000,
          low24h: 49000,
          volume24h: 1234,
          timestamp: 1700000000,
        });
        return () => undefined;
      },
    };
    manager.registerProvider(provider);
    manager.subscribeTicker(makeSymbol(), (t) => seen.push(t), () => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.price).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Tests: CoinGecko aggregation
// ---------------------------------------------------------------------------

describe('CoinGeckoProvider historical aggregation', () => {
  it('aggregates tick data into 1h candles and respects endTime + limit', async () => {
    // Build a deterministic fetch stub.
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/coins/bitcoin/market_chart');
      const start = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 00:00 UTC
      const prices: [number, number][] = [];
      const total_volumes: [number, number][] = [];
      // 240 hours of hourly ticks
      for (let i = 0; i < 240; i++) {
        prices.push([start + i * 3600_000, 100 + i]);
        total_volumes.push([start + i * 3600_000, 10 + i]);
      }
      return new Response(JSON.stringify({ prices, market_caps: [], total_volumes }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new CoinGeckoProvider({ useProxy: true, fetchImpl: fetchMock as unknown as typeof fetch, pollIntervalMs: 0 });
    provider.registerSymbol(makeSymbol());
    const candles = await provider.getHistoricalCandles(makeSymbol(), '1h', 10);
    // Should be sorted ascending, exactly 10 candles, and the last 10 of 240.
    expect(candles.length).toBe(10);
    expect(candles[0]?.time).toBeLessThan(candles[candles.length - 1]!.time);
    // Each candle should be a 1h bucket (3600s wide).
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i]!.time - candles[i - 1]!.time).toBe(3600);
    }
  });

  it('returns [] when fetch fails (no throw)', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 500 }));
    const provider = new CoinGeckoProvider({ useProxy: true, fetchImpl: fetchMock as unknown as typeof fetch, pollIntervalMs: 0 });
    provider.registerSymbol(makeSymbol());
    const out = await provider.getHistoricalCandles(makeSymbol(), '1h', 10);
    expect(out).toEqual([]);
  });

  it('returns [] for unsupported symbols', async () => {
    const provider = new CoinGeckoProvider({ useProxy: true, pollIntervalMs: 0 });
    const out = await provider.getHistoricalCandles(
      makeSymbol({ providerIds: { binance: 'BTCUSDT' } }), // no coingecko id
      '1h',
      10,
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: Binance REST via mocked fetch
// ---------------------------------------------------------------------------

describe('BinanceProvider getHistoricalCandles', () => {
  it('parses kline arrays into candles', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v3/klines');
      // Two candles
      const data = [
        [1700000000000, '100', '110', '90', '105', '1000', 0, 0, 0, 0, 0, 0],
        [1700003600000, '105', '115', '100', '110', '500', 0, 0, 0, 0, 0, 0],
      ];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new BinanceProvider({ useProxy: false, fetchImpl: fetchMock as unknown as typeof fetch });
    provider.registerSymbol(makeSymbol());
    const out = await provider.getHistoricalCandles(makeSymbol(), '1h', 2);
    expect(out.length).toBe(2);
    expect(out[0]?.time).toBe(1700000000);
    expect(out[1]?.close).toBe(110);
  });

  it('returns [] when fetch fails (no throw)', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    const provider = new BinanceProvider({ useProxy: false, fetchImpl: fetchMock as unknown as typeof fetch });
    provider.registerSymbol(makeSymbol());
    const out = await provider.getHistoricalCandles(makeSymbol(), '1h', 2);
    expect(out).toEqual([]);
  });

  it('returns [] for unsupported symbols', async () => {
    const provider = new BinanceProvider({ useProxy: false });
    const out = await provider.getHistoricalCandles(
      makeSymbol({ providerIds: { coingecko: 'bitcoin' } }),
      '1h',
      2,
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: subscription callbacks (smoke)
// ---------------------------------------------------------------------------

describe('ProviderManager subscribeCandles', () => {
  it('passes through status updates from the provider', () => {
    const manager = new ProviderManager({ throttleMs: 0 });
    const statuses: ConnectionStatus[] = [];
    const provider: MarketDataProvider = {
      name: 'fake',
      getSymbolInfo: (id) => (id === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, _onCandle, onStatus): Unsubscribe => {
        onStatus('connecting');
        onStatus('connected');
        onStatus('closed');
        return () => undefined;
      },
      subscribeTicker: () => () => undefined,
    };
    manager.registerProvider(provider);
    manager.subscribeCandles(makeSymbol(), '1m', () => undefined, (s) => statuses.push(s));
    expect(statuses).toEqual(['connecting', 'connected', 'closed']);
  });
});

// Avoid unused-import warnings for the Candle/StatusCallback aliases.
void (null as unknown as CandleCallback);
void (null as unknown as StatusCallback);
