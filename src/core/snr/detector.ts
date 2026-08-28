// Main SNR detection pipeline.
//
// The detector composes the building blocks (clustering, psychological
// levels, strength scoring) and produces a deduplicated list of
// SupportResistanceLevel objects for the chart.
//
// Sources of levels (in order of detection):
//   1. Swing highs / lows from the market-structure engine
//   2. Previous-period high / low / close
//   3. Psychological round numbers
//
// All raw candidates are clustered together (per type), scored, and
// returned sorted by price.

import type { Candle, SupportResistanceLevel } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { detectSwings } from '@/core/market-structure/swings';
import { clusterLevels, type ClusterInput, type ClusterOptions } from './clustering';
import {
  generatePsychologicalLevels,
  PSYCH_STEPS,
  type PsychologicalOptions,
} from './psychological';
import { scoreLevel, type StrengthOptions } from './strength';
import { nanoid } from 'nanoid';

export interface DetectSnROptions {
  /** Symbol id used to pick a default psychological step set. */
  symbol?: string;
  /** Lookback for swing detection. */
  swingLookback: number;
  /** Number of prior periods for previous-high / low / close levels. */
  prevPeriods: number;
  /** Cluster tolerance (% of price). */
  clusterTolerancePct: number;
  /** Whether to include psychological levels. */
  includePsychological: boolean;
  /** Optional override of psychological step list. */
  psychSteps?: number[];
  /** Whether to include previous-period levels. */
  includePrevPeriod: boolean;
  /** Whether to include swing-derived levels. */
  includeSwing: boolean;
  /** Maximum number of output levels. */
  maxLevels: number;
  /** Strength scoring options. */
  strength: Partial<StrengthOptions>;
  /** Cluster options. */
  cluster: Partial<ClusterOptions>;
  /** Psychological options (overrides range if set). */
  psychological: Partial<PsychologicalOptions>;
}

export const DEFAULT_SNR_OPTIONS: DetectSnROptions = {
  swingLookback: 2,
  prevPeriods: 1,
  clusterTolerancePct: 0.5,
  includePsychological: true,
  includePrevPeriod: true,
  includeSwing: true,
  maxLevels: 50,
  strength: {},
  cluster: {},
  psychological: {},
};

function makeId(): string {
  // Use nanoid in production; tests can stub this through env if needed.
  try {
    return nanoid(10);
  } catch {
    return `snr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Main entry point: detect support and resistance levels for a candle
 * series.
 */
export function detectSupportResistance(
  candles: Candle[],
  options: Partial<DetectSnROptions> = {},
): SupportResistanceLevel[] {
  const opts: DetectSnROptions = {
    ...DEFAULT_SNR_OPTIONS,
    ...options,
    strength: { ...DEFAULT_SNR_OPTIONS.strength, ...(options.strength ?? {}) },
    cluster: { ...DEFAULT_SNR_OPTIONS.cluster, ...(options.cluster ?? {}) },
    psychological: {
      ...DEFAULT_SNR_OPTIONS.psychological,
      ...(options.psychological ?? {}),
    },
  };

  if (candles.length < 2) return [];

  const raw: ClusterInput[] = [];

  // 1) Swing-derived levels
  if (opts.includeSwing) {
    const swings = detectSwings(candles, { lookback: opts.swingLookback });
    for (const s of swings) {
      if (!isFiniteNum(s.price)) continue;
      raw.push({
        price: s.price,
        touches: 1,
        strength: 0,
        kind: s.kind === 'high' ? 'swing-high' : 'swing-low',
        type: s.kind === 'high' ? 'resistance' : 'support',
      });
    }
  }

  // 2) Previous-period high / low / close
  if (opts.includePrevPeriod && candles.length > 1) {
    const last = candles[candles.length - 1]!;
    const prev = candles[candles.length - 2]!;
    if (isFiniteNum(prev.high)) {
      raw.push({
        price: prev.high,
        touches: 1,
        strength: 0,
        kind: 'prev-high',
        type: 'resistance',
      });
    }
    if (isFiniteNum(prev.low)) {
      raw.push({
        price: prev.low,
        touches: 1,
        strength: 0,
        kind: 'prev-low',
        type: 'support',
      });
    }
    if (isFiniteNum(prev.close)) {
      // Close is "support" below the current close and "resistance"
      // above it. Emit it as a minor support in the absence of trend
      // info.
      raw.push({
        price: prev.close,
        touches: 1,
        strength: 0,
        kind: 'prev-close',
        type: prev.close <= last.close ? 'support' : 'resistance',
      });
    }
  }

  // 3) Psychological levels
  if (opts.includePsychological) {
    const steps =
      opts.psychSteps ??
      (opts.symbol && PSYCH_STEPS[opts.symbol.toUpperCase()]
        ? PSYCH_STEPS[opts.symbol.toUpperCase()]
        : undefined) ??
      [100, 1000];
    const hi = Math.max(...candles.map((c) => (isFiniteNum(c.high) ? c.high : -Infinity)));
    const lo = Math.min(...candles.map((c) => (isFiniteNum(c.low) ? c.low : Infinity)));
    if (isFiniteNum(hi) && isFiniteNum(lo) && hi > 0 && lo > 0) {
      const psych = generatePsychologicalLevels({
        ...opts.psychological,
        steps,
        range: { low: lo, high: hi },
      });
      for (const lv of psych) {
        // Place psych levels: above current close -> resistance, below -> support
        const close = candles[candles.length - 1]?.close;
        raw.push({
          price: lv.price,
          touches: 0,
          strength: 0,
          kind: 'psychological',
          type: isFiniteNum(close) && lv.price >= close ? 'resistance' : 'support',
        });
      }
    }
  }

  if (raw.length === 0) return [];

  // Cluster nearby levels
  const clusters = clusterLevels(raw, { tolerancePct: opts.clusterTolerancePct, ...opts.cluster });

  // Score each cluster using the strength module
  const scored: SupportResistanceLevel[] = [];
  for (const c of clusters) {
    const fresh = { ...c, id: makeId() };
    scored.push(scoreLevel(fresh, candles, opts.strength));
  }

  // Sort by price
  scored.sort((a, b) => a.price - b.price);

  return scored.slice(0, opts.maxLevels);
}
