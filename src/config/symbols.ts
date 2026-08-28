import type { SymbolInfo } from '@/types';

// Default supported symbols. To add a new symbol, add a row here.
// The array is sorted A-Z by id so the watchlist/sidebar order is
// deterministic and never drifts.
const RAW_SYMBOLS: SymbolInfo[] = [
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
      bybit: 'BTCUSDT',
      okx: 'BTC-USDT',
      gate: 'BTC_USDT',
      bitget: 'BTCUSDT',
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
      bybit: 'ETHUSDT',
      okx: 'ETH-USDT',
      gate: 'ETH_USDT',
      bitget: 'ETHUSDT',
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
      bybit: 'ETHBTC',
      okx: 'ETH-BTC',
      gate: 'ETH_BTC',
      bitget: 'ETHBTC',
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
      bybit: 'BNBUSDT',
      okx: 'BNB-USDT',
      gate: 'BNB_USDT',
      bitget: 'BNBUSDT',
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
      bybit: 'SOLUSDT',
      okx: 'SOL-USDT',
      gate: 'SOL_USDT',
      bitget: 'SOLUSDT',
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
      bybit: 'AVAXUSDT',
      okx: 'AVAX-USDT',
      gate: 'AVAX_USDT',
      bitget: 'AVAXUSDT',
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
      bybit: 'SUIUSDT',
      okx: 'SUI-USDT',
      gate: 'SUI_USDT',
      bitget: 'SUIUSDT',
    },
    pricePrecision: 4,
    volumePrecision: 0,
  },
  {
    id: 'BTCUSDT',
    display: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    category: 'crypto',
    providerIds: {
      binance: 'BTCUSDT',
      bybit: 'BTCUSDT',
      okx: 'BTC-USDT',
      gate: 'BTC_USDT',
      bitget: 'BTCUSDT',
      coingecko: 'bitcoin',
    },
    pricePrecision: 2,
    volumePrecision: 2,
  },
  {
    id: 'XAUTUSDT',
    display: 'XAUT/USDT',
    base: 'XAUT',
    quote: 'USDT',
    category: 'crypto',
    // Tether Gold is not listed on Binance, so the binance key is
    // deliberately omitted to let the provider manager fall back to
    // other exchanges.
    providerIds: {
      bybit: 'XAUTUSDT',
      okx: 'XAUT-USDT',
      gate: 'XAUT_USDT',
      bitget: 'XAUTUSDT',
      coingecko: 'tether-gold',
    },
    pricePrecision: 2,
    volumePrecision: 4,
  },
];

export const SYMBOLS: SymbolInfo[] = RAW_SYMBOLS.sort((a, b) => a.id.localeCompare(b.id));

export const DEFAULT_SYMBOL_ID = 'BTCUSD';

export function findSymbol(id: string): SymbolInfo | undefined {
  return SYMBOLS.find((s) => s.id === id);
}
