import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AppSettings, Theme } from '@/types';
import { DEFAULT_SETTINGS } from '@/config/defaults';

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
    },
  ),
);
