// Trend-following strategy.
//
// Generates a long signal when the fast EMA is above the slow EMA,
// MACD histogram is positive, and ADX is above the configured
// threshold (i.e. the trend is strong). A short signal is the
// symmetric condition. The signal confidence grows with the
// magnitude of the EMA spread, MACD histogram, and ADX reading.

import type { StrategyConfig, StrategySignal } from '@/types';
import { adxSeries, ema, lastFinite, macdSeries } from './indicators';
import { numParam, type StrategyImpl } from './types';

const SIGNAL_PREFIX = 'sig';

function makeId(strategyId: string, direction: 'long' | 'short'): string {
  return `${strategyId}-${direction}-${Date.now().toString(36)}`;
}

export const trendFollowingStrategy: StrategyImpl = {
  id: 'trend-following',
  kind: 'trend-following',
  evaluate(
    candles,
    params,
    ctx,
  ): StrategySignal | undefined {
    if (candles.length < 30) return undefined;
    const fast = numParam(params, 'emaFast', 9);
    const slow = numParam(params, 'emaSlow', 21);
    const adxThreshold = numParam(params, 'adxThreshold', 20);
    const fastE = ema(candles.map((c) => c.close), Math.min(fast, candles.length));
    const slowE = ema(candles.map((c) => c.close), Math.min(slow, candles.length));
    const lastFast = lastFinite(fastE);
    const lastSlow = lastFinite(slowE);
    if (!isFiniteNumber(lastFast) || !isFiniteNumber(lastSlow)) return undefined;

    const macd = macdSeries(
      candles.map((c) => c.close),
      Math.min(12, candles.length),
      Math.min(26, candles.length),
      Math.min(9, candles.length),
    );
    const lastHist = lastFinite(macd.histogram);
    if (!isFiniteNumber(lastHist)) return undefined;

    const adxOut = adxSeries(candles, Math.min(14, candles.length));
    const lastAdx = lastFinite(adxOut.adx);
    if (!isFiniteNumber(lastAdx)) return undefined;
    if (lastAdx < adxThreshold) return undefined;

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return undefined;

    const spread = lastFast - lastSlow;
    const longSignal = spread > 0 && lastHist > 0;
    const shortSignal = spread < 0 && lastHist < 0;
    if (!longSignal && !shortSignal) return undefined;

    // Confidence blends ADX strength (vs threshold) and normalized spread.
    const price = isFiniteNumber(ctx.price) ? ctx.price : lastCandle.close;
    const adxStrength = Math.min(1, Math.max(0, (lastAdx - adxThreshold) / 30));
    const spreadPct = price > 0 ? Math.min(1, Math.abs(spread) / price * 50) : 0;
    const histPct = price > 0 ? Math.min(1, Math.abs(lastHist) / price * 200) : 0;
    const confidence = clamp(0.5 + (adxStrength * 0.25) + (spreadPct * 0.15) + (histPct * 0.1), 0, 1);

    const direction: 'long' | 'short' = longSignal ? 'long' : 'short';
    const strategyId = (params['id'] as string) || 'trend';
    return {
      id: makeId(strategyId, direction),
      strategyId,
      kind: 'trend-following',
      time: ctx.nowMs ?? lastCandle.time * 1000,
      direction,
      price: lastCandle.close,
      confidence,
      reason: `EMA${fast} ${direction === 'long' ? 'above' : 'below'} EMA${slow} · MACD hist ${fmt(lastHist)} · ADX ${fmt(lastAdx)} > ${adxThreshold}`,
    };
  },
};

function isFiniteNumber(x: number): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(Math.max(x, lo), hi);
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  return x.toFixed(2);
}

/** Convenience wrapper that returns at most one signal from a config. */
export function evaluateTrendFollowing(
  candles: ReadonlyArray<import('@/types').Candle>,
  config: StrategyConfig,
  ctx: import('./types').StrategyRunContext,
): StrategySignal | undefined {
  if (!config.enabled) return undefined;
  return trendFollowingStrategy.evaluate(candles, { ...config.params, id: config.id }, ctx);
}

export { SIGNAL_PREFIX };
