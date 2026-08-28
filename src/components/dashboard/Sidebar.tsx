'use client';

import { useSettings } from '@/stores/settings';
import { SYMBOLS } from '@/config/symbols';
import { useMarket } from '@/stores/market';
import { useDrawings } from '@/stores/drawings';
import { useState } from 'react';
import { formatPercent, pctChange } from '@/core/utils/series';
import { IndicatorPanel } from '@/components/indicators/IndicatorPanel';
import type { IndicatorKind } from '@/types';
import { nanoid } from 'nanoid';
import { OverlayPanel } from '@/components/overlays/OverlayPanel';
import { DrawingsPanel } from '@/components/drawings/DrawingsPanel';
import type { DrawingKind } from '@/components/drawings/DrawingTools';
import { AlertsPanel } from '@/components/alerts/AlertsPanel';
import { StrategiesPanel } from '@/components/strategies/StrategiesPanel';
import styles from './Sidebar.module.css';

export function Sidebar({
  symbol,
  onSelect,
}: {
  symbol: string;
  onSelect: (id: string) => void;
}) {
  const ticker = useMarket((s) => s.ticker);
  const candles = useMarket((s) => s.candles);
  const indicatorConfigs = useSettings((s) => s.indicatorConfigs);
  const setIndicatorConfigs = useSettings((s) => s.setIndicatorConfigs);
  const allDrawings = useDrawings((s) => s.drawings);
  const removeDrawing = useDrawings((s) => s.removeDrawing);
  const clearSymbol = useDrawings((s) => s.clearSymbol);
  const [drawingTool, setDrawingTool] = useState<DrawingKind | 'select'>('select');
  return (
    <div className={styles.sidebar}>
      <div className={styles.section}>
        <h3 className={styles.title}>Watchlist</h3>
        <div className={styles.watchlist}>
          {SYMBOLS.map((s) => {
            const isActive = s.id === symbol;
            const last = (candles[s.id]?.['1d'] || []).slice(-2);
            let change = 0;
            if (s.id === symbol && ticker) {
              change = ticker.changePercent24h;
            } else if (last.length >= 2) {
              change = pctChange(last[0]!.close, last[1]!.close);
            }
            const isUp = change >= 0;
            return (
              <button
                key={s.id}
                className={`${styles.symbolRow} ${isActive ? styles.active : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className={styles.symbolName}>{s.display}</span>
                <span className={isUp ? styles.up : styles.down}>{formatPercent(change)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <IndicatorPanel
        configs={indicatorConfigs}
        onChange={setIndicatorConfigs}
        onAdd={(kind: IndicatorKind) => {
          // Don't add duplicates by id; suffix with nanoid if collision
          const id = `${kind}-${nanoid(4).toLowerCase()}`;
          const params: Record<string, number> = {};
          switch (kind) {
            case 'sma':
            case 'ema':
            case 'wma':
              params.period = 20;
              break;
            case 'rsi':
              params.period = 14;
              break;
            case 'macd':
              params.fast = 12;
              params.slow = 26;
              params.signal = 9;
              break;
            case 'bbands':
            case 'bbwidth':
              params.period = 20;
              params.stddev = 2;
              break;
            case 'atr':
            case 'adx':
              params.period = 14;
              break;
            case 'keltner':
              params.period = 20;
              params.multiplier = 2;
              break;
            case 'stoch':
              params.k = 14;
              params.d = 3;
              params.smooth = 3;
              break;
            case 'stochrsi':
              params.rsiPeriod = 14;
              params.stochPeriod = 14;
              params.k = 3;
              params.d = 3;
              break;
            case 'cci':
            case 'cmf':
              params.period = 20;
              break;
            case 'roc':
              params.period = 12;
              break;
            case 'williamsr':
            case 'mfi':
              params.period = 14;
              break;
            case 'supertrend':
              params.period = 10;
              params.multiplier = 3;
              break;
            case 'volumesma':
              params.period = 20;
              break;
            default:
              break;
          }
          setIndicatorConfigs([
            ...indicatorConfigs,
            { id, kind, enabled: true, params, panel: 'overlay' },
          ]);
        }}
      />
      <StrategiesPanel />
      <OverlayPanel />
      <DrawingsPanel
        drawings={allDrawings}
        activeTool={drawingTool}
        onActiveToolChange={setDrawingTool}
        onToggle={() => {}}
        onRemove={(id) => removeDrawing(id)}
        onClear={() => clearSymbol(symbol)}
        showTools
      />
      <AlertsPanel />
    </div>
  );
}
