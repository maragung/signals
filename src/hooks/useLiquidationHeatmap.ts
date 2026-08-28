'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiquidations } from '@/stores/liquidations';
import { useSettings } from '@/stores/settings';
import { findSymbol } from '@/config/symbols';
import {
  buildHeatmapFromEvents,
  synthesizeHeatmap,
  fetchHeatmapSnapshot,
} from '@/market-data/liquidation-heatmap';
import { startLiquidationStream } from '@/market-data/liquidation-stream';
import type { FuturesSnapshot, LiquidationHeatmap } from '@/types';

/**
 * Drives the liquidation heatmap for the current symbol.
 *
 * 1. Fetches a FuturesSnapshot + recent forceOrder events in a single
 *    `fetchHeatmapSnapshot` call. The result distinguishes a clean
 *    success, a transient network failure, and a region block
 *    (upstream returned 451/403).
 * 2. Builds a `live` heatmap from any events we did receive; if we
 *    have a snapshot but no events, falls back to the deterministic
 *    `synthetic` heatmap derived from the snapshot.
 * 3. Subscribes to the public `forceOrder` WebSocket (skipped on
 *    region block) and appends new events to both the recent list
 *    and the per-level totals.
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
  const [regionBlocked, setRegionBlocked] = useState(false);
  const lastSymbolRef = useRef<string>('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sym = findSymbol(symbol);
    if (!sym) return;
    const futuresSymbol = sym.providerIds.binanceFutures;
    if (!futuresSymbol) {
      setHeatmap(null);
      setSnapshot(null);
      setStatus('idle');
      setRegionBlocked(false);
      return;
    }
    lastSymbolRef.current = futuresSymbol;
    let cancelled = false;
    setStatus('connecting');

    (async () => {
      const result = await fetchHeatmapSnapshot(futuresSymbol, 24);
      if (cancelled) return;
      if (result.blocked) {
        setRegionBlocked(true);
        setStatus('region-blocked');
        setSnapshot(null);
        setHeatmap(null);
        return;
      }
      setRegionBlocked(false);
      if (!result.snapshot) {
        setStatus('error');
        return;
      }
      setSnapshot(result.snapshot);
      let heatmap: LiquidationHeatmap;
      if (result.events.length > 0) {
        heatmap = buildHeatmapFromEvents(result.events, futuresSymbol, {
          symbol: futuresSymbol,
          stepPct: 0.1,
          rangePct: 8,
        });
      } else {
        heatmap = synthesizeHeatmap(result.snapshot, { symbol: futuresSymbol });
      }
      setHeatmap(heatmap);
      setStatus('connected');
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, setHeatmap, setSnapshot, setStatus]);

  // Live WebSocket subscription (skipped on region block)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sym = findSymbol(symbol);
    if (!sym) return;
    const futuresSymbol = sym.providerIds.binanceFutures;
    if (!futuresSymbol) return;
    if (regionBlocked) return; // skip WS entirely when geo-blocked
    const handle = startLiquidationStream({
      symbol: futuresSymbol,
      skipOnRegionBlocked: regionBlocked,
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
  }, [symbol, addRecent, addSideVolume, setStatus, regionBlocked]);

  return {
    heatmap: useLiquidations.getState().heatmap,
    snapshot: useLiquidations.getState().snapshot,
  };
}
