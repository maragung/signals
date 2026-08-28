'use client';

import type { ScoringResult } from '@/types';
import styles from './ScorePanel.module.css';

export function ScorePanel({ score }: { score: ScoringResult | null }) {
  if (!score) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Scoring</h3>
        <div className={styles.empty}>Loading…</div>
      </div>
    );
  }
  const biasClass = score.bias === 'bullish' ? styles.bull : score.bias === 'bearish' ? styles.bear : styles.neutral;
  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>Scoring</h3>
      <div className={styles.bigLabel} data-class={biasClass}>
        {score.label}
      </div>
      <div className={styles.barRow}>
        <span className="bull">{score.bullish.toFixed(1)}</span>
        <div className={styles.bar}>
          <div
            className={styles.barBull}
            style={{ width: `${pct(score.bullish, score.total)}%` }}
          />
          <div
            className={styles.barBear}
            style={{ width: `${pct(score.bearish, score.total)}%` }}
          />
        </div>
        <span className="bear">{score.bearish.toFixed(1)}</span>
      </div>
      <div className={styles.netRow}>
        Net: <strong className={biasClass}>{score.net >= 0 ? '+' : ''}{score.net.toFixed(1)}</strong> / {score.total.toFixed(1)}
      </div>
      <div className={styles.breakdown}>
        {Object.entries(score.breakdown).map(([k, v]) => (
          <div key={k} className={styles.bdRow}>
            <span className={styles.bdLabel}>{k}</span>
            <span className={v >= 0 ? 'bull' : 'bear'}>{v >= 0 ? '+' : ''}{v.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}
