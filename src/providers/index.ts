// Barrel export for the providers module and factory for the manager.

import { SYMBOLS } from '@/config/symbols';
import type { SymbolInfo } from '@/types';
import type { MarketDataProvider } from './types';
import { BinanceProvider, type BinanceProviderOptions } from './binance';
import { BybitProvider, type BybitProviderOptions } from './bybit';
import { CoinGeckoProvider, type CoinGeckoProviderOptions } from './coingecko';
import { OkxProvider, type OkxProviderOptions } from './okx';
import { GateProvider, type GateProviderOptions } from './gate';
import { BitgetProvider, type BitgetProviderOptions } from './bitget';
import { ProviderManager } from './manager';
import { fetchMultiTimeframe } from './multi-timeframe';

export { BinanceProvider } from './binance';
export type { BinanceProviderOptions } from './binance';
export { BybitProvider } from './bybit';
export type { BybitProviderOptions } from './bybit';
export { CoinGeckoProvider } from './coingecko';
export type { CoinGeckoProviderOptions } from './coingecko';
export { OkxProvider } from './okx';
export type { OkxProviderOptions } from './okx';
export { GateProvider } from './gate';
export type { GateProviderOptions } from './gate';
export { BitgetProvider } from './bitget';
export type { BitgetProviderOptions } from './bitget';
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
  bybit?: BybitProviderOptions;
  okx?: OkxProviderOptions;
  gate?: GateProviderOptions;
  bitget?: BitgetProviderOptions;
  coingecko?: CoinGeckoProviderOptions;
  symbols?: SymbolInfo[];
  manager?: ConstructorParameters<typeof ProviderManager>[0];
}

/**
 * Build a ProviderManager pre-wired with the full spot-provider fallback chain
 * (Binance -> Bybit -> OKX -> Gate -> Bitget -> CoinGecko), registered with the
 * supplied (or default) symbols. Each symbol is registered with every provider
 * that lists it in its `providerIds` map.
 */
export function createProviderManager(options: CreateProviderManagerOptions = {}): ProviderManager {
  const symbols = options.symbols ?? SYMBOLS;
  const manager = new ProviderManager(options.manager);

  const binance = new BinanceProvider(options.binance ?? {});
  const bybit = new BybitProvider(options.bybit ?? {});
  const okx = new OkxProvider(options.okx ?? {});
  const gate = new GateProvider(options.gate ?? {});
  const bitget = new BitgetProvider(options.bitget ?? {});
  const coingecko = new CoinGeckoProvider(options.coingecko ?? {});

  const providers: MarketDataProvider[] = [binance, bybit, okx, gate, bitget, coingecko];

  for (const s of symbols) {
    binance.registerSymbol(s);
    bybit.registerSymbol(s);
    okx.registerSymbol(s);
    gate.registerSymbol(s);
    bitget.registerSymbol(s);
    coingecko.registerSymbol(s);
  }

  for (const p of providers) {
    manager.registerProvider(p);
  }

  return manager;
}

