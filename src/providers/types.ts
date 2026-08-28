// Public interface every market data provider must implement.

import type { Candle, ConnectionStatus, SymbolInfo, TickerData, Timeframe } from '@/types';

export type { Candle, ConnectionStatus, SymbolInfo, TickerData, Timeframe };

/** Callback invoked when a new (or updated) candle is received. */
export type CandleCallback = (candle: Candle) => void;

/** Callback invoked when a ticker update is received. */
export type TickerCallback = (ticker: TickerData) => void;

/** Status callback for a single subscription. */
export type StatusCallback = (status: ConnectionStatus) => void;

/** An unsubscribe function. Calling it more than once is a no-op. */
export type Unsubscribe = () => void;

export interface HistoricalCandleOptions {
  /** Optional end time in unix seconds. Defaults to now. */
  endTime?: number;
}

export interface MarketDataProvider {
  /** Stable identifier (e.g. "binance", "coingecko"). */
  readonly name: string;

  /** Returns the symbol info if this provider can serve it, else undefined. */
  getSymbolInfo(id: string): SymbolInfo | undefined;

  /** Fetch historical candles. Throws are caught by the manager. */
  getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]>;

  /**
   * Subscribe to live candle updates for a (symbol, timeframe).
   * Returns an unsubscribe function. Independent subscriptions do not affect each other.
   */
  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe;

  /**
   * Subscribe to ticker updates for a symbol.
   * Returns an unsubscribe function.
   */
  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe;
}

/** Timeframe conversions to Binance's interval parameter. */
export const TIMEFRAME_TO_BINANCE: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '6h': '6h',
  '12h': '12h',
  '1d': '1d',
  '1w': '1w',
  '1M': '1M',
};
