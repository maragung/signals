import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { AlertItem } from '@/types';

interface AlertsState {
  alerts: AlertItem[];
  addAlert: (a: Omit<AlertItem, 'id' | 'createdAt' | 'active'>) => string;
  removeAlert: (id: string) => void;
  toggleAlert: (id: string) => void;
  markTriggered: (id: string) => void;
  clearTriggered: () => void;
}

export const useAlerts = create<AlertsState>()(
  persist(
    (set) => ({
      alerts: [],
      addAlert: (a) => {
        const id = nanoid(8);
        set((s) => ({
          alerts: [...s.alerts, { ...a, id, createdAt: Date.now(), active: true }],
        }));
        return id;
      },
      removeAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
      toggleAlert: (id) =>
        set((s) => ({
          alerts: s.alerts.map((a) => (a.id === id ? { ...a, active: !a.active } : a)),
        })),
      markTriggered: (id) =>
        set((s) => ({
          alerts: s.alerts.map((a) => (a.id === id ? { ...a, triggeredAt: Date.now(), active: false } : a)),
        })),
      clearTriggered: () =>
        set((s) => ({ alerts: s.alerts.filter((a) => !a.triggeredAt) })),
    }),
    {
      name: 'pp-alerts-v1',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AlertsState>;
        return {
          ...current,
          ...p,
          alerts: Array.isArray(p.alerts) ? p.alerts : current.alerts,
        } as AlertsState;
      },
    },
  ),
);
