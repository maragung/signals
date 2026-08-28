'use client';

import { useAlerts } from '@/stores/alerts';
import { useSettings } from '@/stores/settings';
import { useState } from 'react';
import type { AlertItem } from '@/types';
import styles from './AlertsPanel.module.css';

const KIND_LABELS: Record<AlertItem['kind'], string> = {
  'price-cross': 'Price crosses level',
  'break-resistance': 'Breaks resistance',
  'break-support': 'Breaks support',
  'rsi-threshold': 'RSI threshold',
  'macd-crossover': 'MACD crossover',
  'ema-crossover': 'EMA crossover',
  bos: 'BOS',
  choch: 'CHOCH',
  'supply-entry': 'Supply zone entry',
  'demand-entry': 'Demand zone entry',
  'strategy-signal': 'Strategy signal',
};

export function AlertsPanel() {
  const symbol = useSettings((s) => s.symbol);
  const tf = useSettings((s) => s.timeframe);
  const alerts = useAlerts((s) => s.alerts);
  const addAlert = useAlerts((s) => s.addAlert);
  const removeAlert = useAlerts((s) => s.removeAlert);
  const toggleAlert = useAlerts((s) => s.toggleAlert);
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newKind, setNewKind] = useState<AlertItem['kind']>('price-cross');
  const [newLevel, setNewLevel] = useState('');

  const visible = alerts.filter((a) => a.symbol === symbol && a.timeframe === tf);
  const submit = () => {
    if (newKind === 'price-cross' || newKind === 'rsi-threshold') {
      const level = parseFloat(newLevel);
      if (!Number.isFinite(level)) return;
      addAlert({
        symbol,
        timeframe: tf,
        kind: newKind,
        params: { level, direction: newKind === 'rsi-threshold' ? 'above' : '' },
      });
    } else {
      addAlert({
        symbol,
        timeframe: tf,
        kind: newKind,
        params: {},
      });
    }
    setShowAdd(false);
    setNewLevel('');
  };
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Alerts ({visible.length})</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={styles.toggle} onClick={() => setShowAdd(!showAdd)}>
            + Add
          </button>
          <button className={styles.toggle} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {showAdd && (
        <div className={styles.addForm}>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as AlertItem['kind'])}>
            {(Object.keys(KIND_LABELS) as AlertItem['kind'][]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {(newKind === 'price-cross' || newKind === 'rsi-threshold') && (
            <input
              type="number"
              placeholder="level"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value)}
            />
          )}
          <button className="btn" onClick={submit}>
            Add
          </button>
        </div>
      )}
      {open && (
        <div className={styles.list}>
          {visible.length === 0 && <div className={styles.empty}>No alerts. Click + Add to create one.</div>}
          {visible.map((a) => (
            <div key={a.id} className={styles.row}>
              <input type="checkbox" checked={a.active} onChange={() => toggleAlert(a.id)} />
              <span className={a.triggeredAt ? styles.triggered : ''}>
                {KIND_LABELS[a.kind]}
                {a.params.level !== undefined && ` @ ${a.params.level}`}
              </span>
              <button className={styles.removeBtn} onClick={() => removeAlert(a.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
