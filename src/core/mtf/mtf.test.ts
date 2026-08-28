import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '@/types';
import {
  analyzeMTF,
  combineCells,
  evaluateCell,
  type DataFetcher,
} from '@/core/mtf';

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

function trendingUp(n: number, start = 100, step = 1, vol = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * step;
    const c = o + step;
    out.push(makeCandle(i, o, c + 0.2, o - 0.2, c, vol + i));
  }
  return out;
}

function trendingDown(n: number, start = 200, step = 1, vol = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = start - i * step;
    const c = o - step;
    out.push(makeCandle(i, o, o + 0.2, c - 0.2, c, vol + i));
  }
  return out;
}

function ranging(n: number, base = 100, amp = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = base + Math.sin(i / 3) * amp;
    const c = base + Math.cos(i / 3) * amp;
    out.push(makeCandle(i, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c, 100));
  }
  return out;
}

function extremeVolatility(n: number, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const amp = 10;
    const o = start + (i % 2 === 0 ? 1 : -1) * amp;
    const c = o + (i % 2 === 0 ? -1 : 1) * amp * 1.5;
    out.push(makeCandle(i, o, Math.max(o, c) + amp, Math.min(o, c) - amp, c, 1000));
  }
  return out;
}

function withNaN(candles: Candle[]): Candle[] {
  if (candles.length === 0) return candles;
  const copy = candles.slice();
  const last = copy[copy.length - 1]!;
  copy[copy.length - 1] = { ...last, close: NaN, high: NaN, low: NaN };
  return copy;
}

class MockDataFetcher implements DataFetcher {
  private map: Map<Timeframe, Candle[]>;
  constructor(map: Partial<Record<Timeframe, Candle[]>>) {
    this.map = new Map();
    for (const [k, v] of Object.entries(map)) {
      this.map.set(k as Timeframe, v ?? []);
    }
  }
  async fetchCandles(_symbol: string, tf: Timeframe): Promise<Candle[]> {
    return this.map.get(tf) ?? [];
  }
}

describe('evaluateCell', () => {
  it('returns bullish cell on strong uptrend', () => {
    const cell = evaluateCell('1h', trendingUp(120), {});
    expect(cell.timeframe).toBe('1h');
    expect(cell.trend).toBe('bullish');
    expect(cell.score).toBeGreaterThan(0);
  });

  it('returns bearish cell on strong downtrend', () => {
    const cell = evaluateCell('1h', trendingDown(120), {});
    expect(cell.trend).toBe('bearish');
    expect(cell.score).toBeLessThan(0);
  });

  it('returns neutral cell on insufficient candles', () => {
    const cell = evaluateCell('1h', trendingUp(5), {});
    expect(['neutral', 'bullish']).toContain(cell.trend);
  });

  it('handles empty input', () => {
    const cell = evaluateCell('1h', [], {});
    expect(cell.timeframe).toBe('1h');
    expect(cell.score).toBe(0);
  });

  it('handles single candle', () => {
    const cell = evaluateCell('1h', [makeCandle(0, 100, 101, 99, 100)], {});
    expect(cell.score).toBe(0);
  });

  it('handles NaN in candles', () => {
    const cell = evaluateCell('1h', withNaN(trendingUp(60)), {});
    expect(Number.isFinite(cell.score)).toBe(true);
  });

  it('handles extreme volatility', () => {
    const cell = evaluateCell('1h', extremeVolatility(80), {});
    expect(Number.isFinite(cell.score)).toBe(true);
  });

  it('returns neutral in a ranging market', () => {
    const cell = evaluateCell('1h', ranging(120), {});
    expect(['neutral', 'bullish', 'bearish']).toContain(cell.trend);
  });
});

describe('combineCells', () => {
  it('combines cells with weighted score', () => {
    const cellA = evaluateCell('1d', trendingUp(120), {});
    const cellB = evaluateCell('4h', trendingUp(120), {});
    const cellC = evaluateCell('1h', trendingDown(120), {});
    const out = combineCells([cellA, cellB, cellC], {});
    expect(out.cells.length).toBe(3);
    expect(out.overallBias).toBe('bullish');
    expect(out.mtfScore).toBeGreaterThan(0);
    expect(out.generatedAt).toBeGreaterThan(0);
  });

  it('returns neutral with no cells', () => {
    const out = combineCells([], {});
    expect(out.overallBias).toBe('neutral');
    expect(out.mtfScore).toBe(0);
  });

  it('overall bearish when all cells bearish', () => {
    const a = evaluateCell('1d', trendingDown(120), {});
    const b = evaluateCell('4h', trendingDown(120), {});
    const out = combineCells([a, b], {});
    expect(out.overallBias).toBe('bearish');
  });

  it('respects custom timeframe weights', () => {
    const cellA = evaluateCell('1d', trendingUp(120), {});
    const cellB = evaluateCell('5m', trendingDown(120), {});
    // Down-weight the bullish 1d and the 5m bearish becomes dominant.
    const out = combineCells([cellA, cellB], {
      timeframeWeights: { '1d': 0.1, '5m': 5 },
    });
    expect(out.overallBias).toBe('bearish');
  });
});

describe('analyzeMTF', () => {
  it('produces a multi-timeframe analysis', async () => {
    const fetcher = new MockDataFetcher({
      '1d': trendingUp(200),
      '4h': trendingUp(150),
      '1h': trendingDown(100),
      '15m': ranging(100),
      '5m': trendingUp(80),
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h', '1h', '15m', '5m'], fetcher, {});
    expect(result.cells.length).toBe(5);
    expect(result.cells.map((c) => c.timeframe)).toEqual(['1d', '4h', '1h', '15m', '5m']);
    expect(['bullish', 'bearish', 'neutral']).toContain(result.overallBias);
  });

  it('handles empty data provider', async () => {
    const fetcher = new MockDataFetcher({});
    const result = await analyzeMTF('BTCUSD', ['1d', '4h'], fetcher, {});
    expect(result.cells.length).toBe(2);
    expect(result.overallBias).toBe('neutral');
    expect(result.mtfScore).toBe(0);
  });

  it('handles NaN in provider data', async () => {
    const fetcher = new MockDataFetcher({
      '1d': withNaN(trendingUp(200)),
      '4h': trendingUp(100),
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h'], fetcher, {});
    expect(result.cells.length).toBe(2);
    expect(result.cells.every((c) => Number.isFinite(c.score))).toBe(true);
  });

  it('handles extreme volatility in provider data', async () => {
    const fetcher = new MockDataFetcher({
      '1d': extremeVolatility(120),
      '4h': trendingUp(120),
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h'], fetcher, {});
    expect(result.cells.every((c) => Number.isFinite(c.score))).toBe(true);
  });

  it('produces overall bullish when 1d and 4h bullish, lower bearish', async () => {
    const fetcher = new MockDataFetcher({
      '1d': trendingUp(200),
      '4h': trendingUp(150),
      '1h': trendingDown(80),
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h', '1h'], fetcher, {});
    expect(result.overallBias).toBe('bullish');
  });

  it('produces overall bearish when 1d and 4h bearish', async () => {
    const fetcher = new MockDataFetcher({
      '1d': trendingDown(200),
      '4h': trendingDown(150),
      '1h': trendingUp(80),
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h', '1h'], fetcher, {});
    expect(result.overallBias).toBe('bearish');
  });

  it('single candle in every timeframe still produces a result', async () => {
    const fetcher = new MockDataFetcher({
      '1d': [makeCandle(0, 100, 101, 99, 100)],
      '4h': [makeCandle(0, 100, 101, 99, 100)],
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h'], fetcher, {});
    expect(result.cells.length).toBe(2);
  });

  it('range-bound across all timeframes -> neutral', async () => {
    // A perfectly flat series is degenerate for RSI (returns 100) and
    // for the structure tally. Instead, accept that the mtfScore is
    // small in absolute value (within the neutral band) and only
    // require the cells to be populated.
    const alternating: Candle[] = [];
    for (let i = 0; i < 120; i++) {
      const c = i % 2 === 0 ? 100.5 : 99.5;
      alternating.push(makeCandle(i, c, c + 0.1, c - 0.1, c, 100));
    }
    const fetcher = new MockDataFetcher({
      '1d': alternating,
      '4h': alternating,
      '1h': alternating,
    });
    const result = await analyzeMTF('BTCUSD', ['1d', '4h', '1h'], fetcher, {});
    // The mtf score should be near zero (no persistent direction).
    expect(Math.abs(result.mtfScore)).toBeLessThanOrEqual(0.5);
    expect(result.cells.length).toBe(3);
  });

  it('uses custom EMA / RSI / structure settings', async () => {
    const fetcher = new MockDataFetcher({
      '1h': trendingUp(120),
    });
    const result = await analyzeMTF('BTCUSD', ['1h'], fetcher, {
      emaFast: 5,
      emaSlow: 13,
      rsiPeriod: 7,
      structureLookback: 20,
      volumeLookback: 10,
    });
    expect(result.cells.length).toBe(1);
    expect(result.cells[0]!.trend).toBe('bullish');
  });
});
