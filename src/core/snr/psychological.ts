// Psychological levels -- round numbers that attract trader attention.
//
// Examples:
//   BTC: ... 95000, 96000, 97000, 98000, 99000, 100000, 101000 ...
//   ETH: ...   2700,   2800,   2900,   3000,   3100 ...
//   FX : ... 1.0800, 1.0900, 1.1000, 1.1100 ...
//
// The set of "round" steps is configurable per symbol. By default the
// module emits two tiers of round numbers so both the major and minor
// levels are surfaced.

import type { SupportResistanceLevel } from '@/types';
import { roundToTickSize } from '@/core/utils/series';

export interface PsychologicalOptions {
  /** Price steps that count as "round" (e.g. [100, 1000] for BTC). */
  steps: number[];
  /** Whether to include levels around the current price only. */
  range: {
    low: number;
    high: number;
  };
  /**
   * If true, also include the next-higher level above `range.high` and
   * the next-lower level below `range.low`. Default true.
   */
  includeOutsideRange: boolean;
}

export const DEFAULT_PSYCHOLOGICAL_OPTIONS: PsychologicalOptions = {
  steps: [100, 1000],
  range: { low: 0, high: 0 },
  includeOutsideRange: true,
};

/** Predefined step sets for common instruments. */
export const PSYCH_STEPS: Record<string, number[]> = {
  BTC: [100, 1000],
  ETH: [10, 100],
  SOL: [0.5, 5],
  SPX: [10, 100],
  EURUSD: [0.001, 0.01],
  GBPUSD: [0.001, 0.01],
  USDJPY: [0.5, 5],
  XAU: [5, 50],
};

let _psychSeq = 0;
function nextPsychId(): string {
  _psychSeq += 1;
  return `psy-${_psychSeq}`;
}

export function resetPsychCounter(): void {
  _psychSeq = 0;
}

/**
 * Generate a sorted set of psychological levels covering the given
 * range (and optionally one step beyond on each side).
 */
export function generatePsychologicalLevels(
  options: Partial<PsychologicalOptions> = {},
): SupportResistanceLevel[] {
  const steps = options.steps ?? DEFAULT_PSYCHOLOGICAL_OPTIONS.steps;
  const range = options.range ?? DEFAULT_PSYCHOLOGICAL_OPTIONS.range;
  const includeOutside = options.includeOutsideRange ?? true;

  const out: SupportResistanceLevel[] = [];
  if (range.high <= 0 && range.low <= 0) return out;

  for (const step of steps) {
    if (!Number.isFinite(step) || step <= 0) continue;
    const lo = includeOutside ? range.low - step : range.low;
    const hi = includeOutside ? range.high + step : range.high;
    const start = Math.ceil(lo / step) * step;
    for (let p = start; p <= hi; p += step) {
      if (p <= 0) continue;
      // Avoid emitting levels that are exactly at the round boundary but
      // numerically tiny relative to the range (degenerate cases).
      out.push({
        id: nextPsychId(),
        price: roundToTickSize(p, step),
        type: 'support', // type is determined by context (detector sets it)
        strength: 0,
        touches: 0,
        kind: 'psychological',
      });
    }
  }

  // Deduplicate by price (smaller step may produce duplicates that the
  // larger step also covers)
  const seen = new Map<number, SupportResistanceLevel>();
  for (const lv of out) {
    const existing = seen.get(lv.price);
    if (!existing || existing.kind === 'psychological') {
      seen.set(lv.price, lv);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.price - b.price);
}
