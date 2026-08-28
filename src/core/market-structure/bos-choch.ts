// BOS (Break of Structure) and CHOCH (Change of Character) detection.
//
// Definitions used here:
// - A swing high is "broken upward" when a candle closes above it.
// - A swing low is "broken downward" when a candle closes below it.
//
// The current trend is inferred from the most recent classified
// structure point (HH/HL/EQH -> uptrend, LH/LL/EQL -> downtrend). When
// no structure points exist yet, the trend is "unknown" and the first
// break is treated as a BOS (we don't claim a CHOCH against a trend
// that has not been established).
//
// BOS:   break in the same direction as the prevailing trend
//   - uptrend + close above prior swing high -> bullish BOS
//   - downtrend + close below prior swing low -> bearish BOS
//
// CHOCH: break against the prevailing trend
//   - uptrend + close below prior swing low -> bearish CHOCH
//   - downtrend + close above prior swing high -> bullish CHOCH
//
// Each event is anchored to the breaking candle's time and the price
// of the swing level that was broken.

import type { Candle, MarketStructureEvent, MarketStructurePoint } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import {
  classifyStructure,
  DEFAULT_STRUCTURE_OPTIONS,
  type StructureOptions,
} from './structure';
import { detectSwings, type SwingPoint } from './swings';

export interface BosChochOptions extends StructureOptions {
  /**
   * If true, only emit a single BOS/CHOCH per swing level (the first
   * break of that level). Subsequent closes beyond the same level are
   * ignored. Default true. When false, every candle that closes beyond
   * the current tracked extreme produces an event.
   */
  onlyFirstBreak: boolean;
}

export const DEFAULT_BOS_CHOCH_OPTIONS: BosChochOptions = {
  ...DEFAULT_STRUCTURE_OPTIONS,
  onlyFirstBreak: true,
};

type Trend = 'up' | 'down' | 'unknown';
type Kind = MarketStructurePoint['kind'];

function inferTrend(lastKind: Kind | undefined): Trend {
  if (!lastKind) return 'unknown';
  if (lastKind === 'HH' || lastKind === 'HL' || lastKind === 'EQH') return 'up';
  return 'down';
}

interface SwingRef {
  time: number;
  price: number;
  index: number;
}

/**
 * Detect BOS and CHOCH events.
 *
 * Pure function. `candles` must be sorted by time ascending.
 */
export function detectBosChocho(
  candles: Candle[],
  options: Partial<BosChochOptions> = {},
): MarketStructureEvent[] {
  const lookback = options.lookback ?? DEFAULT_BOS_CHOCH_OPTIONS.lookback;
  const tolerance = options.tolerance ?? DEFAULT_BOS_CHOCH_OPTIONS.tolerance;
  const onlyFirstBreak = options.onlyFirstBreak ?? DEFAULT_BOS_CHOCH_OPTIONS.onlyFirstBreak;

  const n = candles.length;
  if (n < 2) return [];

  const swings = detectSwings(candles, { lookback });
  const structure = classifyStructure(swings, { lookback, tolerance });

  // Build a map from (time, price) -> kind for O(1) label lookup.
  // The structure array only contains LABELED points (first high/low
  // of each kind are excluded).
  const labelBySwing = new Map<string, Kind>();
  for (let i = 0; i < structure.length; i++) {
    const p = structure[i];
    if (!p) continue;
    labelBySwing.set(`${p.time}|${p.price}`, p.kind);
  }

  // Maintain running extremes of confirmed swing high/low (regardless
  // of whether they have been labelled yet, because the very first
  // swing of a kind still establishes a level that price can break).
  let extremeHigh: SwingRef | null = null;
  let extremeLow: SwingRef | null = null;
  // Track the most recent level that was "consumed" (so we only emit
  // the first break of that level when onlyFirstBreak is true).
  let consumedHighPrice: number | null = null;
  let consumedLowPrice: number | null = null;

  let lastKind: Kind | undefined;

  const events: MarketStructureEvent[] = [];
  let swingPtr = 0;
  // Walk through the structure points in lockstep with swings.
  let structPtr = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!c) continue;
    if (!isFiniteNum(c.close) || !isFiniteNum(c.high) || !isFiniteNum(c.low)) continue;

    // Advance swing pointer through any swings confirmed at or before i
    while (swingPtr < swings.length) {
      const sw = swings[swingPtr];
      if (!sw) break;
      if (sw.index > i) break;
      if (sw.kind === 'high') {
        if (!extremeHigh || sw.price > extremeHigh.price) {
          extremeHigh = { time: sw.time, price: sw.price, index: sw.index };
        }
      } else {
        if (!extremeLow || sw.price < extremeLow.price) {
          extremeLow = { time: sw.time, price: sw.price, index: sw.index };
        }
      }
      // Pick up the structure label for this swing (if any). Since
      // structure and swings are in the same order, we can advance the
      // structure pointer in lockstep.
      if (structPtr < structure.length) {
        const sp = structure[structPtr];
        if (sp && sp.time === sw.time && sp.price === sw.price) {
          lastKind = sp.kind;
          structPtr++;
        }
      }
      swingPtr++;
    }

    const trend = inferTrend(lastKind);

    // Bullish break: close above the current extreme swing high
    if (extremeHigh && c.close > extremeHigh.price) {
      const ref = Math.max(Math.abs(extremeHigh.price), 1);
      const alreadyConsumed =
        onlyFirstBreak &&
        consumedHighPrice !== null &&
        Math.abs(consumedHighPrice - extremeHigh.price) <= ref * (tolerance / 100);
      if (!alreadyConsumed) {
        const isChocho = trend === 'down';
        events.push({
          time: c.time,
          price: extremeHigh.price,
          kind: isChocho ? 'CHOCH' : 'BOS',
          direction: 'bullish',
        });
        consumedHighPrice = extremeHigh.price;
      }
    }

    // Bearish break: close below the current extreme swing low
    if (extremeLow && c.close < extremeLow.price) {
      const ref = Math.max(Math.abs(extremeLow.price), 1);
      const alreadyConsumed =
        onlyFirstBreak &&
        consumedLowPrice !== null &&
        Math.abs(consumedLowPrice - extremeLow.price) <= ref * (tolerance / 100);
      if (!alreadyConsumed) {
        const isChocho = trend === 'up';
        events.push({
          time: c.time,
          price: extremeLow.price,
          kind: isChocho ? 'CHOCH' : 'BOS',
          direction: 'bearish',
        });
        consumedLowPrice = extremeLow.price;
      }
    }
  }

  return events;
}
