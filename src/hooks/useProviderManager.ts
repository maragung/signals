'use client';

import { useEffect, useRef } from 'react';
import { useMarket } from '@/stores/market';
import { useSettings } from '@/stores/settings';
import type { Timeframe } from '@/types';

export function useProviderManager(manager: unknown): void {
  const symbol = useSettings((s) => s.symbol);
  const tf = useSettings((s) => s.timeframe);
  const setStatus = useMarket((s) => s.setStatus);
  const setTicker = useMarket((s) => s.setTicker);
  const setCandles = useMarket((s) => s.setCandles);
  const appendCandle = useMarket((s) => s.appendCandle);
  const lastRef = useRef<{ symbol: string; tf: Timeframe }>({ symbol: '', tf: '1h' });
  const lastSeenTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!manager) return;
    const m = manager as {
      getHistoricalCandles: (sym: unknown, tf: Timeframe, limit: number) => Promise<unknown[]>;
      subscribeCandles: (
        sym: unknown,
        tf: Timeframe,
        onCandle: (c: unknown) => void,
        onStatus: (s: unknown) => void,
      ) => () => void;
      subscribeTicker: (
        sym: unknown,
        onTicker: (t: unknown) => void,
        onStatus: (s: unknown) => void,
      ) => () => void;
    };

    // load historical
    setStatus('connecting');
    m.getHistoricalCandles(symbol, tf, 500)
      .then((candles) => {
        setCandles(symbol, tf, candles as never);
        const arr = candles as Array<{ time: number }>;
        lastSeenTimeRef.current = arr.length > 0 ? arr[arr.length - 1]!.time : 0;
        setStatus('connected');
      })
      .catch(() => {
        setStatus('error');
      });

    // subscribe
    const unsubC = m.subscribeCandles(
      symbol,
      tf,
      (candle) => {
        const c = candle as { time: number };
        if (c.time < lastSeenTimeRef.current) return;
        lastSeenTimeRef.current = c.time;
        appendCandle(symbol, tf, candle as never);
      },
      (status) => setStatus(status as never),
    );
    const unsubT = m.subscribeTicker(
      symbol,
      (t) => setTicker(t as never),
      (status) => setStatus(status as never),
    );

    lastRef.current = { symbol, tf };
    return () => {
      try {
        unsubC();
        unsubT();
      } catch {
        // ignore
      }
    };
  }, [manager, symbol, tf, setStatus, setTicker, setCandles, appendCandle]);
}
