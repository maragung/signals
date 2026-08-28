// Classify swing points as HH / HL / LH / LL / EQH / EQL.
//
// To classify a new swing we compare it to the previously confirmed
// swing of the *same kind*:
//
//   higher -> HH (for swing highs) or HL (for swing lows)
//   equal  -> EQH / EQL
//   lower  -> LH (for swing highs) or LL (for swing lows)
//
// The first swing of any kind establishes a baseline and is NOT
// emitted (it has no prior reference to compare against). This avoids
// spurious "HH" / "HL" labels that would otherwise appear at the
// beginning of a series and confuse downstream consumers (e.g. BOS
// vs CHOCH inference from the most recent label).
//
// Two prices are considered "equal" when they are within `tolerance`
// of each other expressed as a percentage of the reference price
// (default 0.1%).

import type { Candle, MarketStructurePoint } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { detectSwings, type SwingOptions, type SwingPoint } from './swings';

export interface StructureOptions extends SwingOptions {
  /** Percentage tolerance used to flag EQH/EQL (e.g. 0.1 = 0.1%). */
  tolerance: number;
}

export const DEFAULT_STRUCTURE_OPTIONS: StructureOptions = {
  lookback: 2,
  tolerance: 0.1,
};

function classify(
  prev: number,
  price: number,
  tolerancePct: number,
  high: boolean,
): MarketStructurePoint['kind'] {
  const ref = Math.abs(prev);
  const tol = (ref > 0 ? ref : Math.max(Math.abs(price), 1)) * (tolerancePct / 100);
  const diff = price - prev;
  if (Math.abs(diff) <= tol) return high ? 'EQH' : 'EQL';
  if (diff > 0) return high ? 'HH' : 'HL';
  return high ? 'LH' : 'LL';
}

/**
 * Convert raw swing points into labelled MarketStructurePoints.
 *
 * The first swing high and the first swing low of the series establish
 * a baseline and are not emitted (they have no prior reference).
 *
 * @param swings output of `detectSwings` (or compatible)
 * @param options.tolerance percentage band for EQH/EQL
 */
export function classifyStructure(
  swings: SwingPoint[],
  options: Partial<StructureOptions> = {},
): MarketStructurePoint[] {
  const tolerance = options.tolerance ?? DEFAULT_STRUCTURE_OPTIONS.tolerance;
  const out: MarketStructurePoint[] = [];

  let baselineHigh: number | null = null;
  let baselineLow: number | null = null;

  for (const s of swings) {
    if (!isFiniteNum(s.price) || !isFiniteNum(s.time)) continue;
    if (s.kind === 'high') {
      if (baselineHigh === null) {
        baselineHigh = s.price;
        continue;
      }
      out.push({
        time: s.time,
        price: s.price,
        kind: classify(baselineHigh, s.price, tolerance, true),
      });
      baselineHigh = s.price;
    } else {
      if (baselineLow === null) {
        baselineLow = s.price;
        continue;
      }
      out.push({
        time: s.time,
        price: s.price,
        kind: classify(baselineLow, s.price, tolerance, false),
      });
      baselineLow = s.price;
    }
  }

  return out;
}

/** Convenience helper: detect + classify in one call. */
export function detectMarketStructure(
  candles: Candle[],
  options: Partial<StructureOptions> = {},
): MarketStructurePoint[] {
  const lookback = options.lookback ?? DEFAULT_STRUCTURE_OPTIONS.lookback;
  const swings = detectSwings(candles, { lookback });
  return classifyStructure(swings, options);
}
