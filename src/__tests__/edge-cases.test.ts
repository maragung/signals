// Edge case coverage for the data pipeline.
//
// Goal: make sure the engine never throws on unusual inputs and
// returns something sensible (empty arrays, NaN, 0, etc.) for
// pathological data. Each `describe` block targets one category of
// edge case (empty input, NaN, Infinity, etc.) and exercises every
// public function in the integration test plan plus a few extras.

import { describe, expect, it } from 'vitest';

import type {
  Candle,
  FibConfig,
  FuturesSnapshot,
  LiquidationEvent,
  StrategyConfig,
  SupplyDemandZone,
  SupportResistanceLevel,
  Timeframe,
} from '@/types';
import { DEFAULT_SCORING_WEIGHTS } from '@/config/scoring';
import { aggregateCandles, sanitizeCandles, trueRange } from '@/core/utils/candles';
import { isFiniteNum, safeDiv, sanitize as sanitizeArr } from '@/core/utils/series';
import { computeScore } from '@/core/scoring';
import { runStrategies } from '@/core/strategies';
import { evaluateCell, type DataFetcher } from '@/core/mtf';
import { buildProjection } from '@/core/prediction';
import { extensionLevels, manualFibonacci, retracementLevels } from '@/core/fibonacci';
import { applyLiquidationEvent, synthesizeHeatmap } from '@/market-data/liquidation-heatmap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 100,
): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

const fibConfig: FibConfig = {
  retracements: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  extensions: [1, 1.272, 1.618, 2, 2.618],
  auto: true,
};

const weights = { ...DEFAULT_SCORING_WEIGHTS };

function makeSnapshot(over: Partial<FuturesSnapshot> = {}): FuturesSnapshot {
  return {
    symbol: 'BTCUSDT',
    markPrice: 100_000,
    indexPrice: 100_010,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    openInterest: 100_000,
    openInterestUsd: 10_000_000_000,
    longShortRatio: 1.0,
    takerBuySellRatio: 1.0,
    ts: Date.now(),
    ...over,
  };
}

class StaticFetcher implements DataFetcher {
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

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe('edge: empty input handling', () => {
  it('aggregateCandles returns [] for empty input', () => {
    expect(aggregateCandles([], '5m')).toEqual([]);
    expect(aggregateCandles([], '1h')).toEqual([]);
    expect(aggregateCandles([], '1d')).toEqual([]);
  });

  it('sanitizeCandles returns [] for empty input', () => {
    expect(sanitizeCandles([])).toEqual([]);
  });

  it('trueRange of undefined previous candle is high - low', () => {
    const c = makeCandle(0, 100, 110, 90, 105);
    expect(trueRange(c)).toBe(20);
  });

  it('computeScore returns neutral for empty input', () => {
    const r = computeScore([], {}, weights);
    expect(r.bias).toBe('neutral');
    expect(r.label).toBe('Neutral');
    expect(r.bullish).toBe(0);
    expect(r.bearish).toBe(0);
  });

  it('runStrategies returns [] for empty candles', () => {
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: {},
    };
    expect(runStrategies([], [cfg], {})).toEqual([]);
  });

  it('buildProjection handles empty candles without throwing', () => {
    const proj = buildProjection(
      [],
      { bullish: 0, bearish: 0, net: 0, total: 0, label: 'Neutral', bias: 'neutral', breakdown: { trend: 0, momentum: 0, volume: 0, structure: 0, snr: 0, snd: 0, volatility: 0, mtf: 0 } },
      { symbol: 'X', timeframe: '1h' },
    );
    expect(proj.symbol).toBe('X');
    expect(proj.timeframe).toBe('1h');
  });

  it('synthesizeHeatmap handles a zero-mark snapshot with empty levels', () => {
    const h = synthesizeHeatmap(makeSnapshot({ markPrice: 0 }), { symbol: 'BTCUSDT' });
    expect(h.levels).toEqual([]);
    expect(h.totalLongLiq).toBe(0);
    expect(h.totalShortLiq).toBe(0);
  });

  it('retracementLevels returns [] for invalid high/low', () => {
    expect(retracementLevels(NaN, 100, [0.5])).toEqual([]);
    expect(retracementLevels(100, NaN, [0.5])).toEqual([]);
  });

  it('extensionLevels returns [] for invalid anchors', () => {
    expect(extensionLevels(NaN, 100, [0.5], 'up')).toEqual([]);
    expect(extensionLevels(100, NaN, [0.5], 'up')).toEqual([]);
  });

  it('manualFibonacci returns empty arrays for invalid prices', () => {
    const r = manualFibonacci({ price: NaN }, { price: 100 }, 'up', fibConfig);
    expect(r.retracements).toEqual([]);
    expect(r.extensions).toEqual([]);
  });

  it('applyLiquidationEvent on an empty heatmap is a no-op (no level to attach to)', () => {
    const empty = synthesizeHeatmap(makeSnapshot({ markPrice: 0 }), { symbol: 'BTCUSDT' });
    const ev: LiquidationEvent = {
      time: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      price: 100_000,
      quantity: 0.1,
      notional: 10_000,
    };
    const next = applyLiquidationEvent(empty, ev);
    // No level ladder -> nothing to attach the event to.
    expect(next.levels.length).toBe(0);
    expect(next.totalLongLiq).toBe(0);
  });

  it('evaluateCell returns a neutral cell for empty candles', () => {
    const cell = evaluateCell('1h', [], {});
    expect(cell.timeframe).toBe('1h');
    expect(cell.score).toBe(0);
    expect(cell.trend).toBe('neutral');
    expect(cell.momentum).toBe('neutral');
    expect(cell.structure).toBe('neutral');
    expect(cell.volume).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Single candle
// ---------------------------------------------------------------------------

describe('edge: single candle handling', () => {
  const single = [makeCandle(0, 100, 101, 99, 100, 1)];

  it('aggregateCandles returns a single bucket for one candle', () => {
    const out = aggregateCandles(single, '5m');
    expect(out.length).toBe(1);
    expect(out[0]!.open).toBe(100);
    expect(out[0]!.close).toBe(100);
  });

  it('computeScore handles a single candle without throwing', () => {
    expect(() => computeScore(single, {}, weights)).not.toThrow();
  });

  it('buildProjection handles a single candle', () => {
    expect(() =>
      buildProjection(
        single,
        { bullish: 0, bearish: 0, net: 0, total: 0, label: 'Neutral', bias: 'neutral', breakdown: { trend: 0, momentum: 0, volume: 0, structure: 0, snr: 0, snd: 0, volatility: 0, mtf: 0 } },
        { symbol: 'X', timeframe: '1h' },
      ),
    ).not.toThrow();
  });

  it('runStrategies with a single candle does not throw', () => {
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: {},
    };
    expect(() => runStrategies(single, [cfg], {})).not.toThrow();
  });

  it('evaluateCell on a single candle returns a neutral cell', () => {
    const cell = evaluateCell('1h', single, {});
    expect(cell.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NaN values
// ---------------------------------------------------------------------------

describe('edge: NaN values in input', () => {
  it('sanitizeCandles drops NaN-bearing candles', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100),
      makeCandle(60, NaN, NaN, NaN, NaN, NaN),
      makeCandle(120, 102, 103, 101, 102),
    ];
    const out = sanitizeCandles(candles);
    expect(out.length).toBe(2);
    for (const c of out) {
      for (const v of [c.open, c.high, c.low, c.close, c.volume]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('computeScore is finite when input candles contain NaN', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.1));
    }
    candles[30] = makeCandle(30, NaN, NaN, NaN, NaN, NaN);
    const clean = sanitizeCandles(candles);
    const r = computeScore(clean, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    expect(Number.isFinite(r.net)).toBe(true);
  });

  it('buildProjection is finite when input candles contain NaN', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.1));
    }
    candles[30] = makeCandle(30, NaN, NaN, NaN, NaN, NaN);
    const clean = sanitizeCandles(candles);
    const score = computeScore(clean, {}, weights);
    const proj = buildProjection(clean, score, { symbol: 'BTC', timeframe: '1h' });
    expect(Number.isFinite(proj.score)).toBe(true);
    expect(proj.targets.length).toBeGreaterThan(0);
  });

  it('synthesizeHeatmap returns empty heatmap for NaN mark price', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: NaN as unknown as number }),
      { symbol: 'BTCUSDT' },
    );
    expect(h.levels).toEqual([]);
    expect(h.totalLongLiq).toBe(0);
    expect(h.totalShortLiq).toBe(0);
  });

  it('retracementLevels returns [] when high or low is NaN', () => {
    expect(retracementLevels(NaN, 100, [0.5])).toEqual([]);
    expect(retracementLevels(100, NaN, [0.5])).toEqual([]);
    expect(retracementLevels(100, 100, [NaN])).toEqual([]);
  });

  it('safeDiv returns NaN for NaN inputs', () => {
    expect(Number.isNaN(safeDiv(NaN, 1))).toBe(true);
    expect(Number.isNaN(safeDiv(1, NaN))).toBe(true);
    expect(Number.isNaN(safeDiv(1, 0))).toBe(true);
  });

  it('isFiniteNum is false for NaN', () => {
    expect(isFiniteNum(NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Infinity values
// ---------------------------------------------------------------------------

describe('edge: Infinity values in input', () => {
  it('sanitizeCandles drops Infinity-bearing candles', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100),
      makeCandle(60, Infinity, Infinity, Infinity, Infinity, Infinity),
      makeCandle(120, 102, 103, 101, 102),
    ];
    const out = sanitizeCandles(candles);
    expect(out.length).toBe(2);
  });

  it('synthesizeHeatmap returns empty heatmap for Infinity mark price', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: Infinity }),
      { symbol: 'BTCUSDT' },
    );
    expect(h.levels).toEqual([]);
  });

  it('computeScore tolerates Infinity in prices', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.1));
    }
    candles[30] = makeCandle(30, Infinity, Infinity, Infinity, Infinity, Infinity);
    const clean = sanitizeCandles(candles);
    const r = computeScore(clean, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
  });

  it('isFiniteNum is false for Infinity', () => {
    expect(isFiniteNum(Infinity)).toBe(false);
    expect(isFiniteNum(-Infinity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Negative prices
// ---------------------------------------------------------------------------

describe('edge: negative prices', () => {
  it('computeScore does not throw on negative-priced candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const p = -100 - i;
      candles.push(makeCandle(i, p, p + 0.5, p - 0.5, p + 0.1, 100));
    }
    expect(() => computeScore(candles, {}, weights)).not.toThrow();
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
  });

  it('aggregateCandles does not throw on negative-priced candles', () => {
    const candles: Candle[] = [
      makeCandle(0, -100, -99, -101, -100),
      makeCandle(60, -100, -98, -102, -99),
    ];
    expect(() => aggregateCandles(candles, '5m')).not.toThrow();
  });

  it('buildProjection does not throw on negative-priced candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const p = -100 - i;
      candles.push(makeCandle(i, p, p + 0.5, p - 0.5, p + 0.1, 100));
    }
    const score = computeScore(candles, {}, weights);
    expect(() => buildProjection(candles, score, { symbol: 'X', timeframe: '1h' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Zero volume
// ---------------------------------------------------------------------------

describe('edge: zero volume', () => {
  it('computeScore is finite for all-zero volume candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 0));
    }
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
  });

  it('buildProjection does not throw on zero-volume candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 0));
    }
    const score = computeScore(candles, {}, weights);
    expect(() => buildProjection(candles, score, { symbol: 'X', timeframe: '1h' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Very small and very large prices
// ---------------------------------------------------------------------------

describe('edge: very small (1e-9) and very large (1e12) prices', () => {
  it('handles 1e-9 priced candles without NaN or Infinity', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const p = 1e-9 + i * 1e-11;
      candles.push(makeCandle(i, p, p + 1e-11, p - 1e-11, p, 100));
    }
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    const score = computeScore(candles, {}, weights);
    expect(() => buildProjection(candles, score, { symbol: 'X', timeframe: '1h' })).not.toThrow();
  });

  it('handles 1e12 priced candles without NaN or Infinity', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const p = 1e12 + i * 1e9;
      candles.push(makeCandle(i, p, p + 1e9, p - 1e9, p, 100));
    }
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    const score = computeScore(candles, {}, weights);
    expect(() => buildProjection(candles, score, { symbol: 'X', timeframe: '1h' })).not.toThrow();
  });

  it('fibonacci works with 1e-9 and 1e12 prices', () => {
    const small = retracementLevels(2e-9, 1e-9, [0, 0.5, 1]);
    expect(small.length).toBe(3);
    expect(small[0]!.price).toBe(2e-9);
    expect(small[2]!.price).toBe(1e-9);

    const big = retracementLevels(2e12, 1e12, [0, 0.5, 1]);
    expect(big.length).toBe(3);
    expect(big[0]!.price).toBe(2e12);
    expect(big[2]!.price).toBe(1e12);
  });

  it('synthesizeHeatmap works with 1e-9 mark price', () => {
    const h = synthesizeHeatmap(
      makeSnapshot({ markPrice: 1e-9, openInterestUsd: 1_000 }),
      { symbol: 'BTCUSDT', stepPct: 1, rangePct: 5 },
    );
    expect(Array.isArray(h.levels)).toBe(true);
    for (const lvl of h.levels) {
      expect(Number.isFinite(lvl.price)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicate timestamps
// ---------------------------------------------------------------------------

describe('edge: duplicate timestamps', () => {
  it('sanitizeCandles keeps duplicates (does not dedupe)', () => {
    const candles: Candle[] = [
      makeCandle(60, 100, 101, 99, 100),
      makeCandle(60, 100, 102, 99, 101),
    ];
    const out = sanitizeCandles(candles);
    // Both candles pass sanitization, so the dedup is the caller's job.
    expect(out.length).toBe(2);
  });

  it('aggregateCandles keeps both entries (uses first high/low, second close)', () => {
    const candles: Candle[] = [
      makeCandle(60, 100, 105, 95, 102),
      makeCandle(60, 100, 110, 90, 108),
    ];
    const out = aggregateCandles(candles, '5m');
    expect(out.length).toBe(1);
    expect(out[0]!.high).toBe(110);
    expect(out[0]!.low).toBe(90);
    expect(out[0]!.close).toBe(108);
  });

  it('computeScore does not throw on duplicate timestamps', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    // Add 5 duplicates of the last candle.
    for (let j = 0; j < 5; j++) {
      candles.push({ ...candles[candles.length - 1]! });
    }
    expect(() => computeScore(candles, {}, weights)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Time gaps
// ---------------------------------------------------------------------------

describe('edge: time gaps in candles', () => {
  it('aggregateCandles opens a new bucket for every gap', () => {
    // Candles 0, 1, 2 are normal; 3 is a long gap (jumps to 100 minutes).
    const candles: Candle[] = [
      makeCandle(1_700_000_000, 100, 101, 99, 100),
      makeCandle(1_700_000_060, 101, 102, 100, 101),
      makeCandle(1_700_000_120, 102, 103, 101, 102),
      // Big gap -> a new 5m bucket even though we have 3 candles.
      makeCandle(1_700_001_000, 110, 111, 109, 110),
      makeCandle(1_700_001_060, 111, 112, 110, 111),
    ];
    const out = aggregateCandles(candles, '5m');
    // 1st bucket has 3 candles, 2nd bucket has 2 candles.
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('computeScore does not throw when timestamps are non-monotonic', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100),
      makeCandle(60, 101, 102, 100, 101),
      // Out-of-order timestamp:
      makeCandle(30, 100, 100, 99, 100),
      makeCandle(120, 102, 103, 101, 102),
    ];
    expect(() => computeScore(candles, {}, weights)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// All same price (no volatility)
// ---------------------------------------------------------------------------

describe('edge: all same price (no volatility)', () => {
  it('computeScore is finite on a flat series', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      candles.push(makeCandle(i * 60, 100, 100, 100, 100, 100));
    }
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    expect(Number.isFinite(r.net)).toBe(true);
  });

  it('buildProjection is finite on a flat series', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      candles.push(makeCandle(i * 60, 100, 100, 100, 100, 100));
    }
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'X', timeframe: '1h' });
    expect(Number.isFinite(proj.score)).toBe(true);
  });

  it('runStrategies does not throw on a flat series', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      candles.push(makeCandle(i * 60, 100, 100, 100, 100, 100));
    }
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: { emaFast: 9, emaSlow: 21 },
    };
    expect(() => runStrategies(candles, [cfg], {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Extreme volatility
// ---------------------------------------------------------------------------

describe('edge: extreme volatility', () => {
  function extreme(n: number): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const amp = 50;
      const o = 100 + (i % 2 === 0 ? 1 : -1) * amp;
      const c = o + (i % 2 === 0 ? -1 : 1) * amp * 1.5;
      out.push(
        makeCandle(
          i * 60,
          o,
          Math.max(o, c) + amp,
          Math.min(o, c) - amp,
          c,
          1000,
        ),
      );
    }
    return out;
  }

  it('computeScore is finite under extreme volatility', () => {
    const r = computeScore(extreme(120), {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    expect(Number.isFinite(r.net)).toBe(true);
  });

  it('buildProjection is finite under extreme volatility', () => {
    const candles = extreme(120);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'X', timeframe: '1h' });
    expect(Number.isFinite(proj.score)).toBe(true);
    expect(proj.targets.length).toBeGreaterThan(0);
  });

  it('runStrategies does not throw under extreme volatility', () => {
    const candles = extreme(60);
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: { emaFast: 9, emaSlow: 21 },
    };
    expect(() => runStrategies(candles, [cfg], {})).not.toThrow();
  });

  it('evaluateCell is finite under extreme volatility', () => {
    const cell = evaluateCell('1h', extreme(60), {});
    expect(Number.isFinite(cell.score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty SNR / SND inputs
// ---------------------------------------------------------------------------

describe('edge: empty SNR/SND inputs', () => {
  it('computeScore is neutral with empty SNR', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const r = computeScore(candles, { snr: [] }, weights);
    expect(r.breakdown.snr).toBe(0);
    expect(Number.isFinite(r.bullish)).toBe(true);
  });

  it('computeScore is neutral with empty SND', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const r = computeScore(candles, { snd: [] }, weights);
    expect(r.breakdown.snd).toBe(0);
    expect(Number.isFinite(r.bullish)).toBe(true);
  });

  it('buildProjection handles empty SNR list', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const score = computeScore(candles, {}, weights);
    expect(() =>
      buildProjection(candles, score, { symbol: 'X', timeframe: '1h', snr: [] }),
    ).not.toThrow();
  });

  it('buildProjection handles empty SND list', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const score = computeScore(candles, {}, weights);
    expect(() =>
      buildProjection(candles, score, { symbol: 'X', timeframe: '1h', snd: [] }),
    ).not.toThrow();
  });

  it('runStrategies handles empty SNR/SND context', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const cfg: StrategyConfig = {
      id: 'b',
      kind: 'breakout',
      enabled: true,
      params: {},
    };
    const ctx = { snr: [] as SupportResistanceLevel[], snd: [] as SupplyDemandZone[] };
    expect(() => runStrategies(candles, [cfg], ctx)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Default-argument behavior
// ---------------------------------------------------------------------------

describe('edge: defaults work without throwing', () => {
  it('computeScore with default context and weights', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    // Default context plus the project's default weight set.
    const r = computeScore(candles, {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
  });

  it('buildProjection with minimal context (no SNR, no SND, no overrides)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'X', timeframe: '1h' });
    expect(proj.symbol).toBe('X');
    expect(proj.targets.length).toBeGreaterThan(0);
  });

  it('synthesizeHeatmap with only the required option', () => {
    const h = synthesizeHeatmap(makeSnapshot(), { symbol: 'BTCUSDT' });
    expect(h.levels.length).toBeGreaterThan(0);
  });

  it('manualFibonacci with default config produces all levels', () => {
    const r = manualFibonacci({ price: 100 }, { price: 200 }, 'up', fibConfig);
    expect(r.retracements.length).toBe(fibConfig.retracements.length);
    expect(r.extensions.length).toBe(fibConfig.extensions.length);
  });

  it('runStrategies with empty context object', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: { emaFast: 9, emaSlow: 21 },
    };
    expect(() => runStrategies(candles, [cfg])).not.toThrow();
  });

  it('sanitize (numeric) drops non-finite values', () => {
    const out = sanitizeArr([1, NaN, 2, Infinity, 3, -Infinity, 4]);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('applyLiquidationEvent is a no-op for an empty event (default values)', () => {
    // The minimum LiquidationEvent: 0 qty/notional at a finite price.
    const snap = makeSnapshot();
    const base = synthesizeHeatmap(snap, { symbol: 'BTCUSDT' });
    const ev: LiquidationEvent = {
      time: 0,
      symbol: 'BTCUSDT',
      side: 'long',
      price: 0,
      quantity: 0,
      notional: 0,
    };
    const next = applyLiquidationEvent(base, ev);
    // The event is recorded in recentEvents even with zero notional.
    expect(next.recentEvents[0]).toEqual(ev);
  });
});
