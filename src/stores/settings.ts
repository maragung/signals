import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AppSettings, Timeframe, Theme } from '@/types';
import { DEFAULT_SETTINGS } from '@/config/defaults';
import { findSymbol } from '@/config/symbols';

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w', '1M'];

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface SettingsState extends AppSettings {
  setTheme: (t: Theme) => void;
  setSymbol: (id: string) => void;
  setTimeframe: (tf: AppSettings['timeframe']) => void;
  setChartType: (ct: AppSettings['chartType']) => void;
  toggleOverlay: (key: keyof AppSettings['overlays']) => void;
  setScoringWeights: (w: AppSettings['scoringWeights']) => void;
  setFibConfig: (c: AppSettings['fibConfig']) => void;
  setIndicatorConfigs: (c: AppSettings['indicatorConfigs']) => void;
  setStrategyConfigs: (c: AppSettings['strategyConfigs']) => void;
  updateIndicator: (id: string, patch: Partial<AppSettings['indicatorConfigs'][number]>) => void;
  toggleIndicator: (id: string) => void;
  resetIndicators: () => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setTheme: (t) => set({ theme: t }),
      setSymbol: (id) => set({ symbol: id }),
      setTimeframe: (tf) => set({ timeframe: tf }),
      setChartType: (ct) => set({ chartType: ct }),
      toggleOverlay: (key) =>
        set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } })),
      setScoringWeights: (w) => set({ scoringWeights: w }),
      setFibConfig: (c) => set({ fibConfig: c }),
      setIndicatorConfigs: (c) => set({ indicatorConfigs: c }),
      setStrategyConfigs: (c) => set({ strategyConfigs: c }),
      updateIndicator: (id, patch) =>
        set((s) => ({
          indicatorConfigs: s.indicatorConfigs.map((i) =>
            i.id === id ? { ...i, ...patch, params: { ...i.params, ...(patch.params || {}) } } : i,
          ),
        })),
      toggleIndicator: (id) =>
        set((s) => ({
          indicatorConfigs: s.indicatorConfigs.map((i) =>
            i.id === id ? { ...i, enabled: !i.enabled } : i,
          ),
        })),
      resetIndicators: () => set({ indicatorConfigs: DEFAULT_SETTINGS.indicatorConfigs }),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'pp-settings-v1',
      storage: createJSONStorage(() => localStorage),
      // Guard against incompatible state persisted by older app versions
      // (e.g. indicatorConfigs stored as an object instead of an array),
      // which would otherwise crash consumers that iterate these fields.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppSettings>;
        const next = {
          ...current,
          ...p,
          indicatorConfigs: isArr(p.indicatorConfigs) ? p.indicatorConfigs : current.indicatorConfigs,
          strategyConfigs: isArr(p.strategyConfigs) ? p.strategyConfigs : current.strategyConfigs,
          overlays: isObj(p.overlays) ? p.overlays : current.overlays,
          scoringWeights: isObj(p.scoringWeights) ? p.scoringWeights : current.scoringWeights,
          fibConfig: isObj(p.fibConfig) ? p.fibConfig : current.fibConfig,
        } as SettingsState;
        // Fall back to defaults for stale/invalid symbol or timeframe.
        if (!findSymbol(next.symbol)) next.symbol = DEFAULT_SETTINGS.symbol;
        if (!TIMEFRAMES.includes(next.timeframe as Timeframe)) next.timeframe = DEFAULT_SETTINGS.timeframe;
        return next;
      },
    },
  ),
);
