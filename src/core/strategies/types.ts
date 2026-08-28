// Internal types shared across the strategy engine.
//
// Strategies are pure functions of candles + their own config; the
// surrounding context (scoring, MTF, structure, SNR, SND, ATR) is
// passed in through the run context.

import type {
  Candle,
  MarketStructureEvent,
  MTFAnalysis,
  ScoringResult,
  StrategySignal,
  SupplyDemandZone,
  SupportResistanceLevel,
  Timeframe,
} from '@/types';

export interface StrategyRunContext {
  /** Symbol being evaluated (e.g. "BTCUSD"). */
  symbol: string;
  /** Primary timeframe the strategy is running on. */
  timeframe: Timeframe;
  /** Current ATR (in price units) for stop / volatility context. */
  atr: number;
  /** Last close price. */
  price: number;
  /** Pre-computed scoring result for the same candle window. */
  scoring?: ScoringResult;
  /** Pre-computed multi-timeframe analysis. */
  mtf?: MTFAnalysis;
  /** Detected market structure events (BOS / CHOCH). */
  structure?: MarketStructureEvent[];
  /** Detected support / resistance levels. */
  snr?: SupportResistanceLevel[];
  /** Detected supply / demand zones. */
  snd?: SupplyDemandZone[];
  /** Wall clock time (ms) used to stamp signals. */
  nowMs?: number;
}

/** A single strategy implementation. */
export interface StrategyImpl {
  /** Identifier matching `StrategyConfig.id` (e.g. "trend"). */
  readonly id: string;
  /** Strategy kind discriminator. */
  readonly kind: StrategySignal['kind'];
  /**
   * Evaluate candles + config + context. Should return at most one
   * signal per call (or undefined if no signal fires).
   */
  evaluate(
    candles: ReadonlyArray<Candle>,
    params: Record<string, number | string | boolean>,
    ctx: StrategyRunContext,
  ): StrategySignal | undefined;
}

/** Helper: extract a numeric param with a default. */
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

/** Helper: extract a string param with a default. */
export function strParam(
  params: Record<string, number | string | boolean> | undefined,
  key: string,
  fallback: string,
): string {
  if (!params) return fallback;
  const v = params[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return fallback;
}
