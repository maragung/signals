// Failover tests for the ProviderManager.
//
// These prove that, when the preferred provider is geo-blocked (HTTP 451) or
// errors, the manager transparently falls through to the next provider — for
// both historical candles (REST) and live subscriptions (WS status).

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, Candle, SymbolInfo } from '@/types';
import { BinanceProvider } from './binance';
import { BybitProvider } from './bybit';
import { OkxProvider } from './okx';
import { GateProvider } from './gate';
import { BitgetProvider } from './bitget';
import { ProviderManager } from './manager';
import type { CandleCallback, MarketDataProvider, StatusCallback, TickerCallback, Unsubscribe } from './types';

function makeSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    id: 'BTCUSD',
    display: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    category: 'crypto',
    providerIds: { binance: 'BTCUSDT', bybit: 'BTCUSDT' },
    pricePrecision: 2,
    volumePrecision: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Historical (REST) failover
// ---------------------------------------------------------------------------

describe('ProviderManager getHistoricalCandles failover', () => {
  it('falls through to the next provider when Binance returns 451', async () => {
    const binanceFetch = vi.fn(async () => new Response('blocked', { status: 451 }));
    const bybitFetch = vi.fn(async (url: string) => {
      expect(url).toContain('/v5/market/kline');
      const list = [
        [1700000000000, '100', '110', '90', '105', '10'],
        [1700003600000, '105', '115', '100', '110', '5'],
      ];
      return new Response(JSON.stringify({ result: { list } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const binance = new BinanceProvider({ useProxy: false, fetchImpl: binanceFetch as unknown as typeof fetch });
    const bybit = new BybitProvider({ useProxy: false, fetchImpl: bybitFetch as unknown as typeof fetch });
    const symbol = makeSymbol();

    for (const p of [binance, bybit]) p.registerSymbol(symbol);

    const manager = new ProviderManager({ preference: ['binance', 'bybit'] });
    manager.registerProvider(binance);
    manager.registerProvider(bybit);

    const out = await manager.getHistoricalCandles(symbol, '1h', 10);

    // Binance must have been attempted (and blocked) before Bybit won.
    expect(binanceFetch).toHaveBeenCalled();
    expect(out.length).toBe(2);
    expect(out[0]?.close).toBe(105);
  });

  it('returns [] only when every provider is blocked', async () => {
    const blocked = vi.fn(async () => new Response('nope', { status: 451 }));
    const binance = new BinanceProvider({ useProxy: false, fetchImpl: blocked as unknown as typeof fetch });
    const bybit = new BybitProvider({ useProxy: false, fetchImpl: blocked as unknown as typeof fetch });
    const symbol = makeSymbol();
    for (const p of [binance, bybit]) p.registerSymbol(symbol);

    const manager = new ProviderManager({ preference: ['binance', 'bybit'] });
    manager.registerProvider(binance);
    manager.registerProvider(bybit);

    const out = await manager.getHistoricalCandles(symbol, '1h', 10);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WS subscription failover
// ---------------------------------------------------------------------------

describe('ProviderManager subscription failover', () => {
  it('switches to the next provider when the first emits error', () => {
    const manager = new ProviderManager({ preference: ['a', 'b'] });
    const statuses: ConnectionStatus[] = [];
    const used: string[] = [];

    const makeFake = (id: string, fail: boolean): MarketDataProvider => ({
      name: id,
      getSymbolInfo: (s) => (s === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, _onCandle: CandleCallback, onStatus: StatusCallback): Unsubscribe => {
        used.push(id);
        onStatus('connecting');
        if (fail) {
          onStatus('error');
        } else {
          onStatus('connected');
        }
        return () => undefined;
      },
      subscribeTicker: (_s, _onTicker: TickerCallback, _onStatus: StatusCallback): Unsubscribe => () => undefined,
    });

    manager.registerProvider(makeFake('a', true));
    manager.registerProvider(makeFake('b', false));

    const unsub = manager.subscribeCandles(makeSymbol(), '1m', () => undefined, (s) => statuses.push(s));
    unsub();

    // The first provider failed; the manager transparently switched to 'b'
    // which connected. The consumer must see a successful connection.
    expect(used).toEqual(['a', 'b']);
    expect(statuses).toContain('connected');
  });

  it('reports error to the consumer only after the last provider fails', () => {
    const manager = new ProviderManager({ preference: ['a', 'b'] });
    const statuses: ConnectionStatus[] = [];

    const makeFake = (id: string): MarketDataProvider => ({
      name: id,
      getSymbolInfo: (s) => (s === 'BTCUSD' ? makeSymbol() : undefined),
      getHistoricalCandles: async () => [],
      subscribeCandles: (_s, _t, _onCandle: CandleCallback, onStatus: StatusCallback): Unsubscribe => {
        onStatus('connecting');
        onStatus('error');
        return () => undefined;
      },
      subscribeTicker: (_s, _onTicker: TickerCallback, _onStatus: StatusCallback): Unsubscribe => () => undefined,
    });

    manager.registerProvider(makeFake('a'));
    manager.registerProvider(makeFake('b'));

    const unsub = manager.subscribeCandles(makeSymbol(), '1m', () => undefined, (s) => statuses.push(s));
    unsub();

    // Both failed; the consumer should be told the whole chain failed.
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('connected');
  });
});

// ---------------------------------------------------------------------------
// New provider REST parsing
// ---------------------------------------------------------------------------

describe('New provider getHistoricalCandles parsing', () => {
  const symbol = makeSymbol({ providerIds: { bybit: 'BTCUSDT', okx: 'BTC-USDT', gate: 'BTC_USDT', bitget: 'BTCUSDT' } });

  it('Bybit: result.list rows [tsMs,o,h,l,c,vol]', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: { list: [
      [1700000000000, '100', '110', '90', '105', '10'],
      [1700003600000, '105', '115', '100', '110', '5'],
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const p = new BybitProvider({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    p.registerSymbol(symbol);
    const out = await p.getHistoricalCandles(symbol, '1h', 10);
    expect(out.map((c) => c.close)).toEqual([105, 110]);
    expect(out[0]?.time).toBe(1700000000);
  });

  it('OKX: data rows newest-first [tsMs,o,h,l,c,vol]', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      [1700003600000, '105', '115', '100', '110', '5'],
      [1700000000000, '100', '110', '90', '105', '10'],
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const p = new OkxProvider({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    p.registerSymbol(symbol);
    const out = await p.getHistoricalCandles(symbol, '1h', 10);
    expect(out.map((c) => c.close)).toEqual([105, 110]); // reversed to ascending
  });

  it('Gate: array rows [tsSec,vol,close,high,low,open]', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      [1700000000, '10', '105', '110', '90', '100'],
      [1700003600, '5', '110', '115', '100', '105'],
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const p = new GateProvider({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    p.registerSymbol(symbol);
    const out = await p.getHistoricalCandles(symbol, '1h', 10);
    expect(out.map((c) => c.close)).toEqual([105, 110]);
    expect(out[0]?.open).toBe(100);
  });

  it('Bitget: data rows newest-first [tsMs,o,h,l,c,vol]', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      [1700003600000, '105', '115', '100', '110', '5'],
      [1700000000000, '100', '110', '90', '105', '10'],
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const p = new BitgetProvider({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    p.registerSymbol(symbol);
    const out = await p.getHistoricalCandles(symbol, '1h', 10);
    expect(out.map((c) => c.close)).toEqual([105, 110]);
  });

  it('Bitget: 3m unsupported -> aggregup from 1m', async () => {
    // 6 aligned 1m candles (start = 1699999920, a multiple of 180s) aggregate
    // into 2 three-minute candles.
    const base = 1699999920;
    const rows = [0, 1, 2, 3, 4, 5].map((i) => [base * 1000 + i * 60000, '10', '11', '9', String(100 + i), '1']);
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('granularity=1m');
      return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const p = new BitgetProvider({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    p.registerSymbol(symbol);
    const out = await p.getHistoricalCandles(symbol, '3m', 10);
    expect(out.length).toBe(2);
  });

  it('returns [] (no throw) when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    for (const P of [BybitProvider, OkxProvider, GateProvider, BitgetProvider]) {
      const p = new P({ useProxy: false, fetchImpl: fetchImpl as unknown as typeof fetch });
      p.registerSymbol(symbol);
      const out = await p.getHistoricalCandles(symbol, '1h', 10);
      expect(out).toEqual([]);
    }
  });
});

