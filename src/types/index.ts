// Core domain types for the price prediction terminal

export type Timeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w'
  | '1M';

export const TIMEFRAMES: Timeframe[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
  '1w',
  '1M',
];

export function tfToSeconds(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '2h': 7200,
    '4h': 14400,
    '6h': 21600,
    '12h': 43200,
    '1d': 86400,
    '1w': 604800,
    '1M': 2592000,
  };
  return map[tf];
}

export function tfToMs(tf: Timeframe): number {
  return tfToSeconds(tf) * 1000;
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolInfo {
  id: string; // internal canonical id, e.g. "BTCUSD"
  display: string; // "BTC/USD"
  base: string;
  quote: string;
  category: 'crypto' | 'metal' | 'forex';
  providerIds: Record<string, string>; // provider -> provider's symbol
  pricePrecision: number;
  volumePrecision: number;
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed';

export interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  timestamp: number;
}

export type IndicatorKind =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'vwap'
  | 'macd'
  | 'adx'
  | 'supertrend'
  | 'rsi'
  | 'stochrsi'
  | 'stoch'
  | 'cci'
  | 'roc'
  | 'williamsr'
  | 'mfi'
  | 'atr'
  | 'bbands'
  | 'bbwidth'
  | 'keltner'
  | 'volume'
  | 'volumesma'
  | 'obv'
  | 'cmf';

export interface IndicatorConfig {
  id: string;
  kind: IndicatorKind;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  color?: string;
  panel?: 'overlay' | 'separate';
}

export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface ScoreBreakdown {
  trend: number;
  momentum: number;
  volume: number;
  structure: number;
  snr: number;
  snd: number;
  volatility: number;
  mtf: number;
}

export interface ScoringResult {
  bullish: number;
  bearish: number;
  net: number;
  total: number;
  label:
    | 'Strong Bullish'
    | 'Bullish'
    | 'Weak Bullish'
    | 'Neutral'
    | 'Weak Bearish'
    | 'Bearish'
    | 'Strong Bearish';
  bias: Bias;
  breakdown: ScoreBreakdown;
}

export interface SupportResistanceLevel {
  id: string;
  price: number;
  type: 'support' | 'resistance';
  strength: number; // 0..1
  touches: number;
  kind: 'major' | 'minor' | 'psychological' | 'swing-high' | 'swing-low' | 'prev-high' | 'prev-low' | 'prev-close';
  zone?: { high: number; low: number };
}

export interface SupplyDemandZone {
  id: string;
  type: 'supply' | 'demand';
  high: number;
  low: number;
  originTime: number;
  status: 'fresh' | 'tested' | 'broken';
  strength: number; // 0..1
  base?: { high: number; low: number };
  pattern: 'base-rally' | 'base-drop' | 'rally-base-rally' | 'drop-base-drop';
}

export interface MarketStructurePoint {
  time: number;
  price: number;
  kind: 'HH' | 'HL' | 'LH' | 'LL' | 'EQH' | 'EQL';
}

export interface MarketStructureEvent {
  time: number;
  price: number;
  kind: 'BOS' | 'CHOCH';
  direction: 'bullish' | 'bearish';
}

export interface FibonacciLevel {
  ratio: number;
  price: number;
  visible: boolean;
}

export interface FibConfig {
  retracements: number[];
  extensions: number[];
  auto: boolean;
}

export interface DrawingObject {
  id: string;
  kind:
    | 'trendline'
    | 'hline'
    | 'vline'
    | 'ray'
    | 'rect'
    | 'pricerange'
    | 'daterange'
    | 'fib-retracement'
    | 'fib-extension'
    | 'text'
    | 'arrow'
    | 'measure';
  points: { time: number; price: number }[];
  options: Record<string, number | string | boolean>;
  symbol: string;
  timeframe: Timeframe;
  createdAt: number;
}

export interface AlertItem {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  kind:
    | 'price-cross'
    | 'break-resistance'
    | 'break-support'
    | 'rsi-threshold'
    | 'macd-crossover'
    | 'ema-crossover'
    | 'bos'
    | 'choch'
    | 'supply-entry'
    | 'demand-entry'
    | 'strategy-signal';
  params: Record<string, number | string>;
  active: boolean;
  triggeredAt?: number;
  createdAt: number;
}

export interface ProjectionLevel {
  label: string;
  price: number;
}

export interface TechnicalProjection {
  symbol: string;
  timeframe: Timeframe;
  direction: Bias;
  score: number;
  total: number;
  confidence: number; // 0..1
  entryZone?: { low: number; high: number };
  support?: number;
  resistance?: number;
  targets: ProjectionLevel[];
  invalidation?: number;
  riskReward?: number;
  expectedVolatility?: number; // in percent
  disclaimer: string;
  generatedAt: number;
}

export interface MTFCell {
  timeframe: Timeframe;
  trend: Bias;
  momentum: Bias;
  structure: Bias;
  volume: Bias;
  score: number;
}

export interface MTFAnalysis {
  cells: MTFCell[];
  overallBias: Bias;
  mtfScore: number;
  generatedAt: number;
}

export interface StrategyConfig {
  id: string;
  kind: 'trend-following' | 'mean-reversion' | 'breakout' | 'supply-demand' | 'mtf-trend';
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  color?: string;
}

export interface StrategySignal {
  id: string;
  strategyId: string;
  kind: StrategyConfig['kind'];
  time: number;
  direction: 'long' | 'short' | 'close';
  price: number;
  confidence: number; // 0..1
  reason: string;
}

export type Theme = 'dark' | 'light';

// Provider callback types
export type CandleCallback = (candle: Candle) => void;
export type TickerCallback = (ticker: TickerData) => void;
export type StatusCallback = (status: ConnectionStatus) => void;
export type Unsubscribe = () => void;

// Liquidation heatmap types
export type LiquidationSide = 'long' | 'short';

export interface LiquidationEvent {
  time: number; // unix ms
  symbol: string;
  side: LiquidationSide;
  price: number;
  quantity: number; // base asset qty
  notional: number; // USD notional
}

export interface LiquidationLevel {
  price: number;
  longLiq: number; // estimated USD notional of long liquidations clustered at this level
  shortLiq: number; // estimated USD notional of short liquidations clustered at this level
}

export interface LiquidationHeatmap {
  symbol: string;
  generatedAt: number;
  source: 'live' | 'synthetic';
  levels: LiquidationLevel[];
  totalLongLiq: number;
  totalShortLiq: number;
  recentEvents: LiquidationEvent[];
  meta: {
    markPrice?: number;
    indexPrice?: number;
    openInterest?: number;
    openInterestUsd?: number;
    fundingRate?: number;
    longShortRatio?: number;
    takerBuySellRatio?: number;
  };
}

/**
 * Result of attempting to fetch futures data. `blocked` is true when
 * the upstream returned a 451 (geo-blocked) or 403 (forbidden),
 * which means we should stop trying to subscribe to the live
 * liquidation stream and just show a friendly "unavailable in your
 * region" message instead of an error.
 */
export interface FuturesDataResult {
  snapshot: FuturesSnapshot | null;
  events: LiquidationEvent[];
  blocked: boolean;
  /** True when the snapshot is from cached or fallback sources, not live. */
  degraded: boolean;
}

export interface FuturesSnapshot {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  openInterest: number; // base
  openInterestUsd: number;
  longShortRatio: number;
  takerBuySellRatio: number;
  ts: number;
}

export interface AppSettings {
  theme: Theme;
  symbol: string;
  timeframe: Timeframe;
  chartType: 'candles' | 'line' | 'area' | 'ohlc';
  overlays: {
    indicators: boolean;
    strategies: boolean;
    snr: boolean;
    snd: boolean;
    structure: boolean;
    bos: boolean;
    choch: boolean;
    liquidity: boolean;
    fibonacci: boolean;
    trendlines: boolean;
    signals: boolean;
    entry: boolean;
    tp: boolean;
    sl: boolean;
    volume: boolean;
    liquidationHeatmap: boolean;
  };
  scoringWeights: ScoreBreakdown;
  fibConfig: FibConfig;
  indicatorConfigs: IndicatorConfig[];
  strategyConfigs: StrategyConfig[];
}
