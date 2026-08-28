import { describe, it, expect } from 'vitest';
import type { Candle } from '@/types';
import {
  detectSwings,
  classifyStructure,
  detectMarketStructure,
  detectBosChocho,
  detectLiquiditySweeps,
} from './index';

// --- helpers ------------------------------------------------------------

let _id = 0;
function cid(): string {
  _id += 1;
  return `id-${_id}`;
}

function makeCandle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

/**
 * Build a deterministic zig-zag series of N candles with strict peaks
 * and troughs. Each "wave" is 5 candles. The peak is a single candle
 * whose high is strictly greater than its neighbours; the trough is a
 * single candle whose low is strictly lower.
 */
function makeZigzag(n: number, base = 100, start = 1000): Candle[] {
  const out: Candle[] = [];
  // Two complete waves in 10 candles: peak at i=2, trough at i=4, peak at i=7, trough at i=9.
  // Use a single up-candle, then a single down-candle so the peak/trough are strictly extreme.
  for (let i = 0; i < n; i++) {
    const phase = i % 10;
    let open: number, high: number, low: number, close: number;
    if (phase < 2) {
      // Approach the peak
      open = base + phase * 2;
      high = open + 2;
      low = open - 1;
      close = open + 2;
    } else if (phase === 2) {
      // Strict peak
      open = base + 6;
      high = base + 10;
      low = open - 1;
      close = base + 6;
    } else if (phase < 4) {
      // Approach the trough
      const k = phase - 3;
      open = base + 4 - k * 2;
      high = open + 1;
      low = open - 2;
      close = open - 2;
    } else if (phase === 4) {
      // Strict trough
      open = base;
      high = open + 1;
      low = base - 10;
      close = open;
    } else if (phase < 7) {
      // Approach next peak
      const k = phase - 5;
      open = base + k * 2;
      high = open + 2;
      low = open - 1;
      close = open + 2;
    } else if (phase === 7) {
      // Strict peak (higher than the first)
      open = base + 6;
      high = base + 12;
      low = open - 1;
      close = base + 6;
    } else if (phase < 9) {
      // Approach next trough
      const k = phase - 8;
      open = base + 4 - k * 2;
      high = open + 1;
      low = open - 2;
      close = open - 2;
    } else {
      // Strict trough (lower than the first)
      open = base;
      high = open + 1;
      low = base - 12;
      close = open;
    }
    out.push(makeCandle(start + i * 60, open, high, low, close));
  }
  return out;
}

/**
 * Build a strict alternating higher-high / higher-low uptrend.
 * Each "step" is 3 candles: 1 up, 1 small dip, 1 up beyond previous high.
 */
function makeUptrend(steps = 4, base = 100, stepSize = 2, start = 1000): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let s = 0; s < steps; s++) {
    price += stepSize;
    out.push(makeCandle(out.length ? out[out.length - 1]!.time + 60 : start, price - 1, price + 0.5, price - 1.2, price));
    const pb = price - stepSize * 0.5;
    out.push(makeCandle(out[out.length - 1]!.time + 60, price, price, pb - 0.2, pb));
    price += stepSize;
    out.push(makeCandle(out[out.length - 1]!.time + 60, pb, price + 0.5, pb - 0.3, price));
  }
  return out;
}

/** Strict lower-high / lower-low downtrend mirror of makeUptrend. */
function makeDowntrend(steps = 4, base = 200, stepSize = 2, start = 1000): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let s = 0; s < steps; s++) {
    price -= stepSize;
    out.push(makeCandle(out.length ? out[out.length - 1]!.time + 60 : start, price + 1, price + 1.2, price - 0.5, price));
    const pb = price + stepSize * 0.5;
    out.push(makeCandle(out[out.length - 1]!.time + 60, price, price + 0.2, pb - 0.2, pb));
    price -= stepSize;
    out.push(makeCandle(out[out.length - 1]!.time + 60, pb, pb + 0.3, price - 0.5, price));
  }
  return out;
}

// --- detectSwings -------------------------------------------------------

describe('detectSwings', () => {
  it('returns empty array for empty input', () => {
    expect(detectSwings([])).toEqual([]);
  });

  it('returns empty for fewer than 2*lookback+1 candles', () => {
    const c = makeZigzag(2);
    expect(detectSwings(c, { lookback: 2 })).toEqual([]);
  });

  it('detects a swing high in a clear 5-candle peak', () => {
    const candles: Candle[] = [
      makeCandle(0, 10, 11, 9, 10),
      makeCandle(1, 10, 12, 10, 11),
      makeCandle(2, 11, 20, 11, 19), // peak
      makeCandle(3, 19, 19, 13, 14),
      makeCandle(4, 14, 15, 13, 14),
    ];
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings).toHaveLength(1);
    expect(swings[0]!.kind).toBe('high');
    expect(swings[0]!.price).toBe(20);
    expect(swings[0]!.index).toBe(2);
  });

  it('detects a swing low in a clear 5-candle trough', () => {
    const candles: Candle[] = [
      makeCandle(0, 10, 11, 9, 10),
      makeCandle(1, 9, 10, 8, 9),
      makeCandle(2, 9, 9, 1, 2), // trough
      makeCandle(3, 2, 7, 2, 6),
      makeCandle(4, 6, 8, 6, 7),
    ];
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings).toHaveLength(1);
    expect(swings[0]!.kind).toBe('low');
    expect(swings[0]!.price).toBe(1);
  });

  it('detects both high and low in a strict zigzag series', () => {
    const candles = makeZigzag(15);
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings.length).toBeGreaterThan(0);
    const highs = swings.filter((s) => s.kind === 'high');
    const lows = swings.filter((s) => s.kind === 'low');
    expect(highs.length).toBeGreaterThan(0);
    expect(lows.length).toBeGreaterThan(0);
    for (let i = 0; i < swings.length - 1; i++) {
      expect(swings[i]!.index).toBeLessThan(swings[i + 1]!.index);
    }
  });

  it('handles a single candle', () => {
    expect(detectSwings([makeCandle(0, 100, 100, 100, 100)])).toEqual([]);
  });

  it('handles all-uptrend (no swing highs or lows)', () => {
    const candles = makeUptrend(3, 100, 1);
    const swings = detectSwings(candles, { lookback: 2 });
    // Strictly rising series with no pullback should yield no swings
    expect(swings).toEqual([]);
  });

  it('handles all-downtrend (no swing highs or lows)', () => {
    const candles = makeDowntrend(3, 100, 1);
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings).toEqual([]);
  });

  it('handles a sideways series with no extremes', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(makeCandle(i * 60, 100, 101, 99, 100));
    }
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings).toEqual([]);
  });

  it('handles extreme values (very large / very small numbers)', () => {
    const candles: Candle[] = [
      makeCandle(0, 1e-9, 1.5e-9, 0.5e-9, 1.2e-9),
      makeCandle(1, 1.2e-9, 1.7e-9, 1.1e-9, 1.4e-9),
      makeCandle(2, 1.4e-9, 1e6, 1.3e-9, 5e5), // extreme peak
      makeCandle(3, 5e5, 5e5, 1.4e-9, 1.5e-9),
      makeCandle(4, 1.5e-9, 1.6e-9, 1.4e-9, 1.5e-9),
    ];
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings.length).toBe(1);
    expect(swings[0]!.price).toBe(1e6);
  });

  it('skips non-finite candles silently', () => {
    const candles: Candle[] = [
      makeCandle(0, 10, 11, 9, 10),
      makeCandle(1, 10, 12, 10, 11),
      { time: 2, open: 11, high: NaN, low: 11, close: 19, volume: 0 },
      makeCandle(3, 19, 19, 13, 14),
      makeCandle(4, 14, 15, 13, 14),
    ];
    const swings = detectSwings(candles, { lookback: 2 });
    expect(swings).toEqual([]);
  });
});

// --- classifyStructure --------------------------------------------------

describe('classifyStructure', () => {
  it('emits HH for a sequence of rising swing highs (after first baseline)', () => {
    const swings = [
      { time: 1, price: 100, index: 1, kind: 'high' as const },
      { time: 2, price: 110, index: 3, kind: 'high' as const },
      { time: 3, price: 120, index: 5, kind: 'high' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    // First swing high establishes a baseline and is not emitted.
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe('HH');
    expect(result[1]!.kind).toBe('HH');
  });

  it('emits LH after a lower high', () => {
    const swings = [
      { time: 1, price: 100, index: 1, kind: 'high' as const },
      { time: 2, price: 90, index: 3, kind: 'high' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('LH');
  });

  it('emits EQH when within tolerance', () => {
    const swings = [
      { time: 1, price: 100, index: 1, kind: 'high' as const },
      { time: 2, price: 100.05, index: 3, kind: 'high' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('EQH');
  });

  it('does not emit EQH when outside tolerance', () => {
    const swings = [
      { time: 1, price: 100, index: 1, kind: 'high' as const },
      { time: 2, price: 100.2, index: 3, kind: 'high' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('HH');
  });

  it('emits HL for higher swing lows and LL for lower ones', () => {
    const swings = [
      { time: 1, price: 50, index: 1, kind: 'low' as const },
      { time: 2, price: 60, index: 3, kind: 'low' as const },
      { time: 3, price: 55, index: 5, kind: 'low' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    // First low is the baseline; only the next two are labelled.
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe('HL');
    expect(result[1]!.kind).toBe('LL');
  });

  it('emits EQL for matching swing lows within tolerance', () => {
    const swings = [
      { time: 1, price: 50, index: 1, kind: 'low' as const },
      { time: 2, price: 50.04, index: 3, kind: 'low' as const },
    ];
    const result = classifyStructure(swings, { tolerance: 0.1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('EQL');
  });

  it('handles empty swings', () => {
    expect(classifyStructure([])).toEqual([]);
  });
});

// --- detectMarketStructure ---------------------------------------------

describe('detectMarketStructure', () => {
  it('returns empty for empty input', () => {
    expect(detectMarketStructure([])).toEqual([]);
  });

  it('produces HH/HL alternation for a strict uptrend', () => {
    const candles = makeUptrend(4, 100, 4);
    const points = detectMarketStructure(candles, { lookback: 1, tolerance: 0.1 });
    expect(points.length).toBeGreaterThan(0);
    // Every label must be HH or HL in a strict uptrend
    for (const p of points) {
      expect(['HH', 'HL']).toContain(p.kind);
    }
  });

  it('produces LH/LL alternation for a strict downtrend', () => {
    const candles = makeDowntrend(4, 200, 4);
    const points = detectMarketStructure(candles, { lookback: 1, tolerance: 0.1 });
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(['LH', 'LL']).toContain(p.kind);
    }
  });
});

// --- detectBosChocho ----------------------------------------------------

describe('detectBosChocho', () => {
  it('returns empty for empty / too-short input', () => {
    expect(detectBosChocho([])).toEqual([]);
    expect(detectBosChocho([makeCandle(0, 1, 1, 1, 1)])).toEqual([]);
  });

  it('emits a bullish BOS on uptrend break above swing high', () => {
    const candles = makeUptrend(3, 100, 5);
    candles.push(makeCandle(candles[candles.length - 1]!.time + 60, 120, 130, 119, 128));
    const events = detectBosChocho(candles, { lookback: 1, tolerance: 0.1 });
    expect(events.length).toBeGreaterThan(0);
    const bos = events.find((e) => e.kind === 'BOS' && e.direction === 'bullish');
    expect(bos).toBeDefined();
  });

  it('emits a bearish BOS on downtrend break below swing low', () => {
    const candles = makeDowntrend(3, 200, 5);
    candles.push(makeCandle(candles[candles.length - 1]!.time + 60, 80, 81, 70, 72));
    const events = detectBosChocho(candles, { lookback: 1, tolerance: 0.1 });
    expect(events.length).toBeGreaterThan(0);
    const bos = events.find((e) => e.kind === 'BOS' && e.direction === 'bearish');
    expect(bos).toBeDefined();
  });

  it('emits a bearish CHOCH when an uptrend breaks below the prior swing low', () => {
    // Build a clean two-step uptrend (three swing highs/lows each), then
    // close well below the lowest swing low.
    const candles = makeUptrend(3, 100, 10);
    const swings = detectSwings(candles, { lookback: 1 });
    const lowestLow = swings.filter((s) => s.kind === 'low').reduce((m, s) => Math.min(m, s.price), Infinity);
    // Append a candle that closes well below the lowest swing low
    const lastTime = candles[candles.length - 1]!.time;
    candles.push(makeCandle(lastTime + 60, lowestLow + 1, lowestLow + 1.5, lowestLow - 5, lowestLow - 6));
    const events = detectBosChocho(candles, { lookback: 1, tolerance: 0.1 });
    const choch = events.find((e) => e.kind === 'CHOCH' && e.direction === 'bearish');
    expect(choch).toBeDefined();
  });

  it('emits a bullish CHOCH when a downtrend breaks above the prior swing high', () => {
    const candles = makeDowntrend(3, 300, 10);
    const swings = detectSwings(candles, { lookback: 1 });
    const highestHigh = swings
      .filter((s) => s.kind === 'high')
      .reduce((m, s) => Math.max(m, s.price), -Infinity);
    const lastTime = candles[candles.length - 1]!.time;
    candles.push(makeCandle(lastTime + 60, highestHigh - 1, highestHigh + 5, highestHigh - 1.5, highestHigh + 6));
    const events = detectBosChocho(candles, { lookback: 1, tolerance: 0.1 });
    const choch = events.find((e) => e.kind === 'CHOCH' && e.direction === 'bullish');
    expect(choch).toBeDefined();
  });

  it('handles sideways / no swings gracefully', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    const events = detectBosChocho(candles, { lookback: 2, tolerance: 0.1 });
    expect(events).toEqual([]);
  });

  it('handles extreme values without throwing', () => {
    const candles: Candle[] = [
      makeCandle(0, 1e-9, 1.5e-9, 0.5e-9, 1.2e-9),
      makeCandle(60, 1.2e-9, 1.7e-9, 1.1e-9, 1.4e-9),
      makeCandle(120, 1.4e-9, 2e-9, 1.3e-9, 1.9e-9),
      makeCandle(180, 1.9e-9, 3e-9, 1.8e-9, 2.5e-9),
      makeCandle(240, 2.5e-9, 4e-9, 2.4e-9, 3.5e-9),
    ];
    const events = detectBosChocho(candles, { lookback: 1, tolerance: 0.1 });
    expect(Array.isArray(events)).toBe(true);
  });
});

// --- detectLiquiditySweeps ---------------------------------------------

describe('detectLiquiditySweeps', () => {
  it('returns empty for empty / too-short input', () => {
    expect(detectLiquiditySweeps([])).toEqual([]);
    expect(detectLiquiditySweeps([makeCandle(0, 1, 1, 1, 1)])).toEqual([]);
  });

  it('detects a buy-side sweep (wick above swing high, close back inside)', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 105, 95, 100),
      makeCandle(60, 100, 110, 100, 108),
      makeCandle(120, 108, 120, 108, 119), // swing high
      makeCandle(180, 119, 119, 113, 114),
      makeCandle(240, 114, 115, 113, 114),
      makeCandle(300, 114, 125, 114, 116), // wick above 120, close back below
    ];
    const sweeps = detectLiquiditySweeps(candles, { lookback: 1 });
    const buySide = sweeps.find((s) => s.kind === 'buy-side');
    expect(buySide).toBeDefined();
    expect(buySide!.level).toBe(120);
  });

  it('detects a sell-side sweep (wick below swing low, close back inside)', () => {
    const candles: Candle[] = [
      makeCandle(0, 200, 205, 195, 200),
      makeCandle(60, 200, 210, 195, 208),
      makeCandle(120, 208, 208, 180, 181), // swing low at 180
      makeCandle(180, 181, 187, 181, 186),
      makeCandle(240, 186, 187, 185, 186),
      makeCandle(300, 186, 186, 170, 184), // wick below 180, close back above
    ];
    const sweeps = detectLiquiditySweeps(candles, { lookback: 1 });
    const sellSide = sweeps.find((s) => s.kind === 'sell-side');
    expect(sellSide).toBeDefined();
    expect(sellSide!.level).toBe(180);
  });

  it('does not flag a candle that closes through the level', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 105, 95, 100),
      makeCandle(60, 100, 110, 100, 108),
      makeCandle(120, 108, 120, 108, 119),
      makeCandle(180, 119, 119, 113, 114),
      makeCandle(240, 114, 115, 113, 114),
      makeCandle(300, 114, 130, 114, 128), // closes through -- not a sweep
    ];
    const sweeps = detectLiquiditySweeps(candles, { lookback: 1 });
    expect(sweeps).toEqual([]);
  });

  it('handles all-uptrend (no swings, no sweeps)', () => {
    const candles = makeUptrend(4, 100, 1);
    const sweeps = detectLiquiditySweeps(candles, { lookback: 2 });
    expect(sweeps).toEqual([]);
  });

  it('handles all-downtrend (no swings, no sweeps)', () => {
    const candles = makeDowntrend(4, 100, 1);
    const sweeps = detectLiquiditySweeps(candles, { lookback: 2 });
    expect(sweeps).toEqual([]);
  });

  it('handles sideways without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    const sweeps = detectLiquiditySweeps(candles, { lookback: 2 });
    expect(sweeps).toEqual([]);
  });
});

// touch cid to keep import alive (so this file is treated as using the helper)
void cid;
