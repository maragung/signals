// Shared types for the technical indicator engine.
//
// All indicator functions are pure: they accept a readonly Candle array
// and return arrays of numbers of the same length. NaN is used as the
// "insufficient warmup" sentinel.

import type { Candle, IndicatorConfig, IndicatorKind } from '@/types';

export type { IndicatorConfig, IndicatorKind };

/** A single point on a chart panel: a value at a specific candle time. */
export interface IndicatorPoint {
  time: number;
  value: number;
  color?: string;
}

/** A single point on a separate chart panel; carries a name for legend use. */
export interface IndicatorNamedPoint extends IndicatorPoint {
  name?: string;
}

/** A series rendered on the main price panel (overlay). */
export type IndicatorSeries = ReadonlyArray<IndicatorPoint>;

/** A series rendered on its own panel below the chart. */
export type IndicatorNamedSeries = ReadonlyArray<IndicatorNamedPoint>;

/** Result returned by the indicator dispatcher. */
export interface IndicatorResult {
  /** Identifier matching the originating IndicatorConfig.id */
  id: string;
  /** Indicator kind that produced this result */
  kind: IndicatorKind;
  /** Series to draw on the price overlay (e.g. SMA, BBands, Supertrend).
   *  Each entry is a single point `{ time, value, color? }`. For multi-line
   *  overlays (e.g. Bollinger Bands) all points are concatenated in order. */
  overlay?: IndicatorSeries;
  /** Series to draw on a separate panel (e.g. RSI, MACD histogram). Each
   *  entry is `{ time, value, color?, name? }`; for multi-line panels
   *  (MACD, Stochastic, ADX) all points are concatenated in order. */
  separate?: IndicatorNamedSeries;
  /** Optional metadata (extra computed values such as MACD signal etc.) */
  meta?: Record<string, unknown>;
}

/** Number produced by a pure indicator function: same length as input. */
export type IndicatorOutput = ReadonlyArray<number>;

/** A read-only candle input view for indicator implementations. */
export type CandleInput = ReadonlyArray<Candle>;

/** Helper to extract a numeric param with a default value. */
export function numParam(
  params: Record<string, number | string | boolean> | undefined,
  key: string,
  fallback: number,
): number {
  if (!params) return fallback;
  const v = params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
