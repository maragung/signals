import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { DrawingObject, SymbolInfo, Timeframe } from '@/types';

interface DrawingsState {
  drawings: DrawingObject[];
  addDrawing: (d: Omit<DrawingObject, 'id' | 'createdAt'>) => string;
  removeDrawing: (id: string) => void;
  updateDrawing: (id: string, patch: Partial<DrawingObject>) => void;
  clearSymbol: (symbol: string) => void;
  getDrawings: (symbol: string, timeframe: Timeframe) => DrawingObject[];
}

function key(symbol: string, timeframe: Timeframe): string {
  return `${symbol}::${timeframe}`;
}

export const useDrawings = create<DrawingsState>()(
  persist(
    (set, get) => ({
      drawings: [],
      addDrawing: (d) => {
        const id = nanoid(8);
        set((s) => ({ drawings: [...s.drawings, { ...d, id, createdAt: Date.now() }] }));
        return id;
      },
      removeDrawing: (id) => set((s) => ({ drawings: s.drawings.filter((d) => d.id !== id) })),
      updateDrawing: (id, patch) =>
        set((s) => ({
          drawings: s.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        })),
      clearSymbol: (symbol) =>
        set((s) => ({ drawings: s.drawings.filter((d) => d.symbol !== symbol) })),
      getDrawings: (symbol, timeframe) =>
        get().drawings.filter((d) => d.symbol === symbol && d.timeframe === timeframe),
    }),
    {
      name: 'pp-drawings-v1',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DrawingsState>;
        return {
          ...current,
          ...p,
          drawings: Array.isArray(p.drawings) ? p.drawings : current.drawings,
        } as DrawingsState;
      },
    },
  ),
);
