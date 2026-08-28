// Helper used by the MTF analysis to fetch multiple timeframes via the provider manager.

import type { Candle, Timeframe } from '@/types';

interface ProviderLike {
  getHistoricalCandles: (symbol: string, tf: Timeframe, limit: number) => Promise<Candle[]>;
}

export async function fetchMTFCandles(
  manager: { getHistoricalCandles: (sym: string, tf: Timeframe, limit: number) => Promise<Candle[]> },
  symbol: string,
  timeframes: Timeframe[],
  limit = 300,
): Promise<Record<Timeframe, Candle[]>> {
  const out: Partial<Record<Timeframe, Candle[]>> = {};
  await Promise.all(
    timeframes.map(async (tf) => {
      try {
        const arr = await manager.getHistoricalCandles(symbol, tf, limit);
        out[tf] = arr;
      } catch {
        out[tf] = [];
      }
    }),
  );
  return out as Record<Timeframe, Candle[]>;
}
