import { describe, expect, it } from 'vitest';
import type { Candle, FibConfig } from '@/types';
import {
  autoFibonacci,
  extensionLevels,
  findRecentSwings,
  manualFibonacci,
  retracementLevels,
} from '@/core/fibonacci';

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

function trendingUp(n: number, start = 100, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * step;
    const c = o + step;
    out.push(makeCandle(i, o, c + 0.2, o - 0.2, c, 100 + i));
  }
  return out;
}

function trendingDown(n: number, start = 200, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = start - i * step;
    const c = o - step;
    out.push(makeCandle(i, o, o + 0.2, c - 0.2, c, 100 + i));
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

const config: FibConfig = {
  retracements: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  extensions: [1, 1.272, 1.618, 2, 2.618],
  auto: true,
};

describe('retracementLevels', () => {
  it('returns a level for every ratio', () => {
    const levels = retracementLevels(200, 100, [0, 0.5, 1]);
    expect(levels.length).toBe(3);
    expect(levels[0]!.price).toBe(200); // 0 -> high
    expect(levels[2]!.price).toBe(100); // 1 -> low
  });
  it('handles negative or out-of-range ratios', () => {
    const levels = retracementLevels(100, 100, [0, 0.5, 1]);
    expect(levels.every((l) => l.price === 100)).toBe(true);
  });
  it('handles NaN inputs', () => {
    expect(retracementLevels(NaN, 100, [0.5])).toEqual([]);
    expect(retracementLevels(100, NaN, [0.5])).toEqual([]);
  });
});

describe('extensionLevels', () => {
  it('produces upward extensions from a higher p2', () => {
    const levels = extensionLevels(100, 200, [0.5, 1, 1.618], 'up');
    expect(levels.length).toBe(3);
    // p2 + (p2 - p1) * ratio
    expect(levels[0]!.price).toBeCloseTo(250, 6);
    expect(levels[1]!.price).toBeCloseTo(300, 6);
    expect(levels[2]!.price).toBeCloseTo(361.8, 5);
  });
  it('produces downward extensions from a lower p2', () => {
    const levels = extensionLevels(200, 100, [0.5, 1, 1.618], 'down');
    expect(levels.length).toBe(3);
    expect(levels[0]!.price).toBeCloseTo(50, 6);
    expect(levels[1]!.price).toBeCloseTo(0, 6);
    expect(levels[2]!.price).toBeCloseTo(-61.8, 5);
  });
  it('handles NaN inputs', () => {
    expect(extensionLevels(NaN, 100, [0.5], 'up')).toEqual([]);
  });
});

describe('findRecentSwings', () => {
  it('returns high and low for an uptrend', () => {
    const candles = trendingUp(40, 100, 1);
    const swings = findRecentSwings(candles, 40);
    expect(swings).toBeDefined();
    expect(swings!.swingHigh.price).toBeGreaterThan(swings!.swingLow.price);
    expect(swings!.direction).toBe('up');
  });
  it('returns high and low for a downtrend', () => {
    const candles = trendingDown(40, 200, 1);
    const swings = findRecentSwings(candles, 40);
    expect(swings).toBeDefined();
    expect(swings!.swingLow.price).toBeLessThan(swings!.swingHigh.price);
    expect(swings!.direction).toBe('down');
  });
  it('handles empty input', () => {
    expect(findRecentSwings([], 10)).toBeUndefined();
  });
  it('handles single candle', () => {
    const candles = [makeCandle(0, 100, 101, 99, 100)];
    const swings = findRecentSwings(candles, 1);
    expect(swings).toBeDefined();
    expect(swings!.swingHigh.price).toBe(101);
    expect(swings!.swingLow.price).toBe(99);
  });
  it('handles NaN in candles', () => {
    const candles = withNaN(trendingUp(40));
    expect(() => findRecentSwings(candles, 40)).not.toThrow();
  });
  it('handles extreme volatility', () => {
    const candles = extremeVolatility(60);
    const swings = findRecentSwings(candles, 60);
    expect(swings).toBeDefined();
  });
  it('respects lookback window', () => {
    const candles = trendingUp(100, 100, 1);
    const last10 = findRecentSwings(candles, 10);
    const all = findRecentSwings(candles, 100);
    expect(last10!.swingHigh.price).toBeGreaterThan(all!.swingHigh.price - 50);
  });
});

describe('autoFibonacci', () => {
  it('returns full retracement + extension set on an uptrend', () => {
    const candles = trendingUp(60, 100, 1);
    const fib = autoFibonacci(candles, 60, config);
    expect(fib).toBeDefined();
    expect(fib!.retracements.length).toBe(config.retracements.length);
    expect(fib!.extensions.length).toBe(config.extensions.length);
    // Retracement at ratio 0 is the high, at 1 is the low.
    const r0 = fib!.retracements.find((l) => l.ratio === 0);
    const r1 = fib!.retracements.find((l) => l.ratio === 1);
    expect(r0!.price).toBe(fib!.swingHigh.price);
    expect(r1!.price).toBe(fib!.swingLow.price);
    expect(fib!.direction).toBe('up');
  });
  it('produces downward extensions on a downtrend', () => {
    const candles = trendingDown(60, 200, 1);
    const fib = autoFibonacci(candles, 60, config);
    expect(fib).toBeDefined();
    expect(fib!.direction).toBe('down');
  });
  it('returns undefined on empty input', () => {
    expect(autoFibonacci([], 10, config)).toBeUndefined();
  });
  it('handles single candle without throwing', () => {
    const candles = [makeCandle(0, 100, 101, 99, 100)];
    const fib = autoFibonacci(candles, 1, config);
    expect(fib).toBeDefined();
  });
  it('handles NaN in candles', () => {
    const candles = withNaN(trendingUp(60));
    expect(() => autoFibonacci(candles, 60, config)).not.toThrow();
  });
  it('handles extreme volatility', () => {
    const candles = extremeVolatility(60);
    const fib = autoFibonacci(candles, 60, config);
    expect(fib).toBeDefined();
  });
  it('range matches high - low', () => {
    const candles = trendingUp(40);
    const fib = autoFibonacci(candles, 40, config);
    expect(fib!.range).toBeCloseTo(fib!.swingHigh.price - fib!.swingLow.price, 6);
  });
});

describe('manualFibonacci', () => {
  it('returns retracements between the two anchors', () => {
    const result = manualFibonacci(
      { price: 100 },
      { price: 200 },
      'up',
      config,
    );
    expect(result.high).toBe(200);
    expect(result.low).toBe(100);
    expect(result.range).toBe(100);
    expect(result.retracements.length).toBe(config.retracements.length);
    // 0.5 retracement is at the midpoint
    const mid = result.retracements.find((l) => l.ratio === 0.5);
    expect(mid!.price).toBeCloseTo(150, 6);
  });
  it('returns extensions above p2 in the up direction', () => {
    const result = manualFibonacci(
      { price: 100 },
      { price: 200 },
      'up',
      config,
    );
    const ext1 = result.extensions.find((l) => l.ratio === 1);
    expect(ext1!.price).toBeCloseTo(300, 6);
  });
  it('returns extensions below p2 in the down direction', () => {
    const result = manualFibonacci(
      { price: 200 },
      { price: 100 },
      'down',
      config,
    );
    const ext1 = result.extensions.find((l) => l.ratio === 1);
    expect(ext1!.price).toBeCloseTo(0, 6);
  });
  it('handles NaN prices', () => {
    const result = manualFibonacci(
      { price: NaN },
      { price: 100 },
      'up',
      config,
    );
    expect(result.retracements).toEqual([]);
    expect(result.extensions).toEqual([]);
  });
});
