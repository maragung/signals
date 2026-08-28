// Mean-reversion strategy.
//
// Looks for oversold / overbought extremes via RSI, confirmed by price
// tagging the lower / upper Bollinger band. Issues a long signal in
// oversold conditions, a short signal in overbought conditions.

import type { Candle, StrategyConfig, StrategySignal } from '@/types';
import { bollinger, lastFinite, rsiSeries } from './indicators';
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

export const meanReversionStrategy: StrategyImpl = {
  id: 'mean-reversion',
  kind: 'mean-reversion',
  evaluate(
    candles: ReadonlyArray<Candle>,
    params: Record<string, number | string | boolean>,
    ctx: StrategyRunContext,
  ): StrategySignal | undefined {
    if (candles.length < 30) return undefined;
    const rsiLower = numParam(params, 'rsiLower', 30);
    const rsiUpper = numParam(params, 'rsiUpper', 70);
    const bbStddev = numParam(params, 'bbStddev', 2);
    const bbPeriod = numParam(params, 'bbPeriod', 20);

    const closes = candles.map((c) => c.close);
    const rsi = rsiSeries(closes, Math.min(14, candles.length - 1));
    const bb = bollinger(closes, Math.min(bbPeriod, candles.length), bbStddev);
    const lastRsi = lastFinite(rsi);
    const lastClose = candles[candles.length - 1]?.close ?? NaN;
    const upper = lastFinite(bb.upper);
    const lower = lastFinite(bb.lower);
    if (!isFiniteNumber(lastRsi) || !isFiniteNumber(lastClose)) return undefined;

    // Determine whether the price is near the lower / upper band.
    const proximityPct = (p: number, band: number): number => {
      if (!isFiniteNumber(band) || band === 0) return 0;
      return Math.abs(p - band) / Math.abs(band);
    };
    const nearLower = isFiniteNumber(lower) && lastClose <= lower * 1.005;
    const nearUpper = isFiniteNumber(upper) && lastClose >= upper * 0.995;

    let direction: 'long' | 'short' | null = null;
    if (lastRsi < rsiLower && nearLower) direction = 'long';
    else if (lastRsi > rsiUpper && nearUpper) direction = 'short';
    if (direction === null) return undefined;

    const rsiDepth = direction === 'long' ? (rsiLower - lastRsi) / rsiLower : (lastRsi - rsiUpper) / (100 - rsiUpper);
    const bandDepth = direction === 'long'
      ? proximityPct(lastClose, lower)
      : proximityPct(lastClose, upper);
    const confidence = clamp(0.55 + Math.min(0.3, rsiDepth * 0.5) + Math.min(0.15, bandDepth * 5), 0, 1);

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return undefined;
    const strategyId = (params['id'] as string) || 'meanrev';
    return {
      id: makeId(strategyId, direction),
      strategyId,
      kind: 'mean-reversion',
      time: ctx.nowMs ?? lastCandle.time * 1000,
      direction,
      price: lastCandle.close,
      confidence,
      reason: `RSI ${lastRsi.toFixed(1)} ${direction === 'long' ? 'oversold' : 'overbought'} · near ${direction === 'long' ? 'lower' : 'upper'} BB`,
    };
  },
};

export function evaluateMeanReversion(
  candles: ReadonlyArray<Candle>,
  config: StrategyConfig,
  ctx: StrategyRunContext,
): StrategySignal | undefined {
  if (!config.enabled) return undefined;
  return meanReversionStrategy.evaluate(candles, { ...config.params, id: config.id }, ctx);
}
