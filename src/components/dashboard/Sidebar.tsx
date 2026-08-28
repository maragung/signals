'use client';

import { useSettings } from '@/stores/settings';
import { SYMBOLS } from '@/config/symbols';
import { useMarket } from '@/stores/market';
import { useDrawings } from '@/stores/drawings';
import { useState } from 'react';
import { formatPercent, pctChange } from '@/core/utils/series';
import { IndicatorPanel } from '@/components/indicators/IndicatorPanel';
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
      <IndicatorPanel configs={indicatorConfigs} onChange={setIndicatorConfigs} />
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
