'use client';

import { TIMEFRAMES, type Timeframe } from '@/types';
import { useSettings } from '@/stores/settings';
import { formatPrice, formatPercent, pctChange } from '@/core/utils/series';
import { findSymbol } from '@/config/symbols';
import styles from './Header.module.css';

export function Header({
  symbol,
  tf,
  ticker,
  status,
  theme,
  onThemeToggle,
}: {
  symbol: string;
  tf: Timeframe;
  ticker: { price: number; changePercent24h: number } | null;
  status: string;
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
}) {
  const setTimeframe = useSettings((s) => s.setTimeframe);
  const setSymbol = useSettings((s) => s.setSymbol);
  const sym = findSymbol(symbol);
  const lastPrice = ticker?.price ?? 0;
  const change = ticker?.changePercent24h ?? 0;
  const isUp = change >= 0;
  return (
    <div className={styles.header}>
      <div className={styles.left}>
        <select
          className={styles.symbolSelect}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        >
          <option value="BTCUSD">BTC/USD</option>
          <option value="XAUUSD">XAU/USD</option>
          <option value="ETHUSDT">ETH/USDT</option>
          <option value="ETHBTC">ETH/BTC</option>
        </select>
        <div className={styles.priceBox}>
          <span className={styles.price}>{formatPrice(lastPrice, sym?.pricePrecision ?? 2)}</span>
          <span className={isUp ? styles.changeUp : styles.changeDown}>
            {formatPercent(change)}
          </span>
        </div>
        <div className={styles.statusBox}>
          <span className={`status-dot ${status}`} />
          <span className={styles.statusText}>{status.toUpperCase()}</span>
        </div>
      </div>
      <div className={styles.center}>
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            className={`${styles.tfBtn} ${t === tf ? styles.tfActive : ''}`}
            onClick={() => setTimeframe(t)}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      <div className={styles.right}>
        <button className="btn" onClick={onThemeToggle} title="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </div>
  );
}
