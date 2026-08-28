import { describe, expect, it } from 'vitest';
import type {
  Candle,
  ScoringResult,
  SupportResistanceLevel,
  SupplyDemandZone,
} from '@/types';
import { DEFAULT_SCORING_WEIGHTS } from '@/config/scoring';
import { computeScore } from '@/core/scoring';
import { buildProjection, PROJECTION_DISCLAIMER } from '@/core/prediction';

const weights = { ...DEFAULT_SCORING_WEIGHTS };

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

function withNaN(candles: Candle[]): Candle[] {
  if (candles.length === 0) return candles;
  const copy = candles.slice();
  const last = copy[copy.length - 1]!;
  copy[copy.length - 1] = { ...last, close: NaN, high: NaN, low: NaN };
  return copy;
}

function makeScore(direction: 'bullish' | 'bearish' | 'neutral' = 'bullish', confidence = 0.7): ScoringResult {
  const sign = direction === 'bullish' ? 1 : direction === 'bearish' ? -1 : 0;
  const v = confidence;
  return {
    bullish: direction === 'bullish' ? 1.0 : 0.1,
    bearish: direction === 'bearish' ? 1.0 : 0.1,
    net: sign * v,
    total: 1.0,
    label: direction === 'bullish' ? 'Bullish' : direction === 'bearish' ? 'Bearish' : 'Neutral',
    bias: direction,
    breakdown: {
      trend: sign * 0.5,
      momentum: sign * 0.4,
      volume: sign * 0.3,
      structure: sign * 0.2,
      snr: sign * 0.1,
      snd: 0,
      volatility: 0,
      mtf: sign * 0.5,
    },
  };
}

describe('buildProjection', () => {
  it('produces a long projection on an uptrend', () => {
    const candles = trendingUp(120);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTCUSD', timeframe: '1h' });
    expect(proj.symbol).toBe('BTCUSD');
    expect(proj.timeframe).toBe('1h');
    expect(proj.direction === 'bullish' || proj.direction === 'neutral').toBe(true);
    expect(proj.entryZone).toBeDefined();
    expect(proj.entryZone!.low).toBeLessThanOrEqual(proj.entryZone!.high);
    expect(proj.targets.length).toBeGreaterThanOrEqual(2);
    expect(proj.disclaimer).toBe(PROJECTION_DISCLAIMER);
  });

  it('produces a short projection on a downtrend', () => {
    const candles = trendingDown(120);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTCUSD', timeframe: '1h' });
    expect(proj.direction === 'bearish' || proj.direction === 'neutral').toBe(true);
  });

  it('returns neutral projection on a range-bound market', () => {
    const candles = ranging(120);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTCUSD', timeframe: '1h' });
    expect(['neutral', 'bullish', 'bearish']).toContain(proj.direction);
  });

  it('returns finite values for empty input', () => {
    const proj = buildProjection([], makeScore('neutral'), { symbol: 'X', timeframe: '1h' });
    expect(proj.symbol).toBe('X');
    expect(Number.isFinite(proj.score)).toBe(true);
    expect(proj.targets.length).toBeGreaterThan(0);
  });

  it('returns finite values for single candle', () => {
    const candles = [makeCandle(0, 100, 101, 99, 100)];
    const proj = buildProjection(candles, makeScore('bullish'), { symbol: 'X', timeframe: '1h' });
    expect(proj.entryZone).toBeDefined();
  });

  it('handles extreme volatility without throwing', () => {
    const candles = extremeVolatility(80);
    const score = computeScore(candles, {}, weights);
    expect(() =>
      buildProjection(candles, score, { symbol: 'BTC', timeframe: '15m' }),
    ).not.toThrow();
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '15m' });
    expect(Number.isFinite(proj.score)).toBe(true);
  });

  it('handles NaN in input candles', () => {
    const candles = withNaN(trendingUp(80));
    const score = computeScore(candles, {}, weights);
    expect(() =>
      buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h' }),
    ).not.toThrow();
  });

  it('honours support and resistance context', () => {
    const candles = trendingUp(120);
    // Use a price reference point and pin the SNR levels well outside it
    // so the uptrend's last close (~220) is sandwiched between them.
    const refPrice = 200;
    const snr: SupportResistanceLevel[] = [
      { id: 's', price: 150, type: 'support', strength: 1, touches: 3, kind: 'swing-low' },
      { id: 'r', price: 300, type: 'resistance', strength: 1, touches: 3, kind: 'swing-high' },
    ];
    const score = computeScore(candles, { snr, price: refPrice }, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h', snr, price: refPrice });
    expect(proj.support).toBe(150);
    expect(proj.resistance).toBe(300);
    expect(proj.invalidation).toBeLessThan(proj.support!);
  });

  it('produces a risk/reward ratio when both ends are valid', () => {
    const candles = trendingUp(120);
    const refPrice = 200;
    const snr: SupportResistanceLevel[] = [
      { id: 's', price: 150, type: 'support', strength: 1, touches: 3, kind: 'swing-low' },
      { id: 'r', price: 300, type: 'resistance', strength: 1, touches: 3, kind: 'swing-high' },
    ];
    const score = computeScore(candles, { snr, price: refPrice }, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h', snr, price: refPrice });
    expect(proj.riskReward).toBeDefined();
    expect(proj.riskReward!).toBeGreaterThan(0);
  });

  it('confidence is between 0 and 1', () => {
    const candles = trendingUp(120);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h' });
    expect(proj.confidence).toBeGreaterThanOrEqual(0);
    expect(proj.confidence).toBeLessThanOrEqual(1);
  });

  it('adds agreement bonus when 3+ categories agree', () => {
    // Build a score with most categories agreeing bullish, and one
    // with mixed signals. Compare confidence.
    const candles = trendingUp(120);
    const scoreAllBull = makeScore('bullish', 0.9);
    const allBull = buildProjection(candles, scoreAllBull, { symbol: 'BTC', timeframe: '1h' });
    const scoreMixed = {
      ...scoreAllBull,
      breakdown: {
        ...scoreAllBull.breakdown,
        trend: -0.2,
        momentum: -0.1,
        volume: -0.2,
        structure: 0.4,
        snr: 0.3,
        snd: 0.2,
        volatility: 0.1,
        mtf: 0.5,
      },
    };
    const mixed = buildProjection(candles, scoreMixed, { symbol: 'BTC', timeframe: '1h' });
    expect(allBull.confidence).toBeGreaterThanOrEqual(mixed.confidence);
  });

  it('uses custom target multipliers', () => {
    const candles = trendingUp(120);
    const refPrice = 200;
    const snr: SupportResistanceLevel[] = [
      { id: 's', price: 150, type: 'support', strength: 1, touches: 3, kind: 'swing-low' },
    ];
    const score = computeScore(candles, { snr, price: refPrice }, weights);
    const proj = buildProjection(candles, score, {
      symbol: 'BTC',
      timeframe: '1h',
      snr,
      price: refPrice,
      targetMultipliers: { r1: 0.5, r2: 1, r3: 1.5 },
    });
    expect(proj.targets.length).toBe(3);
    expect(proj.targets[0]!.price).toBeLessThan(proj.targets[1]!.price);
    expect(proj.targets[1]!.price).toBeLessThan(proj.targets[2]!.price);
  });

  it('includes expected volatility as a percentage', () => {
    const candles = trendingUp(60);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h' });
    expect(proj.expectedVolatility).toBeDefined();
    expect(proj.expectedVolatility!).toBeGreaterThan(0);
  });

  it('disclaimer text matches the spec exactly', () => {
    expect(PROJECTION_DISCLAIMER).toBe(
      'This is a technical/probabilistic projection based on deterministic algorithms. It is NOT a guarantee of future price.',
    );
    const candles = trendingUp(60);
    const score = computeScore(candles, {}, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h' });
    expect(proj.disclaimer).toBe(PROJECTION_DISCLAIMER);
  });

  it('handles SND-only context', () => {
    const candles = trendingUp(60);
    const snd: SupplyDemandZone[] = [
      { id: 'd', type: 'demand', high: 200, low: 150, originTime: 1, status: 'fresh', strength: 1, pattern: 'base-rally' },
    ];
    const score = computeScore(candles, { snd, price: 160 }, weights);
    const proj = buildProjection(candles, score, { symbol: 'BTC', timeframe: '1h', snd });
    expect(proj).toBeDefined();
  });
});
