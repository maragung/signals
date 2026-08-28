// Barrel export for the strategy engine.
//
// `runStrategies` is the main entry point; it iterates over user
// configs and dispatches to the per-kind implementations. The
// `StrategyContext` interface is shared between strategies that need
// to consume pre-computed SNR / SND / market structure.
//
// Public `StrategyImpl` instances (one per `StrategyConfig.kind`)
// are also re-exported so callers can evaluate strategies directly
// (used by tests).

import type { Candle, StrategyConfig, StrategySignal, MarketStructureEvent, SupportResistanceLevel, SupplyDemandZone } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { trendFollowingStrategy, evaluateTrendFollowing } from './trend-following';
import { meanReversionStrategy, evaluateMeanReversion } from './mean-reversion';
import { breakoutStrategy, evaluateBreakout } from './breakout';
import { supplyDemandStrategy, evaluateSupplyDemand } from './supply-demand';
import { mtfTrendStrategy, evaluateMtfTrend } from './mtf-trend';
import type { StrategyImpl } from './types';

export type { StrategyRunContext, StrategyImpl } from './types';
export { numParam, strParam } from './types';

export {
  trendFollowingStrategy,
  evaluateTrendFollowing,
  meanReversionStrategy,
  evaluateMeanReversion,
  breakoutStrategy,
  evaluateBreakout,
  supplyDemandStrategy,
  evaluateSupplyDemand,
  mtfTrendStrategy,
  evaluateMtfTrend,
};

export const STRATEGY_IMPLS: readonly StrategyImpl[] = [
  trendFollowingStrategy,
  meanReversionStrategy,
  breakoutStrategy,
  supplyDemandStrategy,
  mtfTrendStrategy,
];

export const STRATEGY_IMPLS_BY_KIND: Record<StrategyConfig['kind'], StrategyImpl> = {
  'trend-following': trendFollowingStrategy,
  'mean-reversion': meanReversionStrategy,
  breakout: breakoutStrategy,
  'supply-demand': supplyDemandStrategy,
  'mtf-trend': mtfTrendStrategy,
};

export function getStrategyImpl(kind: StrategyConfig['kind']) {
  return STRATEGY_IMPLS_BY_KIND[kind];
}

export interface StrategyContext {
  snr?: SupportResistanceLevel[];
  snd?: SupplyDemandZone[];
  structureEvents?: MarketStructureEvent[];
  indicatorResults?: Record<string, unknown>;
}

export function runStrategies(
  candles: Candle[],
  configs: StrategyConfig[],
  ctx: StrategyContext = {},
): StrategySignal[] {
  const out: StrategySignal[] = [];
  if (candles.length === 0) return out;
  const last = candles[candles.length - 1]!;
  const price = isFiniteNum(last.close) ? last.close : 0;
  const runCtx = {
    symbol: '',
    timeframe: '1h' as never,
    atr: 0,
    price,
    snr: ctx.snr,
    snd: ctx.snd,
    structure: ctx.structureEvents,
    nowMs: Date.now(),
  };
  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    let sig: StrategySignal | undefined;
    try {
      switch (cfg.kind) {
        case 'trend-following':
          sig = evaluateTrendFollowing(candles, cfg.params as never, runCtx);
          break;
        case 'mean-reversion':
          sig = evaluateMeanReversion(candles, cfg.params as never, runCtx);
          break;
        case 'breakout':
          sig = evaluateBreakout(candles, cfg.params as never, runCtx);
          break;
        case 'supply-demand':
          sig = evaluateSupplyDemand(candles, cfg.params as never, runCtx);
          break;
        case 'mtf-trend':
          sig = evaluateMtfTrend(candles, cfg.params as never, runCtx);
          break;
      }
    } catch {
      sig = undefined;
    }
    if (sig) {
      out.push({ ...sig, strategyId: cfg.id });
    }
  }
  return out;
}
