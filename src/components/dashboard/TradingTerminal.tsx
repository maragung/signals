'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '@/stores/settings';
import { useMarket, getCandles } from '@/stores/market';
import { useDrawings } from '@/stores/drawings';
import { useAlerts } from '@/stores/alerts';
import { useLiquidations } from '@/stores/liquidations';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useProviderManager } from '@/hooks/useProviderManager';
import { useAnalysisWorker } from '@/hooks/useAnalysisWorker';
import { useLiquidationHeatmap } from '@/hooks/useLiquidationHeatmap';
import { findSymbol } from '@/config/symbols';
import { buildProjection } from '@/core/prediction/projection';
import { computeScore } from '@/core/scoring/scoring';
import { runStrategies } from '@/core/strategies';
import { analyzeMTF, type DataFetcher } from '@/core/mtf/mtf';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ChartArea } from './ChartArea';
import { RightPanel } from './RightPanel';
import { MobileLayout } from '../mobile/MobileLayout';
import { evaluateAlerts, notifyBrowser, requestNotificationPermission } from '@/market-data/alerts-engine';
import { useProviderManagerInstance } from '@/hooks/useProviderManagerInstance';
import type { Candle, ScoringResult, StrategySignal, TechnicalProjection, MTFAnalysis, Timeframe } from '@/types';
import styles from './TradingTerminal.module.css';

export function TradingTerminal() {
  const symbol = useSettings((s) => s.symbol);
  const tf = useSettings((s) => s.timeframe);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const indicatorConfigs = useSettings((s) => s.indicatorConfigs);
  const strategyConfigs = useSettings((s) => s.strategyConfigs);
  const overlays = useSettings((s) => s.overlays);
  const scoringWeights = useSettings((s) => s.scoringWeights);

  const candles = useMarket((s) => getCandles(s, symbol, tf));
  const ticker = useMarket((s) => s.ticker);
  const status = useMarket((s) => s.status);
  const addError = useMarket((s) => s.addError);

  const drawings = useDrawings((s) => s.getDrawings(symbol, tf));
  const alerts = useAlerts((s) => s.alerts);
  const markAlertTriggered = useAlerts((s) => s.markTriggered);

  const manager = useProviderManagerInstance();
  useProviderManager(manager);
  useLiquidationHeatmap();

  const isMobile = useMediaQuery('(max-width: 1024px)');

  const analysis = useAnalysisWorker(candles, indicatorConfigs);
  const heatmap = useLiquidations((s) => s.heatmap);

  // Compute scoring, projection, signals from the current candle set
  const computed = useMemo(() => {
    if (candles.length < 30) {
      return { score: null as ScoringResult | null, projection: null as TechnicalProjection | null, signals: [] as StrategySignal[] };
    }
    const score = computeScore(candles, {
      snr: analysis.snr,
      snd: analysis.snd,
      structure: analysis.structureEvents,
    }, scoringWeights);
    const projection = buildProjection(candles, score, {
      symbol,
      timeframe: tf,
      snr: analysis.snr,
      snd: analysis.snd,
      structure: analysis.structureEvents,
    });
    const signals = runStrategies(candles, strategyConfigs, {
      snr: analysis.snr,
      snd: analysis.snd,
      structureEvents: analysis.structureEvents,
      indicatorResults: analysis.indicatorResults,
    });
    return { score, projection, signals };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, analysis.snr, analysis.snd, analysis.structureEvents, scoringWeights, strategyConfigs, symbol, tf]);

  // MTF analysis (load multiple timeframes)
  const [mtf, setMtf] = useState<MTFAnalysis | null>(null);
  useEffect(() => {
    if (!manager || candles.length < 30) return;
    let cancelled = false;
    const fetcher: DataFetcher = {
      fetchCandles: async (sym: string, t: Timeframe) => {
        const m = manager as { getHistoricalCandles: (s: string, tf: Timeframe, limit: number) => Promise<Candle[]> };
        return m.getHistoricalCandles(sym, t, 300);
      },
    };
    (async () => {
      try {
        const tfs: Timeframe[] = ['1d', '4h', '1h', '15m', '5m'];
        const result = await analyzeMTF(symbol, tfs, fetcher, {});
        if (!cancelled) setMtf(result);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manager, symbol, candles.length]);

  // Alert evaluation on every tick
  const lastEval = useRef<{ price: number; triggered: Set<string> }>({ price: 0, triggered: new Set() });
  useEffect(() => {
    if (candles.length < 2) return;
    const last = candles[candles.length - 1]!;
    const prev = candles[candles.length - 2]!;
    const ctx = {
      symbol,
      candles,
      ticker: ticker ? { price: ticker.price } : null,
      snr: analysis.snr,
      snd: analysis.snd,
      structureEvents: analysis.structureEvents,
      signals: computed.signals,
      lastPrice: last.close,
      prevPrice: prev.close,
    };
    const { triggered } = evaluateAlerts(alerts, ctx);
    for (const a of triggered) {
      if (!lastEval.current.triggered.has(a.id)) {
        lastEval.current.triggered.add(a.id);
        markAlertTriggered(a.id);
        void notifyBrowser(
          `Alert: ${symbol}`,
          `${a.kind} triggered at ${last.close.toFixed(2)}`,
        );
      }
    }
    lastEval.current.price = last.close;
  }, [candles, ticker, analysis.snr, analysis.snd, analysis.structureEvents, computed.signals, alerts, symbol, markAlertTriggered]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    if (alerts.length > 0) {
      void requestNotificationPermission();
    }
  }, [alerts.length]);

  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      addError(String(e.message || e.error || 'Unknown error'));
    };
    window.addEventListener('error', handler);
    return () => window.removeEventListener('error', handler);
  }, [addError]);

  if (isMobile) {
    return (
      <MobileLayout
        candles={candles}
        ticker={ticker}
        status={status}
        symbol={symbol}
        tf={tf}
        theme={theme}
        onThemeToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        score={computed.score}
        projection={computed.projection}
        signals={computed.signals}
        snr={analysis.snr}
        snd={analysis.snd}
        structurePoints={analysis.structurePoints}
        structureEvents={analysis.structureEvents}
        drawings={drawings}
        indicatorResults={analysis.indicatorResults}
        mtf={mtf}
      />
    );
  }

  return (
    <div className={styles.shell}>
      <Header
        symbol={symbol}
        tf={tf}
        ticker={ticker}
        status={status}
        theme={theme}
        onThemeToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />
      <div className={styles.main}>
        <Sidebar
          symbol={symbol}
          onSelect={(id) => useSettings.getState().setSymbol(id)}
        />
        <ChartArea
          candles={candles}
          symbol={symbol}
          tf={tf}
          ticker={ticker}
          analysis={analysis}
          drawings={drawings}
          signals={computed.signals}
          liquidationLevels={overlays.liquidationHeatmap ? heatmap?.levels : undefined}
          showLiquidationHeatmap={overlays.liquidationHeatmap}
        />
        <RightPanel
          symbol={symbol}
          tf={tf}
          score={computed.score}
          projection={computed.projection}
          signals={computed.signals}
          snr={analysis.snr}
          snd={analysis.snd}
          structurePoints={analysis.structurePoints}
          structureEvents={analysis.structureEvents}
          mtf={mtf}
          liquidationHeatmap={overlays.liquidationHeatmap ? heatmap : null}
        />
      </div>
    </div>
  );
}
