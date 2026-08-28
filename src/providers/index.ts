// Barrel export for the providers module and factory for the manager.

import { SYMBOLS } from '@/config/symbols';
import type { SymbolInfo } from '@/types';
import { BinanceProvider, type BinanceProviderOptions } from './binance';
import { CoinGeckoProvider, type CoinGeckoProviderOptions } from './coingecko';
import { ProviderManager } from './manager';
import { fetchMultiTimeframe } from './multi-timeframe';

export { BinanceProvider } from './binance';
export type { BinanceProviderOptions } from './binance';
export { CoinGeckoProvider } from './coingecko';
export type { CoinGeckoProviderOptions } from './coingecko';
export { ProviderManager, BACKOFF_SEQUENCE_MS } from './manager';
export type { ProviderManagerOptions } from './manager';
export { fetchMultiTimeframe } from './multi-timeframe';
export type { MultiTimeframeResult, MultiTimeframeOptions } from './multi-timeframe';
export type {
  MarketDataProvider,
  CandleCallback,
  TickerCallback,
  StatusCallback,
  Unsubscribe,
  HistoricalCandleOptions,
} from './types';
export { TIMEFRAME_TO_BINANCE } from './types';
export {
  isBrowser,
  hasWebSocket,
  backoffDelay,
  randomFloat,
  sanitizeCandle,
  sanitizeTicker,
  aggregateTicksToCandles,
} from './_utils';

export interface CreateProviderManagerOptions {
  binance?: BinanceProviderOptions;
  coingecko?: CoinGeckoProviderOptions;
  symbols?: SymbolInfo[];
  manager?: ConstructorParameters<typeof ProviderManager>[0];
}

/**
 * Build a ProviderManager pre-wired with the default Binance and
 * CoinGecko providers, registered with the supplied (or default) symbols.
 */
export function createProviderManager(options: CreateProviderManagerOptions = {}): ProviderManager {
  const symbols = options.symbols ?? SYMBOLS;
  const manager = new ProviderManager(options.manager);

  const binance = new BinanceProvider(options.binance ?? {});
  const coingecko = new CoinGeckoProvider(options.coingecko ?? {});

  for (const s of symbols) {
    binance.registerSymbol(s);
    coingecko.registerSymbol(s);
  }

  manager.registerProvider(binance);
  manager.registerProvider(coingecko);

  return manager;
}
