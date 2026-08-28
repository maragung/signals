'use client';

import type { MTFAnalysis } from '@/types';
import styles from './MTFDashboard.module.css';

function cellClass(b: string): string {
  if (b === 'bullish') return styles.bull;
  if (b === 'bearish') return styles.bear;
  return styles.neutral;
}

function dot(c: string): string {
  if (c === styles.bull) return '🟢';
  if (c === styles.bear) return '🔴';
  return '🟡';
}

export function MTFDashboard({ mtf }: { mtf: MTFAnalysis | null }) {
  if (!mtf || mtf.cells.length === 0) {
    return (
      <div className={styles.wrap}>
        <h3 className={styles.title}>Multi-Timeframe</h3>
        <div className={styles.empty}>Loading MTF data…</div>
      </div>
    );
  }
  return (
    <div className={styles.wrap}>
      <h3 className={styles.title}>Multi-Timeframe</h3>
      <div className={styles.table}>
        <div className={styles.headerRow}>
          <div className={styles.corner}></div>
          {mtf.cells.map((c) => (
            <div key={c.timeframe} className={styles.headerCell}>
              {c.timeframe.toUpperCase()}
            </div>
          ))}
        </div>
        {(['trend', 'momentum', 'structure', 'volume'] as const).map((k) => (
          <div key={k} className={styles.dataRow}>
            <div className={styles.label}>{k}</div>
            {mtf.cells.map((c) => {
              const cls = cellClass(c[k]);
              return (
                <div key={c.timeframe} className={`${styles.cell} ${cls}`}>
                  {dot(cls)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.summary}>
        <div>
          Overall Bias:{' '}
          <strong
            className={
              mtf.overallBias === 'bullish' ? styles.bull : mtf.overallBias === 'bearish' ? styles.bear : styles.neutral
            }
          >
            {mtf.overallBias.toUpperCase()}
          </strong>
        </div>
        <div>
          MTF Score: <strong className={mtf.mtfScore >= 0 ? styles.bull : styles.bear}>{mtf.mtfScore >= 0 ? '+' : ''}{mtf.mtfScore.toFixed(1)}</strong>
        </div>
      </div>
    </div>
  );
}
