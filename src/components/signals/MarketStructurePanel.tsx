'use client';

import type { MarketStructureEvent, MarketStructurePoint } from '@/types';
import { formatPrice } from '@/core/utils/series';
import styles from './MarketStructurePanel.module.css';

export function MarketStructurePanel({
  points,
  events,
}: {
  points: MarketStructurePoint[];
  events: MarketStructureEvent[];
}) {
  return (
    <div className={styles.wrap}>
      <div className={styles.section}>
        <h3 className={styles.title}>Swing Points ({points.length})</h3>
        {points.length === 0 ? (
          <div className={styles.empty}>No swing points yet.</div>
        ) : (
          <div className={styles.list}>
            {points.slice(-15).reverse().map((p, i) => (
              <div key={`${p.time}-${i}`} className={styles.row}>
                <span className={kindClass(p.kind)}>{p.kind}</span>
                <span className={styles.price}>{formatPrice(p.price)}</span>
                <span className={styles.time}>{new Date(p.time * 1000).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.section}>
        <h3 className={styles.title}>BOS / CHOCH ({events.length})</h3>
        {events.length === 0 ? (
          <div className={styles.empty}>No structural events yet.</div>
        ) : (
          <div className={styles.list}>
            {events.slice(-15).reverse().map((e, i) => (
              <div key={`${e.time}-${i}`} className={styles.row}>
                <span className={e.direction === 'bullish' ? styles.bull : styles.bear}>
                  {e.kind} {e.direction === 'bullish' ? '↑' : '↓'}
                </span>
                <span className={styles.price}>{formatPrice(e.price)}</span>
                <span className={styles.time}>{new Date(e.time * 1000).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function kindClass(k: string): string {
  if (k === 'HH' || k === 'HL') return styles.bull;
  if (k === 'LH' || k === 'LL') return styles.bear;
  return styles.neutral;
}
