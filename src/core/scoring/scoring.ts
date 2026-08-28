// `computeScore` aggregates per-category sub-scores into a single
// `ScoringResult` using configurable weights. The label is derived
// from the relative net / total ratio.

import type {
  Bias,
  Candle,
  MarketStructureEvent,
  MTFAnalysis,
  ScoreBreakdown,
  ScoringResult,
  SupplyDemandZone,
  SupportResistanceLevel,
} from '@/types';
import { isFiniteNum, safeNum } from '@/core/utils/series';
import {
  scoreMTF,
  scoreMomentum,
  scoreSND,
  scoreSNR,
  scoreStructure,
  scoreTrend,
  scoreVolatility,
  scoreVolume,
  type SubScore,
} from './breakdown';

export interface ScoringContext {
  price?: number;
  snr?: SupportResistanceLevel[];
  snd?: SupplyDemandZone[];
  structure?: MarketStructureEvent[];
  mtf?: MTFAnalysis;
}

/** Returns the category-level signed score weighted by user weights. */
export function computeScore(
  candles: ReadonlyArray<Candle>,
  context: ScoringContext = {},
  weights: ScoreBreakdown,
): ScoringResult {
  const price = isFiniteNum(context.price)
    ? context.price
    : (candles[candles.length - 1]?.close ?? 0);

  const trend = scoreTrend(candles);
  const momentum = scoreMomentum(candles);
  const volume = scoreVolume(candles);
  const structure = scoreStructure(candles, context.structure);
  const snr = scoreSNR(price, context.snr);
  const snd = scoreSND(price, context.snd);
  const volatility = scoreVolatility(candles);
  const mtf = scoreMTF(context.mtf);

  const w = normaliseWeights(weights);

  const bull =
    trend.bullish * w.trend +
    momentum.bullish * w.momentum +
    volume.bullish * w.volume +
    structure.bullish * w.structure +
    snr.bullish * w.snr +
    snd.bullish * w.snd +
    volatility.bullish * w.volatility +
    mtf.bullish * w.mtf;
  const bear =
    trend.bearish * w.trend +
    momentum.bearish * w.momentum +
    volume.bearish * w.volume +
    structure.bearish * w.structure +
    snr.bearish * w.snr +
    snd.bearish * w.snd +
    volatility.bearish * w.volatility +
    mtf.bearish * w.mtf;

  const bullish = clamp01(bull);
  const bearish = clamp01(bear);
  const total = bullish + bearish;
  const net = bullish - bearish;
  const label = labelFromNet(net, total);
  const bias = biasFromLabel(label);

  const breakdown: ScoreBreakdown = {
    trend: trend.bullish - trend.bearish,
    momentum: momentum.bullish - momentum.bearish,
    volume: volume.bullish - volume.bearish,
    structure: structure.bullish - structure.bearish,
    snr: snr.bullish - snr.bearish,
    snd: snd.bullish - snd.bearish,
    volatility: volatility.bullish - volatility.bearish,
    mtf: mtf.bullish - mtf.bearish,
  };

  return { bullish, bearish, net, total, label, bias, breakdown };
}

export function labelFromNet(net: number, total: number): ScoringResult['label'] {
  if (total <= 0 || !isFiniteNum(total)) return 'Neutral';
  const ratio = net / total;
  if (ratio >= 0.7) return 'Strong Bullish';
  if (ratio >= 0.3) return 'Bullish';
  if (ratio > 0.1) return 'Weak Bullish';
  if (ratio > -0.1) return 'Neutral';
  if (ratio > -0.3) return 'Weak Bearish';
  if (ratio > -0.7) return 'Bearish';
  return 'Strong Bearish';
}

export function biasFromLabel(label: ScoringResult['label']): Bias {
  if (label === 'Strong Bullish' || label === 'Bullish') return 'bullish';
  if (label === 'Weak Bullish') return 'bullish';
  if (label === 'Strong Bearish' || label === 'Bearish') return 'bearish';
  if (label === 'Weak Bearish') return 'bearish';
  return 'neutral';
}

function clamp01(x: number): number {
  if (!isFiniteNum(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function normaliseWeights(w: ScoreBreakdown): ScoreBreakdown {
  return {
    trend: safeNum(w.trend, 0),
    momentum: safeNum(w.momentum, 0),
    volume: safeNum(w.volume, 0),
    structure: safeNum(w.structure, 0),
    snr: safeNum(w.snr, 0),
    snd: safeNum(w.snd, 0),
    volatility: safeNum(w.volatility, 0),
    mtf: safeNum(w.mtf, 0),
  };
}

/** Build a ScoringResult from a list of sub-scores (used for unit tests). */
export function buildScoringFromSubs(
  subs: {
    trend: SubScore;
    momentum: SubScore;
    volume: SubScore;
    structure: SubScore;
    snr: SubScore;
    snd: SubScore;
    volatility: SubScore;
    mtf: SubScore;
  },
  weights: ScoreBreakdown,
): ScoringResult {
  // Use the sub-scores directly to weight the contributions; we pass
  // a single candle so the per-candle sub-scoring functions return
  // their computed values without doing further I/O.
  const trend = subs.trend;
  const momentum = subs.momentum;
  const volume = subs.volume;
  const structure = subs.structure;
  const snr = subs.snr;
  const snd = subs.snd;
  const volatility = subs.volatility;
  const mtf = subs.mtf;
  const w = normaliseWeights(weights);
  const bull =
    trend.bullish * w.trend +
    momentum.bullish * w.momentum +
    volume.bullish * w.volume +
    structure.bullish * w.structure +
    snr.bullish * w.snr +
    snd.bullish * w.snd +
    volatility.bullish * w.volatility +
    mtf.bullish * w.mtf;
  const bear =
    trend.bearish * w.trend +
    momentum.bearish * w.momentum +
    volume.bearish * w.volume +
    structure.bearish * w.structure +
    snr.bearish * w.snr +
    snd.bearish * w.snd +
    volatility.bearish * w.volatility +
    mtf.bearish * w.mtf;
  const bullish = clamp01(bull);
  const bearish = clamp01(bear);
  const total = bullish + bearish;
  const net = bullish - bearish;
  const label = labelFromNet(net, total);
  const bias = biasFromLabel(label);
  return {
    bullish,
    bearish,
    net,
    total,
    label,
    bias,
    breakdown: {
      trend: trend.bullish - trend.bearish,
      momentum: momentum.bullish - momentum.bearish,
      volume: volume.bullish - volume.bearish,
      structure: structure.bullish - structure.bearish,
      snr: snr.bullish - snr.bearish,
      snd: snd.bullish - snd.bearish,
      volatility: volatility.bullish - volatility.bearish,
      mtf: mtf.bullish - mtf.bearish,
    },
  };
}

/** Count how many categories agree on the same direction. */
export function countAgreement(breakdown: ScoreBreakdown): { bull: number; bear: number; total: number } {
  let bull = 0;
  let bear = 0;
  const keys: (keyof ScoreBreakdown)[] = [
    'trend', 'momentum', 'volume', 'structure', 'snr', 'snd', 'volatility', 'mtf',
  ];
  for (const k of keys) {
    const v = breakdown[k];
    if (v > 0) bull++;
    else if (v < 0) bear++;
  }
  return { bull, bear, total: keys.length };
}
