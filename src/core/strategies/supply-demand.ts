// Supply / Demand strategy.
//
// Fires when the current price enters a fresh demand zone (long) or
// supply zone (short) in the direction of the zone. Confidence grows
// with the zone strength and how deep the price has penetrated it.

import type { Candle, StrategyConfig, StrategySignal, SupplyDemandZone } from '@/types';
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

export const supplyDemandStrategy: StrategyImpl = {
  id: 'supply-demand',
  kind: 'supply-demand',
  evaluate(
    candles: ReadonlyArray<Candle>,
    params: Record<string, number | string | boolean>,
    ctx: StrategyRunContext,
  ): StrategySignal | undefined {
    if (candles.length === 0) return undefined;
    const minStrength = numParam(params, 'minStrength', 0.4);
    const last = candles[candles.length - 1];
    if (!last) return undefined;
    const price = last.close;

    const zones: SupplyDemandZone[] = ctx.snd ?? [];
    // Prefer fresh zones; fall back to tested if no fresh match.
    const candidates = zones.filter((z) => z.strength >= minStrength);
    if (candidates.length === 0) return undefined;

    const sortedFresh = candidates.filter((z) => z.status === 'fresh');
    const pool = sortedFresh.length > 0 ? sortedFresh : candidates;

    let chosen: SupplyDemandZone | undefined;
    for (const z of pool) {
      if (z.type === 'demand' && price >= z.low && price <= z.high) {
        chosen = z;
        break;
      }
      if (z.type === 'supply' && price >= z.low && price <= z.high) {
        chosen = z;
        break;
      }
    }
    if (!chosen) return undefined;

    const direction: 'long' | 'short' = chosen.type === 'demand' ? 'long' : 'short';
    const width = Math.max(1e-12, chosen.high - chosen.low);
    const penetration = direction === 'long'
      ? clamp((price - chosen.low) / width, 0, 1)
      : clamp((chosen.high - price) / width, 0, 1);
    const confidence = clamp(0.5 + chosen.strength * 0.3 + (chosen.status === 'fresh' ? 0.1 : 0) + penetration * 0.1, 0, 1);

    const strategyId = (params['id'] as string) || 'snd';
    return {
      id: makeId(strategyId, direction),
      strategyId,
      kind: 'supply-demand',
      time: ctx.nowMs ?? last.time * 1000,
      direction,
      price,
      confidence,
      reason: `Entered ${chosen.status} ${chosen.type} zone ${chosen.low.toFixed(4)}–${chosen.high.toFixed(4)} · pattern ${chosen.pattern}`,
    };
  },
};

export function evaluateSupplyDemand(
  candles: ReadonlyArray<Candle>,
  config: StrategyConfig,
  ctx: StrategyRunContext,
): StrategySignal | undefined {
  if (!config.enabled) return undefined;
  return supplyDemandStrategy.evaluate(candles, { ...config.params, id: config.id }, ctx);
}
