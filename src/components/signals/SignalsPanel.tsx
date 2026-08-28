'use client';

import type { StrategySignal } from '@/types';
import { formatPrice } from '@/core/utils/series';
import styles from './SignalsPanel.module.css';

export function SignalsPanel({ signals, detailed = false }: { signals: StrategySignal[]; detailed?: boolean }) {
  if (signals.length === 0) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Strategy Signals</h3>
        <div className={styles.empty}>No active signals.</div>
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>Strategy Signals ({signals.length})</h3>
      <div className={styles.list}>
        {signals.slice(-8).reverse().map((s) => {
          const dirClass = s.direction === 'long' ? styles.long : s.direction === 'short' ? styles.short : styles.close;
          return (
            <div key={s.id} className={styles.row}>
              <span className={`${styles.dir} ${dirClass}`}>{s.direction.toUpperCase()}</span>
              <span className={styles.kind}>{s.kind}</span>
              {detailed && <div className={styles.reason}>{s.reason}</div>}
              <span className={styles.price}>{formatPrice(s.price)}</span>
              <span className={styles.conf}>{(s.confidence * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
