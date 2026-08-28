// Breakout strategy.
//
// Fires a long signal when the current close breaks above the nearest
// resistance level with above-average volume, and a short signal when
// the close breaks below the nearest support. The recommended stop is
// placed one ATR beyond the broken level.

import type { Candle, StrategyConfig, StrategySignal, SupportResistanceLevel } from '@/types';
import { isFiniteNum, mean } from '@/core/utils/series';
import { lastFinite, sma } from './indicators';
import { numParam, type StrategyImpl, type StrategyRunContext } from './types';

function makeId(strategyId: string, direction: 'long' | 'short'): string {
  return `${strategyId}-${direction}-${Date.now().toString(36)}`;
}

function isFiniteNumber(x: number): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(Math.max(x, lo), hi);
}

export const breakoutStrategy: StrategyImpl = {
  id: 'breakout',
  kind: 'breakout',
  evaluate(
    candles: ReadonlyArray<Candle>,
    params: Record<string, number | string | boolean>,
    ctx: StrategyRunContext,
  ): StrategySignal | undefined {
    if (candles.length < 5) return undefined;
    const atrMult = numParam(params, 'atrMult', 1.5);
    const volMult = numParam(params, 'volMult', 1.5);
    const lookback = numParam(params, 'lookback', 20);
    const atr = isFiniteNum(ctx.atr) && ctx.atr > 0 ? ctx.atr : 0;

    const last = candles[candles.length - 1];
    const prev = candles.length >= 2 ? candles[candles.length - 2] : undefined;
    if (!last) return undefined;
    const price = last.close;

    // Find nearest support below and resistance above.
    // Use the previous close for the "side" filter so the level sits
    // on the correct side of the bar that just broke.
    const refPrice = prev ? prev.close : price;
    const supports = (ctx.snr ?? []).filter((l) => l.type === 'support' && l.price < refPrice);
    const resistances = (ctx.snr ?? []).filter((l) => l.type === 'resistance' && l.price > refPrice);
    const nearestRes: SupportResistanceLevel | undefined = pickNearest(resistances, refPrice, 'above');
    const nearestSup: SupportResistanceLevel | undefined = pickNearest(supports, refPrice, 'below');

    // Volume confirmation: current volume above volMult * avg volume.
    const window = candles.slice(-Math.max(2, Math.floor(lookback)));
    const vols = window.map((c) => c.volume);
    const avgVol = mean(vols);
    const volConfirm = isFiniteNum(avgVol) && avgVol > 0 && last.volume >= volMult * avgVol;

    let direction: 'long' | 'short' | null = null;
    let level: SupportResistanceLevel | undefined;
    if (nearestRes && prev && prev.close <= nearestRes.price && last.close > nearestRes.price) {
      direction = 'long';
      level = nearestRes;
    } else if (nearestSup && prev && prev.close >= nearestSup.price && last.close < nearestSup.price) {
      direction = 'short';
      level = nearestSup;
    }
    if (direction === null || !level) return undefined;
    if (volMult > 0 && !volConfirm) return undefined;

    const distance = Math.abs(price - level.price);
    const stopDistance = atr > 0 ? atr * atrMult : distance;
    const proximity = atr > 0 ? clamp(distance / atr, 0, 1) : 0.5;
    const confidence = clamp(0.55 + proximity * 0.25 + (volConfirm ? 0.15 : 0), 0, 1);

    const strategyId = (params['id'] as string) || 'breakout';
    return {
      id: makeId(strategyId, direction),
      strategyId,
      kind: 'breakout',
      time: ctx.nowMs ?? last.time * 1000,
      direction,
      price,
      confidence,
      reason: `Break${direction === 'long' ? 'out above' : 'down below'} ${level.kind} @ ${level.price.toFixed(4)} · stop ${stopDistance.toFixed(4)} · vol x${(last.volume / Math.max(avgVol, 1e-12)).toFixed(2)}`,
    };
  },
};

function pickNearest(
  levels: SupportResistanceLevel[],
  price: number,
  side: 'above' | 'below',
): SupportResistanceLevel | undefined {
  if (levels.length === 0) return undefined;
  let best: SupportResistanceLevel | undefined;
  let bestDist = Infinity;
  for (const l of levels) {
    if (!isFiniteNumber(l.price)) continue;
    const d = side === 'above' ? l.price - price : price - l.price;
    if (d < 0) continue;
    if (d < bestDist) {
      bestDist = d;
      best = l;
    }
  }
  return best;
}

export function evaluateBreakout(
  candles: ReadonlyArray<Candle>,
  config: StrategyConfig,
  ctx: StrategyRunContext,
): StrategySignal | undefined {
  if (!config.enabled) return undefined;
  return breakoutStrategy.evaluate(candles, { ...config.params, id: config.id }, ctx);
}

// Re-export for tests that want to inspect the sma helper.
export { sma, lastFinite };
