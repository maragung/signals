import { describe, expect, it } from 'vitest';
import {
  synthesizeHeatmap,
  buildHeatmapFromEvents,
  applyLiquidationEvent,
  fetchFuturesSnapshot,
  fetchRecentForceOrders,
  fetchHeatmapSnapshot,
  isRegionBlockedStatus,
} from './liquidation-heatmap';
import type { FuturesSnapshot, LiquidationEvent } from '@/types';

function makeSnapshot(over: Partial<FuturesSnapshot> = {}): FuturesSnapshot {
  return {
    symbol: 'BTCUSDT',
    markPrice: 50000,
    indexPrice: 50010,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    openInterest: 100000,
    openInterestUsd: 5_000_000_000,
    longShortRatio: 1.0,
    takerBuySellRatio: 1.0,
    ts: Date.now(),
    ...over,
  };
}

describe('synthesizeHeatmap', () => {
  it('returns empty heatmap for invalid snapshot', () => {
    const h = synthesizeHeatmap(makeSnapshot({ markPrice: 0 }), { symbol: 'BTCUSDT' });
    expect(h.levels).toEqual([]);
    expect(h.totalLongLiq).toBe(0);
    expect(h.totalShortLiq).toBe(0);
    expect(h.source).toBe('synthetic');
  });

  it('produces symmetric levels around mark with OI split by L/S ratio', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000, longShortRatio: 1.0 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    expect(h.levels.length).toBeGreaterThan(0);
    // totalLongLiq and totalShortLiq should sum to a fraction of OI
    // (we don't include the entire OI; we distribute across leverage buckets)
    expect(h.totalLongLiq + h.totalShortLiq).toBeGreaterThan(0);
    expect(h.totalLongLiq + h.totalShortLiq).toBeLessThanOrEqual(1_000_000_000);
    // mark price should be in the middle of the ladder
    const mid = h.levels[Math.floor(h.levels.length / 2)]!.price;
    expect(Math.abs(mid - 100_000)).toBeLessThan(2000);
  });

  it('skews long liquidation mass when L/S > 1', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000, longShortRatio: 3.0 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    expect(h.totalLongLiq).toBeGreaterThan(h.totalShortLiq);
  });

  it('skews short liquidation mass when L/S < 1', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000, longShortRatio: 0.3 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    expect(h.totalShortLiq).toBeGreaterThan(h.totalLongLiq);
  });

  it('applies funding rate bias directionally', () => {
    const pos = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000, longShortRatio: 1.0, fundingRate: 0.001 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    const neg = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000, longShortRatio: 1.0, fundingRate: -0.001 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    // Positive funding boosts short side (squeeze shorts)
    expect(pos.totalShortLiq).toBeGreaterThan(neg.totalShortLiq);
    expect(neg.totalLongLiq).toBeGreaterThan(pos.totalLongLiq);
  });

  it('handles NaN and zero gracefully', () => {
    const h1 = synthesizeHeatmap(
      makeSnapshot({ markPrice: NaN as unknown as number }),
      { symbol: 'BTCUSDT' },
    );
    expect(h1.levels).toEqual([]);
    const h2 = synthesizeHeatmap(
      makeSnapshot({ markPrice: 100, openInterestUsd: 0 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    expect(h2.totalLongLiq).toBe(0);
    expect(h2.totalShortLiq).toBe(0);
  });

  it('contains the snapshot meta in the result', () => {
    const snap = makeSnapshot({ markPrice: 100_000 });
    const h = synthesizeHeatmap(snap, { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 });
    expect(h.meta.markPrice).toBe(100_000);
    expect(h.meta.openInterestUsd).toBe(snap.openInterestUsd);
    expect(h.meta.fundingRate).toBe(snap.fundingRate);
  });
});

describe('buildHeatmapFromEvents', () => {
  it('aggregates events into nearest ladder level', () => {
    const events: LiquidationEvent[] = [
      { time: 1, symbol: 'BTCUSDT', side: 'long', price: 99000, quantity: 0.5, notional: 49500 },
      { time: 2, symbol: 'BTCUSDT', side: 'short', price: 101000, quantity: 0.4, notional: 40400 },
    ];
    const h = buildHeatmapFromEvents(events, 'BTCUSDT', {
      symbol: 'BTCUSDT',
      stepPct: 1,
      rangePct: 5,
    });
    expect(h.source).toBe('live');
    expect(h.totalLongLiq).toBeGreaterThan(0);
    expect(h.totalShortLiq).toBeGreaterThan(0);
    expect(h.recentEvents).toEqual(events);
  });

  it('returns empty heatmap when no events', () => {
    const h = buildHeatmapFromEvents([], 'BTCUSDT', { symbol: 'BTCUSDT' });
    expect(h.levels).toEqual([]);
    expect(h.recentEvents).toEqual([]);
  });
});

describe('applyLiquidationEvent', () => {
  it('adds long notional to nearest level', () => {
    const snap = makeSnapshot({ markPrice: 100_000, openInterestUsd: 1_000_000_000 });
    const base = synthesizeHeatmap(snap, { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 });
    const before = base.totalLongLiq;
    const ev: LiquidationEvent = {
      time: Date.now(),
      symbol: 'BTCUSDT',
      side: 'long',
      price: 99000,
      quantity: 0.1,
      notional: 9900,
    };
    const next = applyLiquidationEvent(base, ev);
    expect(next.totalLongLiq).toBeGreaterThan(before);
    expect(next.recentEvents[0]).toEqual(ev);
    expect(next.source).toBe('live');
  });
});

describe('fetchFuturesSnapshot', () => {
  it('parses mocked API responses', async () => {
    const fetchMock = (url: string) => {
      if (url.includes('premiumIndex')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              symbol: 'BTCUSDT',
              markPrice: '50000.00',
              indexPrice: '50010.00',
              lastFundingRate: '0.0001',
              nextFundingTime: 1234567890,
            }),
        });
      }
      if (url.includes('openInterestHist')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve([{ sumOpenInterest: '100000', sumOpenInterestValue: '5000000000' }]),
        });
      }
      if (url.includes('globalLongShortAccountRatio')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ longShortRatio: '1.2' }]),
        });
      }
      if (url.includes('takerlongshortRatio')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ buySellRatio: '0.95' }]),
        });
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    };
    const result = await fetchFuturesSnapshot('BTCUSDT', fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.markPrice).toBe(50000);
    expect(result.snapshot!.openInterestUsd).toBe(5_000_000_000);
    expect(result.snapshot!.longShortRatio).toBe(1.2);
    expect(result.snapshot!.takerBuySellRatio).toBe(0.95);
  });

  it('returns null snapshot on failure', async () => {
    const fetchMock = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    const result = await fetchFuturesSnapshot('BTCUSDT', fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.snapshot).toBeNull();
  });

  it('detects region block (HTTP 451) and returns blocked=true', async () => {
    const fetchMock = () =>
      Promise.resolve({ ok: false, status: 451, json: () => Promise.resolve({ error: 'region' }) });
    const result = await fetchFuturesSnapshot('BTCUSDT', fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(true);
    expect(result.snapshot).toBeNull();
  });
});

describe('fetchRecentForceOrders', () => {
  it('parses mocked force-order response', async () => {
    const fetchMock = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            {
              symbol: 'BTCUSDT',
              side: 'SELL',
              time: 1234567890000,
              price: '50000',
              executedQty: '0.5',
              avgPrice: '50000',
            },
          ]),
      });
    const result = await fetchRecentForceOrders('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.side).toBe('long');
    expect(result.events[0]!.price).toBe(50000);
    expect(result.events[0]!.quantity).toBe(0.5);
    expect(result.events[0]!.notional).toBe(25000);
  });

  it('returns empty events on error', async () => {
    const fetchMock = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    const result = await fetchRecentForceOrders('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('detects region block (HTTP 451)', async () => {
    const fetchMock = () =>
      Promise.resolve({ ok: false, status: 451, json: () => Promise.resolve({ error: 'region' }) });
    const result = await fetchRecentForceOrders('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(true);
    expect(result.events).toEqual([]);
  });
});

describe('fetchHeatmapSnapshot', () => {
  it('bundles snapshot + events + blocked flag (Binance happy path)', async () => {
    const fetchMock = (url: string) => {
      if (url.includes('allForceOrders')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      if (url.includes('premiumIndex')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ markPrice: '50000', lastFundingRate: '0.0001' }),
        });
      }
      if (url.includes('openInterestHist')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ sumOpenInterest: '1', sumOpenInterestValue: '1' }]),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    const result = await fetchHeatmapSnapshot('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.markPrice).toBe(50000);
  });

  it('falls through to OKX when Binance returns 451', async () => {
    const fetchMock = (url: string) => {
      // All Binance endpoints (fapi) -> 451.
      if (url.includes('/api/futures/') || url.includes('fapi.binance.com') || url.includes('dapi.binance.com')) {
        return Promise.resolve({ ok: false, status: 451, json: () => Promise.resolve({ error: 'region' }) });
      }
      // OKX endpoints (last trade) return a valid ticker.
      if (url.includes('/api/okx/market/ticker')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              code: '0',
              data: [{ instId: 'BTC-USDT-SWAP', last: '50000', volCcy24h: '1000000' }],
            }),
        });
      }
      if (url.includes('/api/okx/market/open-interest')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              code: '0',
              data: [{ instId: 'BTC-USDT-SWAP', oi: '1000', oiCcy: '1000' }],
            }),
        });
      }
      if (url.includes('/api/okx/public/funding-rate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ code: '0', data: [{ fundingRate: '0.0001', nextFundingTime: '1700000000000' }] }),
        });
      }
      if (url.includes('/api/okx/rubik')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ code: '0', data: [{ longShortRatio: '1.2' }] }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    const result = await fetchHeatmapSnapshot('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(false);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.markPrice).toBe(50000);
  });

  it('returns blocked=true when ALL providers are blocked', async () => {
    const fetchMock = () =>
      Promise.resolve({ ok: false, status: 451, json: () => Promise.resolve({ error: 'region' }) });
    const result = await fetchHeatmapSnapshot('BTCUSDT', 24, fetchMock as unknown as typeof fetch);
    expect(result.blocked).toBe(true);
    expect(result.snapshot).toBeNull();
    expect(result.events).toEqual([]);
  });
});

describe('isRegionBlockedStatus', () => {
  it('returns true for 451 / 403 / 407', () => {
    expect(isRegionBlockedStatus(451)).toBe(true);
    expect(isRegionBlockedStatus(403)).toBe(true);
    expect(isRegionBlockedStatus(407)).toBe(true);
  });
  it('returns false for 200, 404, 500, 429', () => {
    expect(isRegionBlockedStatus(200)).toBe(false);
    expect(isRegionBlockedStatus(404)).toBe(false);
    expect(isRegionBlockedStatus(500)).toBe(false);
    expect(isRegionBlockedStatus(429)).toBe(false);
  });
});
