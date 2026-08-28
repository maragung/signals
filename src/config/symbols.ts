import type { SymbolInfo } from '@/types';

// Default supported symbols. To add a new symbol, add a row here.
export const SYMBOLS: SymbolInfo[] = [
  {
    id: 'BTCUSD',
    display: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    category: 'crypto',
    providerIds: {
      binance: 'BTCUSDT',
      coingecko: 'bitcoin',
      binanceFutures: 'BTCUSDT',
    },
    pricePrecision: 2,
    volumePrecision: 2,
  },
  {
    id: 'XAUUSD',
    display: 'XAU/USD',
    base: 'XAU',
    quote: 'USD',
    category: 'metal',
    providerIds: {
      coingecko: 'gold-derived',
    },
    pricePrecision: 2,
    volumePrecision: 2,
  },
  {
    id: 'ETHUSDT',
    display: 'ETH/USDT',
    base: 'ETH',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'ETHUSDT',
      coingecko: 'ethereum',
      binanceFutures: 'ETHUSDT',
    },
    pricePrecision: 2,
    volumePrecision: 2,
  },
  {
    id: 'ETHBTC',
    display: 'ETH/BTC',
    base: 'ETH',
    quote: 'BTC',
    category: 'crypto',
    providerIds: {
      binance: 'ETHBTC',
    },
    pricePrecision: 6,
    volumePrecision: 3,
  },
  {
    id: 'BNBUSDT',
    display: 'BNB/USDT',
    base: 'BNB',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'BNBUSDT',
      coingecko: 'binancecoin',
      binanceFutures: 'BNBUSDT',
    },
    pricePrecision: 2,
    volumePrecision: 1,
  },
  {
    id: 'SOLUSDT',
    display: 'SOL/USDT',
    base: 'SOL',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'SOLUSDT',
      coingecko: 'solana',
      binanceFutures: 'SOLUSDT',
    },
    pricePrecision: 2,
    volumePrecision: 0,
  },
  {
    id: 'AVAXUSDT',
    display: 'AVAX/USDT',
    base: 'AVAX',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'AVAXUSDT',
      coingecko: 'avalanche-2',
      binanceFutures: 'AVAXUSDT',
    },
    pricePrecision: 3,
    volumePrecision: 0,
  },
  {
    id: 'SUIUSDT',
    display: 'SUI/USDT',
    base: 'SUI',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'SUIUSDT',
      coingecko: 'sui',
      binanceFutures: 'SUIUSDT',
    },
    pricePrecision: 4,
    volumePrecision: 0,
  },
];

export const DEFAULT_SYMBOL_ID = 'BTCUSD';

export function findSymbol(id: string): SymbolInfo | undefined {
  return SYMBOLS.find((s) => s.id === id);
}
