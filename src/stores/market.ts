import { create } from 'zustand';
import type { Candle, ConnectionStatus, TickerData, Timeframe } from '@/types';

interface CandleSeries {
  loading: boolean;
  lastUpdate: number;
}

// Stable reference for "no candles yet" so selectors return a cached value
// (returning a fresh [] literal each call breaks useSyncExternalStore under
// React 19 / zustand v5 and causes an infinite render loop).
const EMPTY_CANDLES: Candle[] = [];

interface MarketState {
  // symbol -> timeframe -> candles
  candles: Record<string, Record<Timeframe, Candle[]>>;
  status: ConnectionStatus;
  ticker: TickerData | null;
  errors: { ts: number; msg: string }[];
  setCandles: (symbol: string, tf: Timeframe, candles: Candle[]) => void;
  appendCandle: (symbol: string, tf: Timeframe, candle: Candle) => void;
  setStatus: (s: ConnectionStatus) => void;
  setTicker: (t: TickerData | null) => void;
  addError: (msg: string) => void;
  reset: () => void;
}

export const useMarket = create<MarketState>((set) => ({
  candles: {},
  status: 'idle',
  ticker: null,
  errors: [],
  setCandles: (symbol, tf, candles) =>
    set((s) => ({
      candles: {
        ...s.candles,
        [symbol]: { ...(s.candles[symbol] || {}), [tf]: candles },
      },
    })),
  appendCandle: (symbol, tf, candle) =>
    set((s) => {
      const sym = s.candles[symbol] || ({} as Record<Timeframe, Candle[]>);
      const arr = sym[tf] || [];
      const last = arr[arr.length - 1];
      if (last && last.time === candle.time) {
        // update last
        const merged: Candle = {
          time: candle.time,
          open: last.open,
          high: Math.max(last.high, candle.high),
          low: Math.min(last.low, candle.low),
          close: candle.close,
          volume: last.volume + candle.volume,
        };
        return {
          candles: { ...s.candles, [symbol]: { ...sym, [tf]: [...arr.slice(0, -1), merged] } },
        };
      }
      if (last && candle.time < last.time) {
        // out of order - insert in place
        const out: Candle[] = [];
        let inserted = false;
        for (const c of arr) {
          if (!inserted && candle.time < c.time) {
            out.push(candle);
            inserted = true;
          }
          if (c.time !== candle.time) out.push(c);
        }
        if (!inserted) out.push(candle);
        return { candles: { ...s.candles, [symbol]: { ...sym, [tf]: out } } };
      }
      return {
        candles: { ...s.candles, [symbol]: { ...sym, [tf]: [...arr, candle] } },
      };
    }),
  setStatus: (status) => set({ status }),
  setTicker: (ticker) => set({ ticker }),
  addError: (msg) =>
    set((s) => ({ errors: [...s.errors.slice(-9), { ts: Date.now(), msg }] })),
  reset: () => set({ candles: {}, status: 'idle', ticker: null }),
}));

export function getCandles(
  state: MarketState,
  symbol: string,
  tf: Timeframe,
): Candle[] {
  return state.candles[symbol]?.[tf] || EMPTY_CANDLES;
}
