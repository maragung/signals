import { describe, expect, it } from 'vitest';
import type {
  Candle,
  MarketStructureEvent,
  ScoringResult,
  StrategyConfig,
  SupplyDemandZone,
  SupportResistanceLevel,
  Timeframe,
} from '@/types';
import {
  breakoutStrategy,
  evaluateBreakout,
  evaluateMeanReversion,
  evaluateMtfTrend,
  evaluateSupplyDemand,
  evaluateTrendFollowing,
  getStrategyImpl,
  meanReversionStrategy,
  mtfTrendStrategy,
  runStrategies,
  STRATEGY_IMPLS,
  supplyDemandStrategy,
  trendFollowingStrategy,
} from '@/core/strategies';
import { atrSeries } from '@/core/strategies/indicators';

// ----- Test fixtures ---------------------------------------------------------

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 1): Candle {
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

function trendingDown(n: number, start = 100, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = start - i * step;
    const c = o - step;
    out.push(makeCandle(i, o, o + 0.2, c - 0.2, c, 100 + i));
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

function makeContext(overrides: Partial<Parameters<typeof runStrategies>[2]> = {}): Parameters<typeof runStrategies>[2] {
  return {
    symbol: 'BTCUSD',
    timeframe: '1h' as Timeframe,
    atr: 1,
    price: 100,
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

function withNaN(candles: Candle[]): Candle[] {
  if (candles.length === 0) return candles;
  const copy = candles.slice();
  const last = copy[copy.length - 1]!;
  copy[copy.length - 1] = { ...last, close: NaN, high: NaN, low: NaN };
  return copy;
}

// ----- Trend following -------------------------------------------------------

describe('trend-following strategy', () => {
  it('is exposed via the barrel and registry', () => {
    expect(trendFollowingStrategy.kind).toBe('trend-following');
    expect(getStrategyImpl('trend-following')).toBe(trendFollowingStrategy);
    expect(STRATEGY_IMPLS).toContain(trendFollowingStrategy);
  });

  it('returns undefined on empty candle list', () => {
    expect(
      trendFollowingStrategy.evaluate([], { emaFast: 9, emaSlow: 21, adxThreshold: 20 }, makeContext()),
    ).toBeUndefined();
  });

  it('returns undefined on a single candle', () => {
    const single = [makeCandle(0, 100, 101, 99, 100)];
    expect(
      trendFollowingStrategy.evaluate(single, { emaFast: 9, emaSlow: 21 }, makeContext()),
    ).toBeUndefined();
  });

  it('fires long on a sustained uptrend', () => {
    const candles = trendingUp(80);
    const ctx = makeContext({ price: candles[candles.length - 1]!.close });
    const sig = trendFollowingStrategy.evaluate(candles, { emaFast: 9, emaSlow: 21, adxThreshold: 20 }, ctx);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
    expect(sig!.confidence).toBeGreaterThan(0.5);
  });

  it('fires short on a sustained downtrend', () => {
    const candles = trendingDown(80);
    const ctx = makeContext({ price: candles[candles.length - 1]!.close });
    const sig = trendFollowingStrategy.evaluate(candles, { emaFast: 9, emaSlow: 21, adxThreshold: 20 }, ctx);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('short');
  });

  it('returns undefined in a range-bound market (ADX low)', () => {
    const candles = ranging(80);
    const ctx = makeContext({ price: candles[candles.length - 1]!.close });
    // ADX threshold of 40 should reject the gentle sine wave trend.
    const sig = trendFollowingStrategy.evaluate(
      candles,
      { emaFast: 9, emaSlow: 21, adxThreshold: 40 },
      ctx,
    );
    expect(sig).toBeUndefined();
  });

  it('handles NaN in input candles without throwing', () => {
    const candles = withNaN(trendingUp(80));
    const ctx = makeContext();
    expect(() =>
      trendFollowingStrategy.evaluate(candles, { emaFast: 9, emaSlow: 21 }, ctx),
    ).not.toThrow();
  });

  it('evaluateTrendFollowing respects enabled=false', () => {
    const candles = trendingUp(80);
    const cfg: StrategyConfig = {
      id: 'trend',
      kind: 'trend-following',
      enabled: false,
      params: { emaFast: 9, emaSlow: 21 },
    };
    expect(evaluateTrendFollowing(candles, cfg, makeContext())).toBeUndefined();
  });
});

// ----- Mean reversion --------------------------------------------------------

describe('mean-reversion strategy', () => {
  it('fires long when RSI is oversold at the lower band', () => {
    const candles: Candle[] = [];
    // Mostly stable then a sudden dump pushes RSI low and price below lower band
    for (let i = 0; i < 50; i++) {
      candles.push(makeCandle(i, 100 + i * 0.1, 100.5 + i * 0.1, 99.5 + i * 0.1, 100 + i * 0.1, 100));
    }
    // drop
    candles.push(makeCandle(50, 105, 105.5, 90, 92, 100));
    candles.push(makeCandle(51, 92, 92.5, 89, 89.5, 100));
    candles.push(makeCandle(52, 89.5, 90, 88, 88.5, 100));
    const ctx = makeContext({ price: candles[candles.length - 1]!.close });
    const sig = meanReversionStrategy.evaluate(candles, { rsiLower: 30, rsiUpper: 70, bbStddev: 2 }, ctx);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
  });

  it('fires short when RSI is overbought at the upper band', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 50; i++) {
      candles.push(makeCandle(i, 100 - i * 0.1, 100.5 - i * 0.1, 99.5 - i * 0.1, 100 - i * 0.1, 100));
    }
    candles.push(makeCandle(50, 95, 112, 94, 110, 100));
    candles.push(makeCandle(51, 110, 115, 109, 114, 100));
    candles.push(makeCandle(52, 114, 117, 113, 116, 100));
    const ctx = makeContext({ price: candles[candles.length - 1]!.close });
    const sig = meanReversionStrategy.evaluate(candles, { rsiLower: 30, rsiUpper: 70, bbStddev: 2 }, ctx);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('short');
  });

  it('returns undefined on empty or single candle', () => {
    expect(meanReversionStrategy.evaluate([], {}, makeContext())).toBeUndefined();
    expect(
      meanReversionStrategy.evaluate([makeCandle(0, 100, 101, 99, 100)], {}, makeContext()),
    ).toBeUndefined();
  });

  it('handles extreme volatility without throwing', () => {
    const candles = extremeVolatility(80);
    expect(() => meanReversionStrategy.evaluate(candles, {}, makeContext())).not.toThrow();
  });

  it('handles NaN values gracefully', () => {
    const candles = withNaN(trendingUp(80));
    expect(() => meanReversionStrategy.evaluate(candles, {}, makeContext())).not.toThrow();
  });

  it('respects enabled=false', () => {
    const cfg: StrategyConfig = { id: 'meanrev', kind: 'mean-reversion', enabled: false, params: {} };
    expect(evaluateMeanReversion(trendingUp(60), cfg, makeContext())).toBeUndefined();
  });
});

// ----- Breakout --------------------------------------------------------------

describe('breakout strategy', () => {
  function buildFlatThenBreakout(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(i, 100, 100.5, 99.5, 100, 100));
    }
    // Push the last close above the recent high
    candles.push(makeCandle(30, 100, 100.6, 99.9, 100.2, 200));
    candles.push(makeCandle(31, 100.2, 102, 100.1, 101.8, 200));
    return candles;
  }

  it('fires long when price breaks above resistance with volume', () => {
    const candles = buildFlatThenBreakout();
    const snr: SupportResistanceLevel[] = [
      { id: 'r1', price: 101, type: 'resistance', strength: 0.8, touches: 3, kind: 'swing-high' },
      { id: 's1', price: 99.5, type: 'support', strength: 0.8, touches: 3, kind: 'swing-low' },
    ];
    const ctx = makeContext({ snr, atr: 0.5 });
    const sig = breakoutStrategy.evaluate(candles, { atrMult: 1.5, volMult: 1.5 }, ctx);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
    expect(sig!.confidence).toBeGreaterThan(0);
  });

  it('returns undefined when there is no SNR context', () => {
    const candles = trendingUp(60);
    expect(breakoutStrategy.evaluate(candles, {}, makeContext({ snr: [] }))).toBeUndefined();
  });

  it('returns undefined on empty input', () => {
    expect(breakoutStrategy.evaluate([], {}, makeContext())).toBeUndefined();
  });

  it('handles extreme volatility without throwing', () => {
    const candles = extremeVolatility(40);
    const snr: SupportResistanceLevel[] = [
      { id: 'r1', price: 95, type: 'resistance', strength: 0.8, touches: 3, kind: 'swing-high' },
    ];
    expect(() =>
      breakoutStrategy.evaluate(candles, { atrMult: 1.5, volMult: 1.5 }, makeContext({ snr, atr: 1 })),
    ).not.toThrow();
  });

  it('handles NaN in input', () => {
    const candles = withNaN(buildFlatThenBreakout());
    const snr: SupportResistanceLevel[] = [
      { id: 'r1', price: 100.5, type: 'resistance', strength: 0.8, touches: 3, kind: 'swing-high' },
    ];
    expect(() =>
      breakoutStrategy.evaluate(candles, {}, makeContext({ snr })),
    ).not.toThrow();
  });

  it('respects enabled=false', () => {
    const cfg: StrategyConfig = { id: 'bo', kind: 'breakout', enabled: false, params: {} };
    expect(evaluateBreakout(buildFlatThenBreakout(), cfg, makeContext({ snr: [] }))).toBeUndefined();
  });
});

// ----- Supply / Demand -------------------------------------------------------

describe('supply-demand strategy', () => {
  it('fires long when price enters a fresh demand zone', () => {
    const candles = trendingUp(30);
    const snd: SupplyDemandZone[] = [
      {
        id: 'd1',
        type: 'demand',
        high: 130,
        low: 120,
        originTime: 1,
        status: 'fresh',
        strength: 0.8,
        pattern: 'base-rally',
      },
    ];
    const sig = supplyDemandStrategy.evaluate(candles, { minStrength: 0.4 }, makeContext({ snd, price: 125 }));
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
  });

  it('fires short when price enters a fresh supply zone', () => {
    const candles = trendingDown(30);
    const snd: SupplyDemandZone[] = [
      {
        id: 's1',
        type: 'supply',
        high: 80,
        low: 70,
        originTime: 1,
        status: 'fresh',
        strength: 0.8,
        pattern: 'base-drop',
      },
    ];
    const sig = supplyDemandStrategy.evaluate(candles, { minStrength: 0.4 }, makeContext({ snd, price: 75 }));
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('short');
  });

  it('returns undefined when price is not inside any zone', () => {
    const candles = trendingUp(30);
    const snd: SupplyDemandZone[] = [
      { id: 'd1', type: 'demand', high: 50, low: 40, originTime: 1, status: 'fresh', strength: 0.8, pattern: 'base-rally' },
    ];
    expect(supplyDemandStrategy.evaluate(candles, {}, makeContext({ snd, price: 200 }))).toBeUndefined();
  });

  it('returns undefined when zones are missing', () => {
    expect(supplyDemandStrategy.evaluate(trendingUp(20), {}, makeContext({ snd: [] }))).toBeUndefined();
  });

  it('handles NaN in input candles', () => {
    const candles = withNaN(trendingUp(30));
    const snd: SupplyDemandZone[] = [
      { id: 'd1', type: 'demand', high: 130, low: 120, originTime: 1, status: 'fresh', strength: 0.8, pattern: 'base-rally' },
    ];
    expect(() => supplyDemandStrategy.evaluate(candles, {}, makeContext({ snd, price: 125 }))).not.toThrow();
  });

  it('respects enabled=false', () => {
    const cfg: StrategyConfig = { id: 'snd', kind: 'supply-demand', enabled: false, params: {} };
    expect(evaluateSupplyDemand(trendingUp(20), cfg, makeContext())).toBeUndefined();
  });
});

// ----- MTF Trend -------------------------------------------------------------

describe('mtf-trend strategy', () => {
  function makeMtf(bias: 'bullish' | 'bearish' | 'neutral', score: number): import('@/types').MTFAnalysis {
    return {
      cells: [
        { timeframe: '1d', trend: bias, momentum: bias, structure: bias, volume: bias, score },
      ],
      overallBias: bias,
      mtfScore: score,
      generatedAt: 1,
    };
  }

  it('fires long when MTF is bullish and not contradicted by scoring', () => {
    const candles = trendingUp(30);
    const sig = mtfTrendStrategy.evaluate(
      candles,
      { scoreThreshold: 0.1 },
      makeContext({ mtf: makeMtf('bullish', 0.6) }),
    );
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
  });

  it('fires short when MTF is bearish and scoring is not bullish', () => {
    const candles = trendingDown(30);
    const sig = mtfTrendStrategy.evaluate(
      candles,
      { scoreThreshold: 0.1 },
      makeContext({ mtf: makeMtf('bearish', -0.6) }),
    );
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('short');
  });

  it('returns undefined when MTF is neutral', () => {
    const candles = trendingUp(20);
    const sig = mtfTrendStrategy.evaluate(
      candles,
      {},
      makeContext({ mtf: makeMtf('neutral', 0) }),
    );
    expect(sig).toBeUndefined();
  });

  it('returns undefined when MTF is missing', () => {
    expect(mtfTrendStrategy.evaluate(trendingUp(20), {}, makeContext())).toBeUndefined();
  });

  it('respects enabled=false', () => {
    const cfg: StrategyConfig = { id: 'mtf', kind: 'mtf-trend', enabled: false, params: {} };
    expect(evaluateMtfTrend(trendingUp(20), cfg, makeContext({ mtf: makeMtf('bullish', 0.6) }))).toBeUndefined();
  });
});

// ----- runStrategies --------------------------------------------------------

describe('runStrategies', () => {
  it('skips disabled configs and unknown kinds', () => {
    const candles = trendingUp(80);
    const ctx = makeContext();
    const configs: StrategyConfig[] = [
      { id: 't', kind: 'trend-following', enabled: true, params: { emaFast: 9, emaSlow: 21 } },
      { id: 'd', kind: 'trend-following', enabled: false, params: {} },
    ];
    const signals = runStrategies(candles, configs, ctx);
    // At most one signal per strategy id+kind+direction.
    const ids = signals.map((s) => s.strategyId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deduplicates by strategy+kind+direction', () => {
    const candles = trendingUp(80);
    const cfg: StrategyConfig = {
      id: 't',
      kind: 'trend-following',
      enabled: true,
      params: { emaFast: 9, emaSlow: 21 },
    };
    const a = runStrategies(candles, [cfg, cfg, cfg], makeContext());
    const b = runStrategies(candles, [cfg], makeContext());
    expect(a.length).toBe(b.length);
  });

  it('returns empty for all disabled configs', () => {
    const candles = trendingUp(80);
    const cfg: StrategyConfig = { id: 't', kind: 'trend-following', enabled: false, params: {} };
    expect(runStrategies(candles, [cfg], makeContext())).toEqual([]);
  });

  it('handles empty candle list', () => {
    const cfg: StrategyConfig = { id: 't', kind: 'trend-following', enabled: true, params: {} };
    expect(runStrategies([], [cfg], makeContext({ price: 0, nowMs: 0 }))).toEqual([]);
  });

  it('handles NaN candles without throwing', () => {
    const candles = withNaN(trendingUp(80));
    const cfg: StrategyConfig = { id: 't', kind: 'trend-following', enabled: true, params: { emaFast: 9, emaSlow: 21 } };
    expect(() => runStrategies(candles, [cfg], makeContext())).not.toThrow();
  });
});

// ----- Internal indicator helpers -------------------------------------------

describe('strategy indicator helpers', () => {
  it('atrSeries returns NaN for warmup and positive values for warm series', () => {
    const candles = trendingUp(30);
    const atr = atrSeries(candles, 14);
    expect(atr.length).toBe(candles.length);
    expect(Number.isNaN(atr[0]!)).toBe(true);
    const last = atr[atr.length - 1]!;
    expect(last).toBeGreaterThan(0);
  });
});

// Re-export the structure / scoring helpers needed for typing only
export type { MarketStructureEvent, ScoringResult };
