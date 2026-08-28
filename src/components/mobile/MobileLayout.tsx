'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { nanoid } from 'nanoid';
import type { IndicatorKind } from '@/types';
import type {
  Candle,
  DrawingObject,
  MarketStructureEvent,
  MarketStructurePoint,
  MTFAnalysis,
  ScoringResult,
  StrategySignal,
  SupplyDemandZone,
  SupportResistanceLevel,
  TechnicalProjection,
  TickerData,
  Timeframe,
} from '@/types';
import { TIMEFRAMES } from '@/types';
import { useSettings } from '@/stores/settings';
import { useDrawings } from '@/stores/drawings';
import { SYMBOLS } from '@/config/symbols';
import { Header } from '@/components/dashboard/Header';
import { MTFDashboard } from '@/components/mtf/MTFDashboard';
import { ScorePanel } from '@/components/signals/ScorePanel';
import { ProjectionPanel } from '@/components/signals/ProjectionPanel';
import { SignalsPanel } from '@/components/signals/SignalsPanel';
import { LevelsPanel } from '@/components/signals/LevelsPanel';
import { MarketStructurePanel } from '@/components/signals/MarketStructurePanel';
import { IndicatorPanel } from '@/components/indicators/IndicatorPanel';
import { StrategiesPanel } from '@/components/strategies/StrategiesPanel';
import { OverlayPanel } from '@/components/overlays/OverlayPanel';
import { DrawingsPanel } from '@/components/drawings/DrawingsPanel';
import type { DrawingKind } from '@/components/drawings/DrawingTools';
import { AlertsPanel } from '@/components/alerts/AlertsPanel';
import { LiquidationHeatmapPanel } from '@/components/signals/LiquidationHeatmapPanel';
import type { AnalysisResult } from '@/hooks/useAnalysisWorker';
import styles from './MobileLayout.module.css';

const Chart = dynamic(() => import('@/components/chart/Chart').then((m) => m.Chart), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading…</div>,
});

type Tab = 'chart' | 'price' | 'signal' | 'indicators' | 'levels' | 'strategy' | 'alerts' | 'analysis' | 'liq';

export function MobileLayout({
  candles,
  symbol,
  tf,
  ticker,
  status,
  theme,
  onThemeToggle,
  score,
  projection,
  signals,
  snr,
  snd,
  structurePoints,
  structureEvents,
  drawings,
  indicatorResults,
  mtf,
}: {
  candles: Candle[];
  ticker: TickerData | null;
  status: string;
  symbol: string;
  tf: Timeframe;
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
  score: ScoringResult | null;
  projection: TechnicalProjection | null;
  signals: StrategySignal[];
  snr: SupportResistanceLevel[];
  snd: SupplyDemandZone[];
  structurePoints: MarketStructurePoint[];
  structureEvents: MarketStructureEvent[];
  drawings: DrawingObject[];
  indicatorResults: Record<string, unknown>;
  mtf: MTFAnalysis | null;
}) {
  const [tab, setTab] = useState<Tab>('chart');
  const setSymbol = useSettings((s) => s.setSymbol);
  const setTf = useSettings((s) => s.setTimeframe);
  const chartType = useSettings((s) => s.chartType);
  const setChartType = useSettings((s) => s.setChartType);
  const overlays = useSettings((s) => s.overlays);
  const indicatorConfigs = useSettings((s) => s.indicatorConfigs);
  const setIndicatorConfigs = useSettings((s) => s.setIndicatorConfigs);
  const allDrawings = useDrawings((s) => s.drawings);
  const removeDrawing = useDrawings((s) => s.removeDrawing);
  const clearSymbol = useDrawings((s) => s.clearSymbol);
  const addDrawing = useDrawings((s) => s.addDrawing);
  const [drawingTool, setDrawingTool] = useState<DrawingKind | 'select'>('select');

  return (
    <div className={styles.shell}>
      <Header
        symbol={symbol}
        tf={tf}
        ticker={ticker}
        status={status}
        theme={theme}
        onThemeToggle={onThemeToggle}
      />
      <div className={styles.body}>
        {tab === 'chart' && (
          <div className={styles.chartPage}>
            <Chart
              candles={candles}
              symbol={symbol}
              timeframe={tf}
              chartType={chartType}
              indicatorConfigs={indicatorConfigs}
              snr={overlays.snr ? snr : []}
              snd={overlays.snd ? snd : []}
              structurePoints={overlays.structure ? structurePoints : []}
              structureEvents={overlays.bos || overlays.choch ? structureEvents : []}
              fibLevels={[]}
              drawings={drawings}
              signals={overlays.signals ? signals : []}
              showVolume={overlays.volume}
              showEntry={overlays.entry}
              showTP={overlays.tp}
              showSL={overlays.sl}
              onDrawingComplete={(d) => addDrawing(d)}
            />
            <div className={styles.tfRow}>
              {TIMEFRAMES.map((t) => (
                <button
                  key={t}
                  className={`${styles.tfBtn} ${t === tf ? styles.tfActive : ''}`}
                  onClick={() => setTf(t)}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'price' && (
          <div className={styles.scroll}>
            <div className={styles.pairPicker}>
              {SYMBOLS.map((s) => (
                <button
                  key={s.id}
                  className={`${styles.pairBtn} ${symbol === s.id ? styles.pairActive : ''}`}
                  onClick={() => setSymbol(s.id)}
                >
                  {s.id}
                </button>
              ))}
            </div>
            <div className={styles.card}>
              <div className={styles.bigPrice}>{ticker?.price.toFixed(2) ?? '—'}</div>
              <div className={ticker && ticker.change24h >= 0 ? styles.bull : styles.bear}>
                {ticker ? `${ticker.changePercent24h.toFixed(2)}%` : '—'}
              </div>
              <div className={styles.statGrid}>
                <div>
                  <div className={styles.statLabel}>24h High</div>
                  <div>{ticker?.high24h.toFixed(2) ?? '—'}</div>
                </div>
                <div>
                  <div className={styles.statLabel}>24h Low</div>
                  <div>{ticker?.low24h.toFixed(2) ?? '—'}</div>
                </div>
                <div>
                  <div className={styles.statLabel}>24h Vol</div>
                  <div>{ticker ? (ticker.volume24h / 1e6).toFixed(2) + 'M' : '—'}</div>
                </div>
                <div>
                  <div className={styles.statLabel}>Status</div>
                  <div>{status.toUpperCase()}</div>
                </div>
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardTitle}>Chart Type</div>
              <div className={styles.row}>
                {(['candles', 'line', 'area', 'ohlc'] as const).map((t) => (
                  <button
                    key={t}
                    className={`${styles.choice} ${chartType === t ? styles.choiceActive : ''}`}
                    onClick={() => setChartType(t)}
                  >
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {tab === 'signal' && (
          <div className={styles.scroll}>
            <ScorePanel score={score} />
            <ProjectionPanel projection={projection} />
            <SignalsPanel signals={signals} />
          </div>
        )}
        {tab === 'indicators' && (
          <div className={styles.scroll}>
            <IndicatorPanel
              configs={indicatorConfigs}
              onChange={setIndicatorConfigs}
              onAdd={(kind: IndicatorKind) => {
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
            <OverlayPanel />
          </div>
        )}
        {tab === 'levels' && (
          <div className={styles.scroll}>
            <LevelsPanel snr={snr} snd={snd} />
            <MarketStructurePanel points={structurePoints} events={structureEvents} />
          </div>
        )}
        {tab === 'strategy' && (
          <div className={styles.scroll}>
            <StrategiesPanel />
            <MTFDashboard mtf={mtf} />
          </div>
        )}
        {tab === 'alerts' && (
          <div className={styles.scroll}>
            <AlertsPanel />
            <DrawingsPanel
              drawings={allDrawings}
              activeTool={drawingTool}
              onActiveToolChange={setDrawingTool}
              onToggle={() => {}}
              onRemove={(id) => removeDrawing(id)}
              onClear={() => clearSymbol(symbol)}
              showTools
            />
          </div>
        )}
        {tab === 'analysis' && (
          <div className={styles.scroll}>
            <ScorePanel score={score} />
            <ProjectionPanel projection={projection} />
            <SignalsPanel signals={signals} detailed />
            <MTFDashboard mtf={mtf} />
          </div>
        )}
        {tab === 'liq' && (
          <div className={styles.scroll}>
            <LiquidationHeatmapPanel />
          </div>
        )}
      </div>
      <nav className={styles.tabbar}>
        {(
          [
            { k: 'chart', l: 'Chart' },
            { k: 'price', l: 'Price' },
            { k: 'signal', l: 'Signal' },
            { k: 'indicators', l: 'Ind' },
            { k: 'levels', l: 'Levels' },
            { k: 'strategy', l: 'Strat' },
            { k: 'liq', l: 'Liq' },
            { k: 'alerts', l: 'Alerts' },
          ] as { k: Tab; l: string }[]
        ).map(({ k, l }) => (
          <button
            key={k}
            className={`${styles.tabBtn} ${tab === k ? styles.tabActive : ''}`}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </nav>
    </div>
  );
}
