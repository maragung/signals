import type { AppSettings, IndicatorConfig, StrategyConfig, Timeframe } from '@/types';
import { DEFAULT_SCORING_WEIGHTS } from './scoring';

export const DEFAULT_TIMEFRAME: Timeframe = '1h';

export const DEFAULT_INDICATOR_CONFIGS: IndicatorConfig[] = [
  { id: 'ema9', kind: 'ema', enabled: true, params: { period: 9 }, color: '#f6a609', panel: 'overlay' },
  { id: 'ema21', kind: 'ema', enabled: true, params: { period: 21 }, color: '#3b82f6', panel: 'overlay' },
  { id: 'ema50', kind: 'ema', enabled: false, params: { period: 50 }, color: '#a855f7', panel: 'overlay' },
  { id: 'ema200', kind: 'ema', enabled: false, params: { period: 200 }, color: '#ef4444', panel: 'overlay' },
  { id: 'sma20', kind: 'sma', enabled: false, params: { period: 20 }, color: '#22d3ee', panel: 'overlay' },
  { id: 'sma50', kind: 'sma', enabled: false, params: { period: 50 }, color: '#10b981', panel: 'overlay' },
  { id: 'rsi14', kind: 'rsi', enabled: true, params: { period: 14 }, color: '#a78bfa', panel: 'separate' },
  { id: 'macd', kind: 'macd', enabled: false, params: { fast: 12, slow: 26, signal: 9 }, panel: 'separate' },
  { id: 'bbands', kind: 'bbands', enabled: false, params: { period: 20, stddev: 2 }, panel: 'overlay' },
  { id: 'atr14', kind: 'atr', enabled: false, params: { period: 14 }, panel: 'separate' },
  { id: 'adx14', kind: 'adx', enabled: false, params: { period: 14 }, panel: 'separate' },
  { id: 'vwap', kind: 'vwap', enabled: false, params: {}, color: '#eab308', panel: 'overlay' },
  { id: 'stochrsi', kind: 'stochrsi', enabled: false, params: { rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3 }, panel: 'separate' },
  { id: 'stoch', kind: 'stoch', enabled: false, params: { k: 14, d: 3, smooth: 3 }, panel: 'separate' },
  { id: 'cci', kind: 'cci', enabled: false, params: { period: 20 }, panel: 'separate' },
  { id: 'roc', kind: 'roc', enabled: false, params: { period: 12 }, panel: 'separate' },
  { id: 'williamsr', kind: 'williamsr', enabled: false, params: { period: 14 }, panel: 'separate' },
  { id: 'mfi', kind: 'mfi', enabled: false, params: { period: 14 }, panel: 'separate' },
  { id: 'obv', kind: 'obv', enabled: false, params: {}, panel: 'separate' },
  { id: 'cmf', kind: 'cmf', enabled: false, params: { period: 20 }, panel: 'separate' },
  { id: 'supertrend', kind: 'supertrend', enabled: false, params: { period: 10, multiplier: 3 }, panel: 'overlay' },
  { id: 'wma', kind: 'wma', enabled: false, params: { period: 20 }, panel: 'overlay' },
  { id: 'keltner', kind: 'keltner', enabled: false, params: { period: 20, multiplier: 2 }, panel: 'overlay' },
  { id: 'bbwidth', kind: 'bbwidth', enabled: false, params: { period: 20, stddev: 2 }, panel: 'separate' },
  { id: 'volumesma', kind: 'volumesma', enabled: false, params: { period: 20 }, panel: 'separate' },
];

export const DEFAULT_STRATEGY_CONFIGS: StrategyConfig[] = [
  { id: 'trend', kind: 'trend-following', enabled: true, params: { emaFast: 9, emaSlow: 21, adxThreshold: 20 } },
  { id: 'meanrev', kind: 'mean-reversion', enabled: false, params: { rsiLower: 30, rsiUpper: 70, bbStddev: 2 } },
  { id: 'breakout', kind: 'breakout', enabled: false, params: { atrMult: 1.5, volMult: 1.5 } },
  { id: 'snd', kind: 'supply-demand', enabled: false, params: { minStrength: 0.4 } },
  { id: 'mtf', kind: 'mtf-trend', enabled: true, params: { scoreThreshold: 0.1 } },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  symbol: 'BTCUSD',
  timeframe: DEFAULT_TIMEFRAME,
  chartType: 'candles',
  overlays: {
    indicators: true,
    strategies: true,
    snr: true,
    snd: true,
    structure: true,
    bos: true,
    choch: true,
    liquidity: true,
    fibonacci: true,
    trendlines: true,
    signals: true,
    entry: true,
    tp: true,
    sl: true,
    volume: true,
    liquidationHeatmap: true,
  },
  scoringWeights: { ...DEFAULT_SCORING_WEIGHTS },
  fibConfig: {
    retracements: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    extensions: [1, 1.272, 1.618, 2, 2.618],
    auto: true,
  },
  indicatorConfigs: DEFAULT_INDICATOR_CONFIGS,
  strategyConfigs: DEFAULT_STRATEGY_CONFIGS,
};
