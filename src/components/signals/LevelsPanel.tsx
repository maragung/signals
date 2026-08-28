'use client';

import type { SupportResistanceLevel, SupplyDemandZone } from '@/types';
import { formatPrice } from '@/core/utils/series';
import styles from './LevelsPanel.module.css';

export function LevelsPanel({
  snr,
  snd,
}: {
  snr: SupportResistanceLevel[];
  snd: SupplyDemandZone[];
}) {
  return (
    <div className={styles.wrap}>
      <div className={styles.section}>
        <h3 className={styles.title}>Support & Resistance ({snr.length})</h3>
        {snr.length === 0 ? (
          <div className={styles.empty}>No levels detected yet.</div>
        ) : (
          <div className={styles.list}>
            {snr.slice(0, 20).map((l) => (
              <div key={l.id} className={styles.row}>
                <span className={l.type === 'support' ? styles.bull : styles.bear}>
                  {l.type === 'support' ? 'SUP' : 'RES'}
                </span>
                <span className={styles.price}>{formatPrice(l.price)}</span>
                <span className={styles.kind}>{l.kind}</span>
                <span className={styles.strength}>{(l.strength * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.section}>
        <h3 className={styles.title}>Supply & Demand Zones ({snd.length})</h3>
        {snd.length === 0 ? (
          <div className={styles.empty}>No zones detected yet.</div>
        ) : (
          <div className={styles.list}>
            {snd.slice(0, 20).map((z) => (
              <div key={z.id} className={styles.row}>
                <span className={z.type === 'demand' ? styles.bull : styles.bear}>
                  {z.type === 'demand' ? 'DEM' : 'SUP'}
                </span>
                <span className={styles.price}>
                  {formatPrice(z.low)} – {formatPrice(z.high)}
                </span>
                <span className={styles.kind}>{z.pattern}</span>
                <span className={styles.status}>{z.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
