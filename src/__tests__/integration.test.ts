// Integration tests for the data pipeline.
//
// Each `describe` block exercises one end-to-end scenario that
// threads the public surface of the engine. The goal is to verify
// the modules cooperate correctly — e.g. that `aggregateCandles`
// feeds sane input into `computeScore` — not to re-test the
// internals (which already have their own dedicated files).

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
import { aggregateCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';
import { DEFAULT_SCORING_WEIGHTS } from '@/config/scoring';
import { computeScore } from '@/core/scoring';
import { runStrategies } from '@/core/strategies';
import { analyzeMTF, type DataFetcher } from '@/core/mtf';
import { buildProjection } from '@/core/prediction';
import { extensionLevels, manualFibonacci } from '@/core/fibonacci';
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

/** Build a snapshot of N 1-minute candles aligned to a wall clock. */
function oneMinuteCandles(n: number, start = 100, step = 0.5): Candle[] {
  const out: Candle[] = [];
  // Anchor to a 1-hour boundary so 1m / 5m / 15m / 1h buckets all align.
  // 1_699_999_200 is divisible by 60, 300, 900 and 3600.
  const anchor = 1_699_999_200;
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push(
      makeCandle(anchor + i * 60, c, c + 0.2, c - 0.2, c, 100 + (i % 20)),
    );
  }
  return out;
}

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

const fibConfig: FibConfig = {
  retracements: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  extensions: [1, 1.272, 1.618, 2, 2.618],
  auto: true,
};

const weights = { ...DEFAULT_SCORING_WEIGHTS };

// ---------------------------------------------------------------------------
// aggregateCandles pipeline
// ---------------------------------------------------------------------------

describe('integration: aggregateCandles across timeframes', () => {
  it('aggregates 1m candles into 5m buckets', () => {
    const oneMin = oneMinuteCandles(15); // 15 minutes of 1m bars
    const five = aggregateCandles(oneMin, '5m');
    // 15 minutes / 5 minutes per bucket = 3 buckets (assuming alignment).
    expect(five.length).toBeGreaterThan(0);
    expect(five.length).toBeLessThanOrEqual(3);
    for (const c of five) {
      expect(c.time % 300).toBe(0); // bucket start on a 5m boundary
    }
  });

  it('aggregates 1m candles into 15m buckets', () => {
    const oneMin = oneMinuteCandles(45); // 45 minutes
    const fifteen = aggregateCandles(oneMin, '15m');
    expect(fifteen.length).toBeGreaterThan(0);
    for (const c of fifteen) {
      expect(c.time % 900).toBe(0); // bucket start on a 15m boundary
    }
  });

  it('aggregates 1m candles into 1h buckets', () => {
    const oneMin = oneMinuteCandles(130); // ~2h 10m
    const hourly = aggregateCandles(oneMin, '1h');
    expect(hourly.length).toBeGreaterThan(0);
    for (const c of hourly) {
      expect(c.time % 3600).toBe(0); // bucket start on a 1h boundary
    }
  });

  it('preserves high/low extremes and cumulative volume within each bucket', () => {
    // 6 1m candles -> 2 5m buckets (1m boundaries at 0, 60, ..., 300 sec,
    // 5m boundary at 300 sec starts a new bucket).
    const oneMin = oneMinuteCandles(6, 100, 1);
    const five = aggregateCandles(oneMin, '5m');
    expect(five.length).toBe(2);
    // First bucket covers candles 0..4 (anchor..anchor+5m, exclusive of
    // anchor+5m which starts a new bucket).
    const slice0 = oneMin.slice(0, 5);
    const bucket0 = five[0]!;
    expect(bucket0.high).toBeCloseTo(Math.max(...slice0.map((c) => c.high)), 6);
    expect(bucket0.low).toBeCloseTo(Math.min(...slice0.map((c) => c.low)), 6);
    expect(bucket0.volume).toBeCloseTo(
      slice0.reduce((acc, c) => acc + c.volume, 0),
      6,
    );
    // Close of the bucket is the close of the last candle in the slice.
    expect(bucket0.close).toBe(slice0[slice0.length - 1]!.close);
    // Second bucket contains the 6th candle alone.
    const slice1 = oneMin.slice(5);
    const bucket1 = five[1]!;
    expect(bucket1.high).toBeCloseTo(slice1[0]!.high, 6);
    expect(bucket1.low).toBeCloseTo(slice1[0]!.low, 6);
    expect(bucket1.close).toBe(slice1[0]!.close);
  });
});

// ---------------------------------------------------------------------------
// Heatmap pipeline: synthesize -> apply -> totals
// ---------------------------------------------------------------------------

describe('integration: synthesizeHeatmap + applyLiquidationEvent', () => {
  it('updates totalLongLiq after applyLiquidationEvent with a long event', () => {
    const snap = makeSnapshot({
      markPrice: 100_000,
      openInterestUsd: 1_000_000_000,
      longShortRatio: 1,
    });
    const base = synthesizeHeatmap(snap, {
      symbol: 'BTCUSDT',
      stepPct: 1,
      rangePct: 5,
    });
    const longBefore = base.totalLongLiq;
    const ev: LiquidationEvent = {
      time: Date.now(),
      symbol: 'BTCUSDT',
      side: 'long',
      price: 99_000,
      quantity: 0.5,
      notional: 49_500,
    };
    const updated = applyLiquidationEvent(base, ev);
    // Totals reflect the new event.
    expect(updated.totalLongLiq).toBeGreaterThan(longBefore);
    expect(updated.totalLongLiq).toBeCloseTo(longBefore + ev.notional, 1);
    // Source switches to live once we have at least one real event.
    expect(updated.source).toBe('live');
    expect(updated.recentEvents[0]).toEqual(ev);
  });

  it('updates totalShortLiq after applyLiquidationEvent with a short event', () => {
    const snap = makeSnapshot({
      markPrice: 100_000,
      openInterestUsd: 1_000_000_000,
      longShortRatio: 1,
    });
    const base = synthesizeHeatmap(snap, {
      symbol: 'BTCUSDT',
      stepPct: 1,
      rangePct: 5,
    });
    const shortBefore = base.totalShortLiq;
    const ev: LiquidationEvent = {
      time: Date.now(),
      symbol: 'BTCUSDT',
      side: 'short',
      price: 101_000,
      quantity: 0.4,
      notional: 40_400,
    };
    const updated = applyLiquidationEvent(base, ev);
    expect(updated.totalShortLiq).toBeGreaterThan(shortBefore);
    expect(updated.totalShortLiq).toBeCloseTo(shortBefore + ev.notional, 1);
  });

  it('accumulates multiple liquidation events into the totals', () => {
    const snap = makeSnapshot({
      markPrice: 100_000,
      openInterestUsd: 1_000_000_000,
      longShortRatio: 1,
    });
    let heatmap = synthesizeHeatmap(snap, {
      symbol: 'BTCUSDT',
      stepPct: 1,
      rangePct: 5,
    });
    const longBase = heatmap.totalLongLiq;
    const shortBase = heatmap.totalShortLiq;
    const events: LiquidationEvent[] = [
      { time: 1, symbol: 'BTCUSDT', side: 'long', price: 99_000, quantity: 0.1, notional: 9_900 },
      { time: 2, symbol: 'BTCUSDT', side: 'long', price: 98_500, quantity: 0.2, notional: 19_700 },
      { time: 3, symbol: 'BTCUSDT', side: 'short', price: 101_500, quantity: 0.3, notional: 30_450 },
    ];
    for (const e of events) {
      heatmap = applyLiquidationEvent(heatmap, e);
    }
    const longAdded = events
      .filter((e) => e.side === 'long')
      .reduce((a, e) => a + e.notional, 0);
    const shortAdded = events
      .filter((e) => e.side === 'short')
      .reduce((a, e) => a + e.notional, 0);
    expect(heatmap.totalLongLiq).toBeCloseTo(longBase + longAdded, 1);
    expect(heatmap.totalShortLiq).toBeCloseTo(shortBase + shortAdded, 1);
    // Recent events are recorded in order (most recent first).
    expect(heatmap.recentEvents.length).toBe(events.length);
  });
});

// ---------------------------------------------------------------------------
// computeScore pipeline
// ---------------------------------------------------------------------------

describe('integration: computeScore (computeScoring) bullish/bearish series', () => {
  it('produces a bullish label on a strong uptrend', () => {
    const r = computeScore(trendingUp(120, 100, 1), {}, weights);
    expect(r.bias).toBe('bullish');
    expect(r.bullish).toBeGreaterThan(r.bearish);
    expect(['Strong Bullish', 'Bullish', 'Weak Bullish']).toContain(r.label);
    expect(r.net).toBeGreaterThan(0);
  });

  it('produces a bearish label on a strong downtrend', () => {
    const r = computeScore(trendingDown(120, 200, 1), {}, weights);
    expect(r.bias).toBe('bearish');
    expect(r.bearish).toBeGreaterThan(r.bullish);
    expect(['Strong Bearish', 'Bearish', 'Weak Bearish']).toContain(r.label);
    expect(r.net).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// runStrategies pipeline
// ---------------------------------------------------------------------------

describe('integration: runStrategies empty/disabled', () => {
  it('returns [] for empty candle input', () => {
    const configs: StrategyConfig[] = [
      { id: 't', kind: 'trend-following', enabled: true, params: { emaFast: 9, emaSlow: 21 } },
      { id: 'b', kind: 'breakout', enabled: true, params: {} },
    ];
    const signals = runStrategies([], configs, {});
    expect(signals).toEqual([]);
  });

  it('returns [] when every config is disabled', () => {
    const candles = trendingUp(80);
    const configs: StrategyConfig[] = [
      { id: 't', kind: 'trend-following', enabled: false, params: {} },
      { id: 'b', kind: 'breakout', enabled: false, params: {} },
      { id: 'm', kind: 'mean-reversion', enabled: false, params: {} },
    ];
    expect(runStrategies(candles, configs, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeMTF pipeline
// ---------------------------------------------------------------------------

describe('integration: analyzeMTF with synthetic data', () => {
  it('produces cells with valid biases for an uptrend dataset', async () => {
    const fetcher = new StaticFetcher({
      '1d': trendingUp(120, 100, 1, 1000),
      '4h': trendingUp(120, 100, 1, 800),
      '1h': trendingUp(120, 100, 0.5, 500),
    });
    const result = await analyzeMTF('BTCUSDT', ['1d', '4h', '1h'], fetcher, {});
    expect(result.cells.length).toBe(3);
    for (const cell of result.cells) {
      expect(['bullish', 'bearish', 'neutral']).toContain(cell.trend);
      expect(['bullish', 'bearish', 'neutral']).toContain(cell.momentum);
      expect(['bullish', 'bearish', 'neutral']).toContain(cell.structure);
      expect(['bullish', 'bearish', 'neutral']).toContain(cell.volume);
      expect(Number.isFinite(cell.score)).toBe(true);
      expect(cell.score).toBeGreaterThanOrEqual(-1);
      expect(cell.score).toBeLessThanOrEqual(1);
    }
    expect(['bullish', 'bearish', 'neutral']).toContain(result.overallBias);
    expect(Number.isFinite(result.mtfScore)).toBe(true);
  });

  it('produces a bearish overall bias for a downtrend dataset', async () => {
    const fetcher = new StaticFetcher({
      '1d': trendingDown(120, 300, 1, 1000),
      '4h': trendingDown(120, 300, 1, 800),
    });
    const result = await analyzeMTF('BTCUSDT', ['1d', '4h'], fetcher, {});
    expect(result.cells.length).toBe(2);
    expect(result.overallBias).toBe('bearish');
    expect(result.mtfScore).toBeLessThan(0);
  });

  it('handles a fetcher that throws by using empty candles', async () => {
    class ThrowingFetcher implements DataFetcher {
      async fetchCandles(): Promise<Candle[]> {
        throw new Error('network down');
      }
    }
    const result = await analyzeMTF('BTCUSDT', ['1h', '4h'], new ThrowingFetcher(), {});
    expect(result.cells.length).toBe(2);
    for (const cell of result.cells) {
      // Cells are populated even on failure (just neutral).
      expect(cell.score).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildProjection pipeline
// ---------------------------------------------------------------------------

describe('integration: buildProjection from a strong-bullish score', () => {
  it('produces a bullish projection with targets above current price', () => {
    const candles = trendingUp(120, 100, 1);
    const score = computeScore(candles, {}, weights);
    expect(score.bias).toBe('bullish');
    const lastClose = candles[candles.length - 1]!.close;
    const proj = buildProjection(candles, score, {
      symbol: 'BTCUSD',
      timeframe: '1h',
      price: lastClose,
    });
    expect(proj.direction).toBe('bullish');
    expect(proj.entryZone).toBeDefined();
    // Entry zone is around the supplied price.
    expect(proj.entryZone!.low).toBeLessThan(lastClose);
    expect(proj.entryZone!.high).toBeGreaterThan(lastClose);
    // Targets are above current price for a bullish projection.
    expect(proj.targets.length).toBeGreaterThan(0);
    for (const t of proj.targets) {
      expect(t.price).toBeGreaterThan(lastClose);
    }
    // Confidence is bounded.
    expect(proj.confidence).toBeGreaterThan(0);
    expect(proj.confidence).toBeLessThanOrEqual(1);
    // R/R ratio is positive when there is a valid TP and invalidation.
    if (proj.riskReward !== undefined) {
      expect(proj.riskReward).toBeGreaterThan(0);
    }
  });

  it('invalidation sits below current price for a bullish setup', () => {
    const candles = trendingUp(120, 100, 1);
    const score = computeScore(candles, {}, weights);
    const lastClose = candles[candles.length - 1]!.close;
    const proj = buildProjection(candles, score, {
      symbol: 'BTCUSD',
      timeframe: '1h',
      price: lastClose,
    });
    if (proj.invalidation !== undefined) {
      expect(proj.invalidation).toBeLessThan(lastClose);
    }
  });
});

// ---------------------------------------------------------------------------
// Fibonacci pipeline
// ---------------------------------------------------------------------------

describe('integration: manualFibonacci and extensionLevels', () => {
  it('manualFibonacci returns documented retracement levels', () => {
    const result = manualFibonacci({ price: 100 }, { price: 200 }, 'up', fibConfig);
    expect(result.high).toBe(200);
    expect(result.low).toBe(100);
    expect(result.range).toBe(100);
    // One retracement per configured ratio.
    expect(result.retracements.length).toBe(fibConfig.retracements.length);
    // 0.0 -> high, 1.0 -> low (per spec: high - (high - low) * r).
    const r0 = result.retracements.find((l) => l.ratio === 0);
    const r1 = result.retracements.find((l) => l.ratio === 1);
    expect(r0!.price).toBe(200);
    expect(r1!.price).toBe(100);
    // 0.5 retracement is the midpoint.
    const r05 = result.retracements.find((l) => l.ratio === 0.5);
    expect(r05!.price).toBe(150);
  });

  it('extensionLevels projects upward from a higher p2', () => {
    const levels = extensionLevels(100, 200, [1, 1.618, 2], 'up');
    expect(levels.length).toBe(3);
    // p2 + (p2 - p1) * ratio: 200 + 100*r
    expect(levels[0]!.price).toBeCloseTo(300, 6);
    expect(levels[1]!.price).toBeCloseTo(361.8, 5);
    expect(levels[2]!.price).toBeCloseTo(400, 6);
  });

  it('extensionLevels projects downward from a lower p2', () => {
    const levels = extensionLevels(200, 100, [1, 1.618, 2], 'down');
    expect(levels.length).toBe(3);
    // p2 - (p1 - p2) * ratio
    expect(levels[0]!.price).toBeCloseTo(0, 6);
    expect(levels[1]!.price).toBeCloseTo(-61.8, 5);
    expect(levels[2]!.price).toBeCloseTo(-100, 6);
  });

  it('manualFibonacci honors SNR-style anchors for an up move', () => {
    const snr: SupportResistanceLevel[] = [
      { id: 's', price: 100, type: 'support', strength: 1, touches: 3, kind: 'swing-low' },
      { id: 'r', price: 200, type: 'resistance', strength: 1, touches: 3, kind: 'swing-high' },
    ];
    const [low, high] = [snr[0]!, snr[1]!];
    const result = manualFibonacci(
      { price: low.price },
      { price: high.price },
      'up',
      fibConfig,
    );
    // Extensions should sit above the high for an up direction.
    for (const ext of result.extensions) {
      expect(ext.price).toBeGreaterThan(high.price);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-pipeline: scoring + fibonacci + projection
// ---------------------------------------------------------------------------

describe('integration: scoring -> projection -> fibonacci end-to-end', () => {
  it('passes a bullish score, projection, and fib extensions through the same dataset', () => {
    const candles = trendingUp(120, 100, 1);
    const score = computeScore(candles, {}, weights);
    expect(score.bias).toBe('bullish');
    const lastClose = candles[candles.length - 1]!.close;
    const proj = buildProjection(candles, score, {
      symbol: 'BTCUSD',
      timeframe: '1h',
      price: lastClose,
    });
    const fib = manualFibonacci(
      { price: candles[0]!.close },
      { price: lastClose },
      'up',
      fibConfig,
    );
    // All three modules produce numeric output without throwing.
    expect(isFiniteNum(proj.score)).toBe(true);
    expect(fib.range).toBeGreaterThan(0);
    // At least one fib extension is above the projection's first target.
    const projTp1 = proj.targets[0]?.price ?? lastClose;
    const hasHigherExt = fib.extensions.some((e) => e.price > projTp1);
    expect(hasHigherExt).toBe(true);
  });
});
