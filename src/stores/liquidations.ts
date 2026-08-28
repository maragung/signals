import { create } from 'zustand';
import type { FuturesSnapshot, LiquidationEvent, LiquidationHeatmap, LiquidationSide } from '@/types';

export type LiquidationsStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed'
  | 'region-blocked';

interface LiquidationsState {
  heatmap: LiquidationHeatmap | null;
  snapshot: FuturesSnapshot | null;
  recent: LiquidationEvent[];
  status: LiquidationsStatus;
  setHeatmap: (h: LiquidationHeatmap | null) => void;
  setSnapshot: (s: FuturesSnapshot | null) => void;
  setStatus: (s: LiquidationsStatus) => void;
  addRecent: (ev: LiquidationEvent) => void;
  addSideVolume: (side: LiquidationSide, notional: number, price: number) => void;
  reset: () => void;
}

export const useLiquidations = create<LiquidationsState>((set) => ({
  heatmap: null,
  snapshot: null,
  recent: [],
  status: 'idle',
  setHeatmap: (h) => set({ heatmap: h }),
  setSnapshot: (s) => set({ snapshot: s }),
  setStatus: (s) => set({ status: s }),
  addRecent: (ev) =>
    set((s) => ({ recent: [ev, ...s.recent].slice(0, 200) })),
  addSideVolume: (side, notional, price) =>
    set((s) => {
      if (!s.heatmap) return s;
      // Find the closest level and increment the appropriate side
      let closestIdx = -1;
      let closestDist = Infinity;
      for (let i = 0; i < s.heatmap.levels.length; i++) {
        const d = Math.abs(s.heatmap.levels[i]!.price - price);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      if (closestIdx < 0) return s;
      const levels = s.heatmap.levels.slice();
      const cur = levels[closestIdx]!;
      levels[closestIdx] = {
        price: cur.price,
        longLiq: cur.longLiq + (side === 'long' ? notional : 0),
        shortLiq: cur.shortLiq + (side === 'short' ? notional : 0),
      };
      return {
        heatmap: {
          ...s.heatmap,
          levels,
          totalLongLiq: s.heatmap.totalLongLiq + (side === 'long' ? notional : 0),
          totalShortLiq: s.heatmap.totalShortLiq + (side === 'short' ? notional : 0),
          source: 'live',
        },
      };
    }),
  reset: () => set({ heatmap: null, snapshot: null, recent: [], status: 'idle' }),
}));
