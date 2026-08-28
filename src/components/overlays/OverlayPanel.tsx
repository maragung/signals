'use client';

import { useSettings } from '@/stores/settings';
import { useState } from 'react';
import styles from './OverlayPanel.module.css';

const LABELS: Record<keyof ReturnType<typeof useSettings.getState>['overlays'], string> = {
  indicators: 'Indicators',
  strategies: 'Strategies',
  snr: 'Support / Resistance',
  snd: 'Supply / Demand',
  structure: 'Market Structure',
  bos: 'BOS',
  choch: 'CHOCH',
  liquidity: 'Liquidity',
  fibonacci: 'Fibonacci',
  trendlines: 'Trendlines',
  signals: 'Signals',
  entry: 'Entry',
  tp: 'TP',
  sl: 'SL',
  volume: 'Volume',
  liquidationHeatmap: 'Liquidation Heatmap',
};

export function OverlayPanel() {
  const overlays = useSettings((s) => s.overlays);
  const toggle = useSettings((s) => s.toggleOverlay);
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Overlays</h3>
        <button className={styles.toggle} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className={styles.list}>
          {(Object.keys(overlays) as Array<keyof typeof overlays>).map((k) => (
            <label key={k} className={styles.row}>
              <input type="checkbox" checked={overlays[k]} onChange={() => toggle(k)} />
              <span>{LABELS[k]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
