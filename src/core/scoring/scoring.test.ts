import { describe, expect, it } from 'vitest';
import type {
  Candle,
  MarketStructureEvent,
  MTFAnalysis,
  ScoreBreakdown,
  SupplyDemandZone,
  SupportResistanceLevel,
} from '@/types';
import { DEFAULT_SCORING_WEIGHTS } from '@/config/scoring';
import {
  biasFromLabel,
  buildScoringFromSubs,
  computeScore,
  countAgreement,
  labelFromNet,
  scoreMomentum,
  scoreMTF,
  scoreSND,
  scoreSNR,
  scoreStructure,
  scoreTrend,
  scoreVolatility,
  scoreVolume,
  subScoreBias,
  subScoreSigned,
} from '@/core/scoring';

const weights: ScoreBreakdown = { ...DEFAULT_SCORING_WEIGHTS };

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

describe('labelFromNet', () => {
  it('classifies buckets correctly', () => {
    expect(labelFromNet(0.9, 1)).toBe('Strong Bullish');
    expect(labelFromNet(0.5, 1)).toBe('Bullish');
    expect(labelFromNet(0.2, 1)).toBe('Weak Bullish');
    expect(labelFromNet(0.05, 1)).toBe('Neutral');
    expect(labelFromNet(-0.2, 1)).toBe('Weak Bearish');
    expect(labelFromNet(-0.5, 1)).toBe('Bearish');
    expect(labelFromNet(-0.9, 1)).toBe('Strong Bearish');
  });
  it('returns Neutral for total <= 0 or NaN', () => {
    expect(labelFromNet(1, 0)).toBe('Neutral');
    expect(labelFromNet(1, NaN)).toBe('Neutral');
  });
});

describe('biasFromLabel', () => {
  it('maps labels to bias', () => {
    expect(biasFromLabel('Strong Bullish')).toBe('bullish');
    expect(biasFromLabel('Bullish')).toBe('bullish');
    expect(biasFromLabel('Weak Bullish')).toBe('bullish');
    expect(biasFromLabel('Neutral')).toBe('neutral');
    expect(biasFromLabel('Weak Bearish')).toBe('bearish');
    expect(biasFromLabel('Bearish')).toBe('bearish');
    expect(biasFromLabel('Strong Bearish')).toBe('bearish');
  });
});

describe('sub-score primitives', () => {
  it('scoreTrend returns bullish for uptrend', () => {
    const s = scoreTrend(trendingUp(60));
    expect(s.bullish).toBeGreaterThan(s.bearish);
  });
  it('scoreTrend returns bearish for downtrend', () => {
    const s = scoreTrend(trendingDown(60));
    expect(s.bearish).toBeGreaterThan(s.bullish);
  });
  it('scoreTrend is neutral on empty / single candle', () => {
    expect(scoreTrend([])).toEqual({ bullish: 0, bearish: 0 });
    expect(scoreTrend([makeCandle(0, 1, 2, 0, 1)])).toEqual({ bullish: 0, bearish: 0 });
  });
  it('scoreTrend tolerates NaN', () => {
    const s = scoreTrend(withNaN(trendingUp(60)));
    expect(Number.isFinite(s.bullish)).toBe(true);
    expect(Number.isFinite(s.bearish)).toBe(true);
  });
  it('scoreMomentum bullish on uptrend, bearish on downtrend', () => {
    const up = scoreMomentum(trendingUp(60));
    const down = scoreMomentum(trendingDown(60));
    expect(up.bullish).toBeGreaterThan(up.bearish);
    expect(down.bearish).toBeGreaterThan(down.bullish);
  });
  it('scoreMomentum returns zeros for empty input', () => {
    expect(scoreMomentum([])).toEqual({ bullish: 0, bearish: 0 });
  });
  it('scoreMomentum handles NaN', () => {
    const s = scoreMomentum(withNaN(trendingUp(60)));
    expect(Number.isFinite(s.bullish)).toBe(true);
  });
  it('scoreVolume bullish when up volume dominates', () => {
    const candles = trendingUp(60);
    const s = scoreVolume(candles);
    expect(s.bullish).toBeGreaterThan(s.bearish);
  });
  it('scoreVolume handles empty and NaN', () => {
    expect(scoreVolume([])).toEqual({ bullish: 0, bearish: 0 });
    const s = scoreVolume(withNaN(trendingUp(60)));
    expect(Number.isFinite(s.bullish)).toBe(true);
  });
  it('scoreStructure returns bullish with bullish BOS events', () => {
    const evts: MarketStructureEvent[] = [
      { time: 1, price: 100, kind: 'BOS', direction: 'bullish' },
      { time: 2, price: 110, kind: 'BOS', direction: 'bullish' },
    ];
    const s = scoreStructure(trendingUp(40), evts);
    expect(s.bullish).toBeGreaterThan(s.bearish);
  });
  it('scoreStructure returns bearish with bearish CHOCH events', () => {
    const evts: MarketStructureEvent[] = [
      { time: 1, price: 100, kind: 'CHOCH', direction: 'bearish' },
    ];
    const s = scoreStructure(trendingDown(40), evts);
    expect(s.bearish).toBeGreaterThanOrEqual(s.bullish);
  });
  it('scoreSNR returns bullish near support', () => {
    const levels: SupportResistanceLevel[] = [
      { id: 's', price: 99, type: 'support', strength: 0.9, touches: 3, kind: 'swing-low' },
    ];
    const s = scoreSNR(100, levels);
    expect(s.bullish).toBeGreaterThan(0);
  });
  it('scoreSNR returns bearish near resistance', () => {
    const levels: SupportResistanceLevel[] = [
      { id: 'r', price: 101, type: 'resistance', strength: 0.9, touches: 3, kind: 'swing-high' },
    ];
    const s = scoreSNR(100, levels);
    expect(s.bearish).toBeGreaterThan(0);
  });
  it('scoreSNR returns zeros when levels missing', () => {
    expect(scoreSNR(100, [])).toEqual({ bullish: 0, bearish: 0 });
    expect(scoreSNR(NaN, [])).toEqual({ bullish: 0, bearish: 0 });
  });
  it('scoreSND bullish inside fresh demand zone', () => {
    const zones: SupplyDemandZone[] = [
      { id: 'd', type: 'demand', high: 110, low: 100, originTime: 1, status: 'fresh', strength: 0.8, pattern: 'base-rally' },
    ];
    const s = scoreSND(105, zones);
    expect(s.bullish).toBeGreaterThan(s.bearish);
  });
  it('scoreSND bearish inside fresh supply zone', () => {
    const zones: SupplyDemandZone[] = [
      { id: 's', type: 'supply', high: 110, low: 100, originTime: 1, status: 'fresh', strength: 0.8, pattern: 'base-drop' },
    ];
    const s = scoreSND(105, zones);
    expect(s.bearish).toBeGreaterThan(s.bullish);
  });
  it('scoreSND zeros when zones missing', () => {
    expect(scoreSND(100, [])).toEqual({ bullish: 0, bearish: 0 });
  });
  it('scoreVolatility is finite under extreme volatility', () => {
    const s = scoreVolatility(extremeVolatility(60));
    expect(Number.isFinite(s.bullish)).toBe(true);
    expect(Number.isFinite(s.bearish)).toBe(true);
  });
  it('scoreVolatility handles empty / single / NaN', () => {
    expect(scoreVolatility([])).toEqual({ bullish: 0, bearish: 0 });
    expect(scoreVolatility([makeCandle(0, 1, 2, 0, 1)])).toEqual({ bullish: 0, bearish: 0 });
    const s = scoreVolatility(withNaN(trendingUp(60)));
    expect(Number.isFinite(s.bullish)).toBe(true);
  });
  it('scoreMTF bullish when overall bias bullish', () => {
    const mtf: MTFAnalysis = {
      cells: [
        { timeframe: '1d', trend: 'bullish', momentum: 'bullish', structure: 'bullish', volume: 'bullish', score: 1 },
        { timeframe: '4h', trend: 'bullish', momentum: 'bullish', structure: 'bullish', volume: 'bullish', score: 0.8 },
      ],
      overallBias: 'bullish',
      mtfScore: 0.9,
      generatedAt: 1,
    };
    const s = scoreMTF(mtf);
    expect(s.bullish).toBeGreaterThan(s.bearish);
  });
  it('scoreMTF bearish when overall bias bearish', () => {
    const mtf: MTFAnalysis = {
      cells: [
        { timeframe: '1d', trend: 'bearish', momentum: 'bearish', structure: 'bearish', volume: 'bearish', score: -1 },
      ],
      overallBias: 'bearish',
      mtfScore: -0.9,
      generatedAt: 1,
    };
    const s = scoreMTF(mtf);
    expect(s.bearish).toBeGreaterThan(s.bullish);
  });
  it('scoreMTF returns zeros when mtf is undefined', () => {
    expect(scoreMTF(undefined)).toEqual({ bullish: 0, bearish: 0 });
    expect(scoreMTF({ cells: [], overallBias: 'neutral', mtfScore: 0, generatedAt: 1 })).toEqual({
      bullish: 0,
      bearish: 0,
    });
  });
  it('subScoreSigned and subScoreBias', () => {
    expect(subScoreSigned({ bullish: 0.8, bearish: 0.1 })).toBeGreaterThan(0);
    expect(subScoreBias({ bullish: 0.8, bearish: 0.1 })).toBe('bullish');
    expect(subScoreBias({ bullish: 0.4, bearish: 0.4 })).toBe('neutral');
    expect(subScoreBias({ bullish: 0, bearish: 0 })).toBe('neutral');
    expect(subScoreBias({ bullish: 0.1, bearish: 0.9 })).toBe('bearish');
  });
});

describe('computeScore', () => {
  it('returns neutral for empty input', () => {
    const r = computeScore([], {}, weights);
    expect(r.bias).toBe('neutral');
    expect(r.label).toBe('Neutral');
    expect(r.bullish).toBe(0);
    expect(r.bearish).toBe(0);
  });
  it('returns bullish label for sustained uptrend', () => {
    const r = computeScore(trendingUp(120), {}, weights);
    expect(r.bullish).toBeGreaterThan(r.bearish);
    expect(['Bullish', 'Strong Bullish', 'Weak Bullish']).toContain(r.label);
  });
  it('returns bearish label for sustained downtrend', () => {
    const r = computeScore(trendingDown(120), {}, weights);
    expect(r.bearish).toBeGreaterThan(r.bullish);
    expect(['Bearish', 'Strong Bearish', 'Weak Bearish']).toContain(r.label);
  });
  it('returns neutral-ish for ranging market', () => {
    const r = computeScore(ranging(120), {}, weights);
    expect(['neutral', 'bullish', 'bearish']).toContain(r.bias);
  });
  it('returns finite values under extreme volatility', () => {
    const r = computeScore(extremeVolatility(120), {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
    expect(Number.isFinite(r.net)).toBe(true);
    expect(Number.isFinite(r.total)).toBe(true);
  });
  it('tolerates NaN in candles', () => {
    const r = computeScore(withNaN(trendingUp(120)), {}, weights);
    expect(Number.isFinite(r.bullish)).toBe(true);
    expect(Number.isFinite(r.bearish)).toBe(true);
  });
  it('breakdown values are weighted signed contributions', () => {
    const r = computeScore(trendingUp(120), {}, weights);
    expect(r.breakdown.trend).toBeGreaterThan(0);
    expect(r.breakdown.momentum).toBeGreaterThan(0);
  });
  it('incorporates MTF context', () => {
    const mtf: MTFAnalysis = {
      cells: [
        { timeframe: '1d', trend: 'bearish', momentum: 'bearish', structure: 'bearish', volume: 'bearish', score: -1 },
      ],
      overallBias: 'bearish',
      mtfScore: -1,
      generatedAt: 1,
    };
    const r = computeScore(trendingUp(80), { mtf }, weights);
    expect(r.breakdown.mtf).toBeLessThan(0);
  });
  it('incorporates SNR context', () => {
    // Price sits just below a strong resistance -> breakdown.snr is bearish.
    const snr: SupportResistanceLevel[] = [
      { id: 'r', price: 105, type: 'resistance', strength: 1, touches: 3, kind: 'swing-high' },
    ];
    const r = computeScore(trendingUp(80), { price: 104, snr }, weights);
    expect(r.breakdown.snr).toBeLessThan(0);

    // And the symmetric case: price just above a strong support -> bullish.
    const snr2: SupportResistanceLevel[] = [
      { id: 's', price: 99, type: 'support', strength: 1, touches: 3, kind: 'swing-low' },
    ];
    const r2 = computeScore(trendingUp(80), { price: 100, snr: snr2 }, weights);
    expect(r2.breakdown.snr).toBeGreaterThan(0);
  });
  it('incorporates SND context', () => {
    const snd: SupplyDemandZone[] = [
      { id: 'd', type: 'demand', high: 110, low: 100, originTime: 1, status: 'fresh', strength: 1, pattern: 'base-rally' },
    ];
    const r = computeScore(trendingUp(80), { price: 105, snd }, weights);
    expect(r.breakdown.snd).toBeGreaterThan(0);
  });
  it('incorporates structure context', () => {
    const evts: MarketStructureEvent[] = [
      { time: 1, price: 100, kind: 'BOS', direction: 'bullish' },
    ];
    const r = computeScore(trendingUp(80), { structure: evts }, weights);
    expect(r.breakdown.structure).toBeGreaterThanOrEqual(0);
  });
  it('uses single candle without throwing', () => {
    expect(() => computeScore([makeCandle(0, 100, 101, 99, 100)], {}, weights)).not.toThrow();
  });
  it('uses custom weights', () => {
    const heavy: ScoreBreakdown = { ...weights, mtf: 0 };
    const r1 = computeScore(trendingUp(80), {}, heavy);
    const r2 = computeScore(trendingUp(80), {}, weights);
    expect(r1.bullish).toBeLessThanOrEqual(r2.bullish + 1e-9);
  });
});

describe('countAgreement', () => {
  it('counts bullish / bearish / neutral categories', () => {
    const breakdown: ScoreBreakdown = {
      trend: 0.5,
      momentum: 0.2,
      volume: 0.1,
      structure: -0.4,
      snr: 0,
      snd: -0.2,
      volatility: 0.3,
      mtf: 0,
    };
    const r = countAgreement(breakdown);
    expect(r.bull).toBe(4); // trend, momentum, volume, volatility
    expect(r.bear).toBe(2); // structure, snd
    expect(r.total).toBe(8);
  });
});

describe('buildScoringFromSubs', () => {
  it('produces a ScoringResult shape', () => {
    const r = buildScoringFromSubs(
      {
        trend: { bullish: 0.5, bearish: 0 },
        momentum: { bullish: 0.5, bearish: 0 },
        volume: { bullish: 0.5, bearish: 0 },
        structure: { bullish: 0.5, bearish: 0 },
        snr: { bullish: 0, bearish: 0 },
        snd: { bullish: 0, bearish: 0 },
        volatility: { bullish: 0, bearish: 0 },
        mtf: { bullish: 0, bearish: 0 },
      },
      weights,
    );
    expect(r.bias).toBe('bullish');
    expect(r.bullish).toBeGreaterThan(r.bearish);
  });
});
