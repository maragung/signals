// Multi-timeframe analysis engine.
//
// `analyzeMTF` fetches candles for each requested timeframe (via the
// supplied `DataFetcher`), evaluates the local bias for each cell
// (trend / momentum / structure / volume), and combines them with a
// weighted sum into a single `MTFAnalysis` result. Timeframe weight
// is 1d > 4h > 1h > 15m > 5m by default, but can be overridden.

import type {
  Bias,
  Candle,
  MarketStructureEvent,
  MTFAnalysis,
  MTFCell,
  Timeframe,
} from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { ema, lastFinite, macdSeries, rsiSeries, sma } from '@/core/strategies/indicators';

export interface DataFetcher {
  fetchCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]>;
}

export interface MTFSettings {
  /** EMA fast / slow periods. */
  emaFast?: number;
  emaSlow?: number;
  /** RSI period. */
  rsiPeriod?: number;
  /** Lookback for swing structure detection. */
  structureLookback?: number;
  /** Lookback for volume baseline. */
  volumeLookback?: number;
  /** Custom timeframe weights (per-timeframe). */
  timeframeWeights?: Partial<Record<Timeframe, number>>;
}

const DEFAULT_TF_WEIGHTS: Record<Timeframe, number> = {
  '1m': 0.5,
  '3m': 0.6,
  '5m': 0.7,
  '15m': 0.9,
  '30m': 1.0,
  '1h': 1.5,
  '2h': 1.6,
  '4h': 2.0,
  '6h': 1.8,
  '12h': 1.9,
  '1d': 3.0,
  '1w': 2.4,
  '1M': 2.2,
};

const STRUCTURE_BULL_THRESHOLD = 0.55;
const STRUCTURE_BEAR_THRESHOLD = 0.45;

export async function analyzeMTF(
  symbol: string,
  timeframes: ReadonlyArray<Timeframe>,
  dataProvider: DataFetcher,
  settings: MTFSettings = {},
): Promise<MTFAnalysis> {
  const cells: MTFCell[] = [];
  for (const tf of timeframes) {
    let candles: Candle[] = [];
    try {
      candles = await dataProvider.fetchCandles(symbol, tf);
    } catch {
      candles = [];
    }
    cells.push(evaluateCell(tf, candles, settings));
  }
  return combineCells(cells, settings);
}

export function evaluateCell(
  timeframe: Timeframe,
  candles: ReadonlyArray<Candle>,
  settings: MTFSettings = {},
): MTFCell {
  const emaFast = Math.max(2, Math.floor(settings.emaFast ?? 9));
  const emaSlow = Math.max(emaFast + 1, Math.floor(settings.emaSlow ?? 21));
  const rsiPeriod = Math.max(2, Math.floor(settings.rsiPeriod ?? 14));
  const structureLookback = Math.max(5, Math.floor(settings.structureLookback ?? 30));
  const volumeLookback = Math.max(2, Math.floor(settings.volumeLookback ?? 20));

  const closes = candles.map((c) => c.close);
  const fastE = ema(closes, Math.min(emaFast, Math.max(2, candles.length)));
  const slowE = ema(closes, Math.min(emaSlow, Math.max(3, candles.length)));
  const lastFast = lastFinite(fastE);
  const lastSlow = lastFinite(slowE);
  const lastClose = closes[closes.length - 1] ?? NaN;

  // Trend bias: EMA alignment.
  let trend: Bias = 'neutral';
  if (isFiniteNum(lastFast) && isFiniteNum(lastSlow) && isFiniteNum(lastClose)) {
    if (lastFast > lastSlow && lastClose > lastFast) trend = 'bullish';
    else if (lastFast < lastSlow && lastClose < lastFast) trend = 'bearish';
  }

  // Momentum bias: RSI + MACD histogram sign.
  let momentum: Bias = 'neutral';
  if (candles.length > rsiPeriod + 1) {
    const rsi = rsiSeries(closes, Math.min(rsiPeriod, Math.max(2, candles.length - 1)));
    const lastRsi = lastFinite(rsi);
    const macd = macdSeries(
      closes,
      Math.min(12, Math.max(2, candles.length)),
      Math.min(26, Math.max(3, candles.length)),
      Math.min(9, Math.max(2, candles.length)),
    );
    const hist = lastFinite(macd.histogram);
    let bull = 0;
    let bear = 0;
    if (isFiniteNum(lastRsi)) {
      if (lastRsi > 55) bull++;
      if (lastRsi < 45) bear++;
      if (lastRsi > 65) bull++;
      if (lastRsi < 35) bear++;
    }
    if (isFiniteNum(hist)) {
      if (hist > 0) bull++;
      if (hist < 0) bear++;
    }
    if (bull > bear) momentum = 'bullish';
    else if (bear > bull) momentum = 'bearish';
  }

  // Structure bias: swing-point tally in the lookback window.
  let structure: Bias = 'neutral';
  if (candles.length >= structureLookback) {
    const window = candles.slice(candles.length - structureLookback);
    const { bull, bear } = swingTally(window);
    const total = bull + bear;
    if (total > 0) {
      const bullRatio = bull / total;
      if (bullRatio > STRUCTURE_BULL_THRESHOLD) structure = 'bullish';
      else if (bullRatio < STRUCTURE_BEAR_THRESHOLD) structure = 'bearish';
    }
  }

  // Volume bias: most recent bar vs the volume SMA, signed by direction.
  let volume: Bias = 'neutral';
  if (candles.length >= volumeLookback + 1) {
    const vols = candles.slice(candles.length - volumeLookback).map((c) => c.volume);
    const avg = sma(vols, vols.length);
    const lastVol = vols[vols.length - 1];
    const lastAvg = avg[avg.length - 1];
    const lastDir = (closes[closes.length - 1] ?? 0) - (closes[closes.length - 2] ?? 0);
    if (isFiniteNum(lastAvg) && lastAvg > 0 && isFiniteNum(lastVol)) {
      if (lastVol > lastAvg * 1.2 && lastDir > 0) volume = 'bullish';
      else if (lastVol > lastAvg * 1.2 && lastDir < 0) volume = 'bearish';
    }
  }

  // Per-cell score in [-1, 1].
  const score =
    biasToNumber(trend) +
    biasToNumber(momentum) +
    biasToNumber(structure) +
    biasToNumber(volume);
  const cellScore = Math.max(-1, Math.min(1, score / 4));

  return { timeframe, trend, momentum, structure, volume, score: cellScore };
}

export function combineCells(
  cells: ReadonlyArray<MTFCell>,
  settings: MTFSettings = {},
): MTFAnalysis {
  const weights: Record<Timeframe, number> = { ...DEFAULT_TF_WEIGHTS, ...(settings.timeframeWeights ?? {}) };
  let totalWeight = 0;
  let weightedScore = 0;
  let bullVotes = 0;
  let bearVotes = 0;
  for (const cell of cells) {
    const w = weights[cell.timeframe] ?? 1;
    totalWeight += Math.abs(w);
    weightedScore += cell.score * w;
    if (cell.trend === 'bullish' || cell.momentum === 'bullish' || cell.structure === 'bullish') bullVotes++;
    if (cell.trend === 'bearish' || cell.momentum === 'bearish' || cell.structure === 'bearish') bearVotes++;
  }
  const mtfScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  let overall: Bias = 'neutral';
  if (mtfScore > 0.15 || bullVotes > bearVotes + 1) overall = 'bullish';
  else if (mtfScore < -0.15 || bearVotes > bullVotes + 1) overall = 'bearish';
  return {
    cells: cells.slice(),
    overallBias: overall,
    mtfScore,
    generatedAt: Date.now(),
  };
}

function swingTally(window: ReadonlyArray<Candle>): { bull: number; bear: number } {
  let hh = 0;
  let hl = 0;
  let lh = 0;
  let ll = 0;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 1; i < window.length - 1; i++) {
    const c = window[i]!;
    const a = window[i - 1]!;
    const b = window[i + 1]!;
    if (c.high > a.high && c.high > b.high) highs.push(c.high);
    if (c.low < a.low && c.low < b.low) lows.push(c.low);
  }
  for (let i = 1; i < highs.length; i++) {
    if (highs[i]! > highs[i - 1]!) hh++;
    else if (highs[i]! < highs[i - 1]!) lh++;
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i]! > lows[i - 1]!) hl++;
    else if (lows[i]! < lows[i - 1]!) ll++;
  }
  return { bull: hh + hl, bear: lh + ll };
}

function biasToNumber(b: Bias): number {
  if (b === 'bullish') return 1;
  if (b === 'bearish') return -1;
  return 0;
}

// Re-export helpers so tests can construct candles in a uniform way.
export { ema, rsiSeries, sma, macdSeries };

export type { MarketStructureEvent };
