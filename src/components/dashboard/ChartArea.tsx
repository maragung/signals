'use client';

import dynamic from 'next/dynamic';
import type { Candle, DrawingObject, LiquidationLevel, StrategySignal, Timeframe, TickerData } from '@/types';
import { useRef, useState, useEffect } from 'react';
import { useSettings } from '@/stores/settings';
import { useDrawings } from '@/stores/drawings';
import type { AnalysisResult } from '@/hooks/useAnalysisWorker';
import styles from './ChartArea.module.css';

// Chart is loaded client-side only and dynamically imported
const Chart = dynamic(() => import('@/components/chart/Chart').then((m) => m.Chart), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading chart…</div>,
});

export function ChartArea({
  candles,
  symbol,
  tf,
  ticker,
  analysis,
  drawings,
  signals,
  liquidationLevels,
  showLiquidationHeatmap,
}: {
  candles: Candle[];
  symbol: string;
  tf: Timeframe;
  ticker: TickerData | null;
  analysis: AnalysisResult;
  drawings: DrawingObject[];
  signals: StrategySignal[];
  liquidationLevels?: LiquidationLevel[];
  showLiquidationHeatmap?: boolean;
}) {
  const chartType = useSettings((s) => s.chartType);
  const setChartType = useSettings((s) => s.setChartType);
  const indicatorConfigs = useSettings((s) => s.indicatorConfigs);
  const overlays = useSettings((s) => s.overlays);
  const addDrawing = useDrawings((s) => s.addDrawing);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawingMode, setDrawingMode] = useState<null | 'trendline' | 'hline' | 'fib-retracement' | 'text'>(null);

  // Request fullscreen on container double-click
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDbl = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.();
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, []);

  return (
    <div className={styles.chartArea} ref={containerRef}>
      <div className={styles.toolbar}>
        <div className={styles.group}>
          {(['candles', 'line', 'area', 'ohlc'] as const).map((t) => (
            <button
              key={t}
              className={`${styles.tool} ${chartType === t ? styles.toolActive : ''}`}
              onClick={() => setChartType(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <div className={styles.group}>
          {(['trendline', 'hline', 'fib-retracement', 'text'] as const).map((k) => (
            <button
              key={k}
              className={`${styles.tool} ${drawingMode === k ? styles.toolActive : ''}`}
              onClick={() => setDrawingMode(drawingMode === k ? null : k)}
              title={`Add ${k}`}
            >
              {k === 'hline' ? '─' : k === 'trendline' ? '╱' : k === 'fib-retracement' ? 'FIB' : 'T'}
            </button>
          ))}
        </div>
        {ticker && (
          <div className={styles.tickerInfo}>
            <span className="muted">24h</span>
            <span className={ticker.change24h >= 0 ? 'bull' : 'bear'}>
              {ticker.changePercent24h.toFixed(2)}%
            </span>
            <span className="muted">H</span>
            <span>{ticker.high24h.toFixed(2)}</span>
            <span className="muted">L</span>
            <span>{ticker.low24h.toFixed(2)}</span>
          </div>
        )}
      </div>
      <div className={styles.chartWrap}>
        <Chart
          candles={candles}
          symbol={symbol}
          timeframe={tf}
          chartType={chartType}
          indicatorConfigs={indicatorConfigs}
          snr={overlays.snr ? analysis.snr : []}
          snd={overlays.snd ? analysis.snd : []}
          structurePoints={overlays.structure ? analysis.structurePoints : []}
          structureEvents={overlays.bos || overlays.choch ? analysis.structureEvents : []}
          fibLevels={overlays.fibonacci ? [] : []}
          drawings={drawings}
          signals={overlays.signals ? signals : []}
          showVolume={overlays.volume}
          showEntry={overlays.entry}
          showTP={overlays.tp}
          showSL={overlays.sl}
          drawingMode={drawingMode}
          onDrawingComplete={(d) => addDrawing(d)}
          liquidationLevels={liquidationLevels}
          showLiquidationHeatmap={showLiquidationHeatmap}
        />
      </div>
    </div>
  );
}
