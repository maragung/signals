'use client';

import { useSettings } from '@/stores/settings';
import { useState } from 'react';
import styles from './StrategiesPanel.module.css';

const KIND_LABELS = {
  'trend-following': 'Trend Following',
  'mean-reversion': 'Mean Reversion',
  breakout: 'Breakout',
  'supply-demand': 'Supply / Demand',
  'mtf-trend': 'MTF Trend',
};

export function StrategiesPanel() {
  const configs = useSettings((s) => s.strategyConfigs);
  const setConfigs = useSettings((s) => s.setStrategyConfigs);
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    setConfigs(configs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  };
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Strategies</h3>
        <button className={styles.toggle} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className={styles.list}>
          {configs.map((c) => (
            <label key={c.id} className={styles.row}>
              <input type="checkbox" checked={c.enabled} onChange={() => toggle(c.id)} />
              <span>{KIND_LABELS[c.kind]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
