'use client';

import type { TechnicalProjection } from '@/types';
import { formatPrice } from '@/core/utils/series';
import styles from './ProjectionPanel.module.css';

export function ProjectionPanel({ projection }: { projection: TechnicalProjection | null }) {
  if (!projection) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Technical Projection</h3>
        <div className={styles.empty}>Waiting for data…</div>
      </div>
    );
  }
  const dir = projection.direction;
  const dirClass = dir === 'bullish' ? styles.bull : dir === 'bearish' ? styles.bear : styles.neutral;
  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>Technical Projection</h3>
      <div className={styles.grid}>
        <div>
          <div className={styles.label}>Direction</div>
          <div className={`${styles.value} ${dirClass}`}>{dir.toUpperCase()}</div>
        </div>
        <div>
          <div className={styles.label}>Score</div>
          <div className={styles.value}>
            {projection.score >= 0 ? '+' : ''}
            {projection.score.toFixed(1)} / {projection.total.toFixed(1)}
          </div>
        </div>
        <div>
          <div className={styles.label}>Confidence</div>
          <div className={styles.value}>{(projection.confidence * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className={styles.label}>Risk / Reward</div>
          <div className={styles.value}>
            {projection.riskReward ? `1 : ${projection.riskReward.toFixed(2)}` : '—'}
          </div>
        </div>
        {projection.entryZone && (
          <div className={styles.fullRow}>
            <div className={styles.label}>Entry Zone</div>
            <div className={styles.value}>
              {formatPrice(projection.entryZone.low)} – {formatPrice(projection.entryZone.high)}
            </div>
          </div>
        )}
        {projection.resistance !== undefined && (
          <div>
            <div className={styles.label}>Resistance</div>
            <div className={styles.value}>{formatPrice(projection.resistance)}</div>
          </div>
        )}
        {projection.support !== undefined && (
          <div>
            <div className={styles.label}>Support</div>
            <div className={styles.value}>{formatPrice(projection.support)}</div>
          </div>
        )}
        {projection.invalidation !== undefined && (
          <div className={styles.fullRow}>
            <div className={styles.label}>Invalidation</div>
            <div className={`${styles.value} ${styles.bear}`}>
              {formatPrice(projection.invalidation)}
            </div>
          </div>
        )}
        <div className={styles.fullRow}>
          <div className={styles.label}>Targets</div>
          <div className={styles.targetsList}>
            {projection.targets.map((t) => (
              <div key={t.label} className={styles.targetRow}>
                <span className={styles.targetLabel}>{t.label}</span>
                <span className={styles.targetPrice}>{formatPrice(t.price)}</span>
              </div>
            ))}
          </div>
        </div>
        {projection.expectedVolatility !== undefined && (
          <div>
            <div className={styles.label}>Volatility (ATR%)</div>
            <div className={styles.value}>{projection.expectedVolatility.toFixed(2)}%</div>
          </div>
        )}
      </div>
      <div className={styles.disclaimer}>{projection.disclaimer}</div>
    </div>
  );
}
