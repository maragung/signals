// Cross-timeframe trend strategy.
//
// Trades in the direction of the higher-timeframe bias. Fires a long
// signal when the MTF analysis is bullish (and the trading-timeframe
// bias is not bearish), and a short signal for the symmetric case.
// Confidence is taken from the MTF score.

import type { Candle, StrategyConfig, StrategySignal } from '@/types';
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

export const mtfTrendStrategy: StrategyImpl = {
  id: 'mtf-trend',
  kind: 'mtf-trend',
  evaluate(
    candles: ReadonlyArray<Candle>,
    params: Record<string, number | string | boolean>,
    ctx: StrategyRunContext,
  ): StrategySignal | undefined {
    if (!ctx.mtf) return undefined;
    const mtfScoreThreshold = numParam(params, 'scoreThreshold', 0.2);
    const last = candles[candles.length - 1];
    if (!last) return undefined;

    const overall = ctx.mtf.overallBias;
    const mtfScore = ctx.mtf.mtfScore;
    if (!isFiniteNumber(mtfScore) || Math.abs(mtfScore) < mtfScoreThreshold) return undefined;

    let direction: 'long' | 'short';
    if (overall === 'bullish' && ctx.scoring?.bias !== 'bearish') {
      direction = 'long';
    } else if (overall === 'bearish' && ctx.scoring?.bias !== 'bullish') {
      direction = 'short';
    } else {
      return undefined;
    }

    const confidence = clamp(0.5 + Math.min(0.5, Math.abs(mtfScore)), 0, 1);
    const strategyId = (params['id'] as string) || 'mtf';
    return {
      id: makeId(strategyId, direction),
      strategyId,
      kind: 'mtf-trend',
      time: ctx.nowMs ?? last.time * 1000,
      direction,
      price: last.close,
      confidence,
      reason: `HTF bias ${overall} · mtfScore ${mtfScore.toFixed(2)} · ${ctx.mtf.cells.length} timeframes aligned`,
    };
  },
};

export function evaluateMtfTrend(
  candles: ReadonlyArray<Candle>,
  config: StrategyConfig,
  ctx: StrategyRunContext,
): StrategySignal | undefined {
  if (!config.enabled) return undefined;
  return mtfTrendStrategy.evaluate(candles, { ...config.params, id: config.id }, ctx);
}
