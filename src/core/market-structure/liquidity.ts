// Liquidity sweep detection.
//
// A liquidity sweep is a "stop hunt" pattern: price wicks beyond a
// significant swing high or swing low (taking out resting stops) but
// the candle closes back inside the range. The classic signals are:
//
//   sweep of highs: candle.high > swingHigh && candle.close < swingHigh
//   sweep of lows : candle.low  < swingLow  && candle.close > swingLow
//
// A minimum wick penetration fraction can be required to filter out
// marginal wicks. By default we accept any wick beyond the level.

import type { Candle, MarketStructureEvent } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { detectSwings, type SwingOptions, type SwingPoint } from './swings';

export type LiquidityKind = 'buy-side' | 'sell-side';

export interface LiquiditySweep {
  time: number;
  level: number;
  swingTime: number;
  kind: LiquidityKind;
  /** Distance the wick travelled beyond the level, in price units. */
  penetration: number;
  /** True when the body of the sweep candle also closed beyond the level. */
  closedThrough: boolean;
}

export interface LiquidityOptions extends SwingOptions {
  /** Minimum penetration as a fraction of the level price. Default 0 (any). */
  minPenetrationPct: number;
  /**
   * If true, only consider swings confirmed strictly before the current
   * candle (i.e. a swing cannot be swept by the candles that defined it).
   * Default true.
   */
  excludeOwnWindow: boolean;
}

export const DEFAULT_LIQUIDITY_OPTIONS: LiquidityOptions = {
  lookback: 2,
  minPenetrationPct: 0,
  excludeOwnWindow: true,
};

function passesPenetration(pen: number, level: number, pct: number): boolean {
  if (pct <= 0) return true;
  const ref = Math.max(Math.abs(level), 1);
  return Math.abs(pen) >= ref * (pct / 100);
}

function closeSweep(close: number, level: number, kind: LiquidityKind): boolean {
  if (kind === 'buy-side') return close < level;
  return close > level;
}

/**
 * Detect liquidity sweeps over confirmed swing highs/lows.
 *
 * Pure function. `candles` must be sorted by time ascending.
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  options: Partial<LiquidityOptions> = {},
): LiquiditySweep[] {
  const lookback = Math.max(1, Math.floor(options.lookback ?? DEFAULT_LIQUIDITY_OPTIONS.lookback));
  const minPenPct = options.minPenetrationPct ?? DEFAULT_LIQUIDITY_OPTIONS.minPenetrationPct;
  const excludeOwnWindow = options.excludeOwnWindow ?? DEFAULT_LIQUIDITY_OPTIONS.excludeOwnWindow;

  const n = candles.length;
  if (n < 2 * lookback + 1) return [];

  const swings = detectSwings(candles, { lookback });
  const out: LiquiditySweep[] = [];

  // For each swing we sweep-test every candle strictly after the swing
  // (and outside its lookback window when excludeOwnWindow is true).
  for (const s of swings) {
    const startIdx = excludeOwnWindow ? s.index + lookback : s.index + 1;
    for (let i = startIdx; i < n; i++) {
      const c = candles[i];
      if (!c) continue;
      if (!isFiniteNum(c.high) || !isFiniteNum(c.low) || !isFiniteNum(c.close)) continue;
      if (s.kind === 'high') {
        // Buy-side liquidity above a swing high
        if (c.high > s.price) {
          const pen = c.high - s.price;
          if (!passesPenetration(pen, s.price, minPenPct)) continue;
          if (closeSweep(c.close, s.price, 'buy-side')) {
            out.push({
              time: c.time,
              level: s.price,
              swingTime: s.time,
              kind: 'buy-side',
              penetration: pen,
              closedThrough: c.close > s.price,
            });
          }
        }
      } else {
        // Sell-side liquidity below a swing low
        if (c.low < s.price) {
          const pen = s.price - c.low;
          if (!passesPenetration(pen, s.price, minPenPct)) continue;
          if (closeSweep(c.close, s.price, 'sell-side')) {
            out.push({
              time: c.time,
              level: s.price,
              swingTime: s.time,
              kind: 'sell-side',
              penetration: pen,
              closedThrough: c.close < s.price,
            });
          }
        }
      }
    }
  }

  // Sort by time for determinism
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Convenience: convert a list of liquidity sweeps into MarketStructureEvent
 * markers (kind = CHOCH-ish is not appropriate; we use the BOS slot because
 * it is the closest typed event for the chart, but the event carries no
 * direction here -- callers can re-render as needed).
 */
export function liquiditySweepsToEvents(sweeps: LiquiditySweep[]): MarketStructureEvent[] {
  return sweeps.map((s) => ({
    time: s.time,
    price: s.level,
    kind: 'BOS',
    direction: s.kind === 'buy-side' ? 'bearish' : 'bullish',
  }));
}

/** Convenience: get swing points that were swept at least once. */
export function sweptSwingPoints(sweeps: LiquiditySweep[]): SwingPoint[] {
  const seen = new Map<string, SwingPoint>();
  for (const s of sweeps) {
    const k = `${s.swingTime}|${s.level}`;
    if (!seen.has(k)) {
      seen.set(k, {
        time: s.swingTime,
        price: s.level,
        index: -1,
        kind: s.kind === 'buy-side' ? 'high' : 'low',
      });
    }
  }
  return Array.from(seen.values());
}
