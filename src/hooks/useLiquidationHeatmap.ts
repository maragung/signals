'use client';

import { useEffect, useRef } from 'react';
import { useLiquidations } from '@/stores/liquidations';
import { useSettings } from '@/stores/settings';
import { findSymbol } from '@/config/symbols';
import {
  fetchFuturesSnapshot,
  fetchRecentForceOrders,
  buildHeatmapFromEvents,
  synthesizeHeatmap,
} from '@/market-data/liquidation-heatmap';
import { startLiquidationStream } from '@/market-data/liquidation-stream';
import type { FuturesSnapshot, LiquidationHeatmap } from '@/types';

/**
 * Drives the liquidation heatmap for the current symbol.
 *
 * 1. Fetches a FuturesSnapshot from public Binance endpoints.
 * 2. Tries to fetch recent `forceOrder` events. If any come back,
 *    builds a `live` heatmap from them; otherwise falls back to the
 *    deterministic `synthetic` heatmap derived from the snapshot.
 * 3. Subscribes to the public `forceOrder` WebSocket and appends
 *    new events to both the recent list and the per-level totals.
 */
export function useLiquidationHeatmap(): {
  heatmap: LiquidationHeatmap | null;
  snapshot: FuturesSnapshot | null;
} {
  const symbol = useSettings((s) => s.symbol);
  const setHeatmap = useLiquidations((s) => s.setHeatmap);
  const setSnapshot = useLiquidations((s) => s.setSnapshot);
  const setStatus = useLiquidations((s) => s.setStatus);
  const addRecent = useLiquidations((s) => s.addRecent);
  const addSideVolume = useLiquidations((s) => s.addSideVolume);
  const lastSymbolRef = useRef<string>('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sym = findSymbol(symbol);
    if (!sym) return;
    const futuresSymbol = sym.providerIds.binanceFutures;
    if (!futuresSymbol) {
      // No futures data for this symbol (e.g. XAU/USD)
      setHeatmap(null);
      setSnapshot(null);
      setStatus('idle');
      return;
    }
    lastSymbolRef.current = futuresSymbol;
    let cancelled = false;
    setStatus('connecting');

    (async () => {
      const [snapshot, events] = await Promise.all([
        fetchFuturesSnapshot(futuresSymbol),
        fetchRecentForceOrders(futuresSymbol, 24).catch(() => [] as never[]),
      ]);
      if (cancelled) return;
      if (!snapshot) {
        setStatus('error');
        return;
      }
      setSnapshot(snapshot);
      let heatmap: LiquidationHeatmap;
      if (events.length > 0) {
        heatmap = buildHeatmapFromEvents(events, futuresSymbol, {
          symbol: futuresSymbol,
          stepPct: 0.1,
          rangePct: 8,
        });
      } else {
        heatmap = synthesizeHeatmap(snapshot, { symbol: futuresSymbol });
      }
      setHeatmap(heatmap);
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, setHeatmap, setSnapshot, setStatus]);

  // Live WebSocket subscription
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sym = findSymbol(symbol);
    if (!sym) return;
    const futuresSymbol = sym.providerIds.binanceFutures;
    if (!futuresSymbol) return;
    const handle = startLiquidationStream({
      symbol: futuresSymbol,
      onEvent: (ev) => {
        if (ev.symbol.toUpperCase() !== futuresSymbol.toUpperCase()) return;
        addRecent(ev);
        addSideVolume(ev.side, ev.notional, ev.price);
      },
      onStatus: (s) => setStatus(s),
      onError: () => {
        // Swallow; status is reflected through onStatus
      },
    });
    return () => {
      handle.close();
    };
  }, [symbol, addRecent, addSideVolume, setStatus]);

  return {
    heatmap: useLiquidations.getState().heatmap,
    snapshot: useLiquidations.getState().snapshot,
  };
}
