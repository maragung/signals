// Unified market structure detector returning both swing points and BOS/CHOCH events.

import type { Candle, MarketStructureEvent, MarketStructurePoint } from '@/types';
import { detectMarketStructure, type StructureOptions } from './structure';
import { detectBosChocho, type BosChochOptions } from './bos-choch';

export interface StructureDetectorOptions extends BosChochOptions {}

export interface StructureResult {
  points: MarketStructurePoint[];
  events: MarketStructureEvent[];
}

export function detectStructure(
  candles: Candle[],
  options: Partial<StructureDetectorOptions> = {},
): StructureResult {
  const points = detectMarketStructure(candles, options);
  const events = detectBosChocho(candles, options);
  return { points, events };
}

export function defaultStructureOptions(): BosChochOptions {
  return { lookback: 2, tolerance: 0.1, onlyFirstBreak: true };
}
