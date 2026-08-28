'use client';

import * as React from 'react';
import { useMemo } from 'react';
import { useLiquidations } from '@/stores/liquidations';
import { useSettings } from '@/stores/settings';
import { findSymbol } from '@/config/symbols';
import { formatPrice } from '@/core/utils/series';
import type { LiquidationLevel } from '@/types';
import styles from './LiquidationHeatmapPanel.module.css';

export function LiquidationHeatmapPanel() {
  const symbol = useSettings((s) => s.symbol);
  const heatmap = useLiquidations((s) => s.heatmap);
  const snapshot = useLiquidations((s) => s.snapshot);
  const status = useLiquidations((s) => s.status);
  const recent = useLiquidations((s) => s.recent);

  const sym = findSymbol(symbol);
  const hasFutures = Boolean(sym?.providerIds.binanceFutures);

  const { maxIntensity, levels } = useMemo(() => {
    if (!heatmap || heatmap.levels.length === 0) return { maxIntensity: 0, levels: heatmap?.levels ?? [] };
    let max = 0;
    for (const l of heatmap.levels) {
      const s = Math.max(l.longLiq, l.shortLiq);
      if (s > max) max = s;
    }
    return { maxIntensity: max, levels: heatmap.levels };
  }, [heatmap]);

  if (!hasFutures) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Liquidation Heatmap</h3>
        <div className={styles.empty}>
          Liquidation heatmap is only available for futures-listed symbols (BTC, ETH).
        </div>
      </div>
    );
  }

  if (!heatmap) {
    if (status === 'region-blocked') {
      return (
        <div className={styles.panel}>
          <h3 className={styles.title}>
            Liquidation Heatmap
            <span className={styles.sourceTag} data-source="blocked">
              unavailable
            </span>
          </h3>
          <div className={styles.regionBlocked}>
            <div className={styles.regionBlockedTitle}>Futures data is unavailable in your region</div>
            <div className={styles.regionBlockedBody}>
              Binance geo-blocks its futures endpoints (mark price, open
              interest, liquidation feed) in some jurisdictions (commonly
              US, UK, Canada). All other analytics still work — spot
              candles, indicators, scoring, projection, MTF, SNR/SND,
              market structure, drawing tools, and alerts.
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Liquidation Heatmap</h3>
        <div className={styles.empty}>
          {status === 'error'
            ? 'Failed to load futures data. Check your connection.'
            : 'Loading liquidation data…'}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>
        Liquidation Heatmap
        <span className={styles.sourceTag} data-source={heatmap.source}>
          {heatmap.source}
        </span>
      </h3>
      <div className={styles.meta}>
        {snapshot && (
          <>
            <div>
              <span className={styles.muted}>Mark</span>{' '}
              <strong>{formatPrice(snapshot.markPrice, sym?.pricePrecision ?? 2)}</strong>
            </div>
            <div>
              <span className={styles.muted}>OI</span>{' '}
              <strong>${formatNumber(snapshot.openInterestUsd)}</strong>
            </div>
            <div>
              <span className={styles.muted}>Funding</span>{' '}
              <strong className={snapshot.fundingRate >= 0 ? styles.bull : styles.bear}>
                {(snapshot.fundingRate * 100).toFixed(4)}%
              </strong>
            </div>
            <div>
              <span className={styles.muted}>L/S</span>{' '}
              <strong>{snapshot.longShortRatio.toFixed(3)}</strong>
            </div>
          </>
        )}
      </div>
      <div className={styles.legend}>
        <span className={styles.legendLong} /> Long liq
        <span className={styles.legendShort} /> Short liq
      </div>
      <div className={styles.ladder}>
        {levels
          .slice()
          .sort((a, b) => b.price - a.price)
          .map((l) => (
            <LevelRow key={l.price} level={l} maxIntensity={maxIntensity} precision={sym?.pricePrecision ?? 2} />
          ))}
      </div>
      {recent.length > 0 && (
        <div className={styles.recent}>
          <h4 className={styles.subTitle}>Recent Liquidations</h4>
          <div className={styles.recentList}>
            {recent.slice(0, 10).map((ev, i) => (
              <div key={`${ev.time}-${i}`} className={styles.recentRow} data-side={ev.side}>
                <span className={styles.recentSide}>{ev.side === 'long' ? 'L' : 'S'}</span>
                <span className={styles.recentPrice}>{formatPrice(ev.price, sym?.pricePrecision ?? 2)}</span>
                <span className={styles.recentNotional}>${formatNumber(ev.notional)}</span>
                <span className={styles.recentTime}>{formatTime(ev.time)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LevelRow({
  level,
  maxIntensity,
  precision,
}: {
  level: LiquidationLevel;
  maxIntensity: number;
  precision: number;
}) {
  const longPct = maxIntensity > 0 ? (level.longLiq / maxIntensity) * 100 : 0;
  const shortPct = maxIntensity > 0 ? (level.shortLiq / maxIntensity) * 100 : 0;
  return (
    <div className={styles.lvl}>
      <div className={styles.lvlPrice}>{formatPrice(level.price, precision)}</div>
      <div className={styles.lvlBars}>
        <div className={styles.lvlBarLong} style={{ width: `${longPct}%` }} title={`Long liq $${formatNumber(level.longLiq)}`} />
        <div className={styles.lvlBarShort} style={{ width: `${shortPct}%` }} title={`Short liq $${formatNumber(level.shortLiq)}`} />
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
