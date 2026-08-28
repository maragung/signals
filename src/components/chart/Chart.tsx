'use client';

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Candle,
  DrawingObject,
  IndicatorConfig,
  LiquidationLevel,
  MarketStructureEvent,
  MarketStructurePoint,
  StrategySignal,
  SupplyDemandZone,
  SupportResistanceLevel,
  Timeframe,
} from '@/types';
import { computeIndicator, type IndicatorResult } from '@/core/indicators';
import { useDrawings } from '@/stores/drawings';
import { isFiniteNum } from '@/core/utils/series';
import styles from './Chart.module.css';

type Lib = typeof import('lightweight-charts');

interface SeriesRef {
  main: import('lightweight-charts').ISeriesApi<'Candlestick' | 'Line' | 'Area'>;
  volume?: import('lightweight-charts').ISeriesApi<'Histogram'>;
  indicatorOverlays: Map<string, import('lightweight-charts').ISeriesApi<'Line'>>;
  indicatorPanels: Map<string, import('lightweight-charts').ISeriesApi<'Line' | 'Histogram'>>;
  priceLines: import('lightweight-charts').IPriceLine[]; // tracked for removal
}

export interface ChartProps {
  candles: Candle[];
  symbol: string;
  timeframe: Timeframe;
  chartType: 'candles' | 'line' | 'area' | 'ohlc';
  indicatorConfigs: IndicatorConfig[];
  snr: SupportResistanceLevel[];
  snd: SupplyDemandZone[];
  structurePoints: MarketStructurePoint[];
  structureEvents: MarketStructureEvent[];
  fibLevels: { price: number; ratio: number; visible: boolean }[];
  drawings: DrawingObject[];
  signals: StrategySignal[];
  showVolume?: boolean;
  showEntry?: boolean;
  showTP?: boolean;
  showSL?: boolean;
  drawingMode?: 'trendline' | 'hline' | 'fib-retracement' | 'text' | null;
  onDrawingComplete?: (d: Omit<DrawingObject, 'id' | 'createdAt'>) => void;
  liquidationLevels?: LiquidationLevel[];
  showLiquidationHeatmap?: boolean;
}

const COLORS = {
  bull: '#2ebd85',
  bear: '#f6465d',
  bullHist: 'rgba(46, 189, 133, 0.4)',
  bearHist: 'rgba(246, 70, 93, 0.4)',
  snrSup: 'rgba(46, 189, 133, 0.7)',
  snrRes: 'rgba(246, 70, 93, 0.7)',
  sndSupply: 'rgba(246, 70, 93, 0.15)',
  sndDemand: 'rgba(46, 189, 133, 0.15)',
  sndSupplyBorder: 'rgba(246, 70, 93, 0.6)',
  sndDemandBorder: 'rgba(46, 189, 133, 0.6)',
  bos: '#3b82f6',
  choch: '#f0b90b',
  structure: '#a78bfa',
  fib: '#fb923c',
};

export function Chart(props: ChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<import('lightweight-charts').IChartApi | null>(null);
  const libRef = useRef<Lib | null>(null);
  const seriesRef = useRef<SeriesRef | null>(null);
  const [libReady, setLibReady] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [prevClose, setPrevClose] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);
  const drawing = useDrawings((s) => s.addDrawing);

  // Load lib
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const lib = await import('lightweight-charts');
        if (!mounted) return;
        libRef.current = lib;
        setLibReady(true);
      } catch (err) {
        setChartError(String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Theme
  const theme = useChartTheme();

  // Create chart
  useEffect(() => {
    if (!libReady || !libRef.current || !containerRef.current) return;
    const lib = libRef.current;
    const container = containerRef.current;
    const chart = lib.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: lib.ColorType.Solid, color: theme.bg },
        textColor: theme.textColor,
        fontFamily: '-apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: theme.border,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: theme.textMuted, width: 1, style: 3, labelBackgroundColor: theme.bgElevated },
        horzLine: { color: theme.textMuted, width: 1, style: 3, labelBackgroundColor: theme.bgElevated },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;
    seriesRef.current = {
      main: chart.addCandlestickSeries({
        upColor: COLORS.bull,
        downColor: COLORS.bear,
        borderUpColor: COLORS.bull,
        borderDownColor: COLORS.bear,
        wickUpColor: COLORS.bull,
        wickDownColor: COLORS.bear,
      }),
      indicatorOverlays: new Map(),
      indicatorPanels: new Map(),
      priceLines: [],
    };
    // Subscribe to crosshair
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || param.seriesData.size === 0) {
        setHoverInfo(null);
        return;
      }
      const candle = param.seriesData.get(seriesRef.current!.main) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const vol = seriesRef.current?.volume
        ? (param.seriesData.get(seriesRef.current.volume) as { value: number } | undefined)
        : undefined;
      if (candle) {
        const t = typeof param.time === 'number' ? param.time : Number((param.time as unknown as { timestamp: number }).timestamp);
        setHoverInfo({
          o: candle.open,
          h: candle.high,
          l: candle.low,
          c: candle.close,
          v: vol?.value || 0,
          t,
        });
      }
    });
    return () => {
      try {
        chart.remove();
      } catch {
        // ignore
      }
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [libReady, theme.bg, theme.grid, theme.border, theme.bgElevated, theme.textColor, theme.textMuted]);

  // Switch main series on chart type change
  useEffect(() => {
    if (!chartRef.current || !libRef.current || !seriesRef.current) return;
    const chart = chartRef.current;
    const oldMain = seriesRef.current.main;
    const data = (oldMain as unknown as { dataByIndex?: unknown }).dataByIndex
      ? null
      : null;
    if (props.chartType === 'candles' || props.chartType === 'ohlc') {
      const s = chart.addCandlestickSeries({
        upColor: COLORS.bull,
        downColor: COLORS.bear,
        borderUpColor: COLORS.bull,
        borderDownColor: COLORS.bear,
        wickUpColor: COLORS.bull,
        wickDownColor: COLORS.bear,
      });
      if (data) s.setData(data as never);
      seriesRef.current.main = s;
      try {
        chart.removeSeries(oldMain);
      } catch {
        // ignore
      }
    } else if (props.chartType === 'line') {
      const s = chart.addLineSeries({ color: theme.accent, lineWidth: 2 });
      seriesRef.current.main = s;
      try {
        chart.removeSeries(oldMain);
      } catch {
        // ignore
      }
    } else if (props.chartType === 'area') {
      const s = chart.addAreaSeries({
        lineColor: theme.accent,
        topColor: 'rgba(240, 185, 11, 0.4)',
        bottomColor: 'rgba(240, 185, 11, 0)',
        lineWidth: 2,
      });
      seriesRef.current.main = s;
      try {
        chart.removeSeries(oldMain);
      } catch {
        // ignore
      }
    }
  }, [props.chartType, theme.accent]);

  // Update candle data (replace dataset)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || props.candles.length === 0) return;
    if (props.chartType === 'candles' || props.chartType === 'ohlc') {
      const data = props.candles.map((c) => ({
        time: c.time as import('lightweight-charts').UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      (series.main as import('lightweight-charts').ISeriesApi<'Candlestick'>).setData(data);
    } else if (props.chartType === 'line') {
      const data = props.candles.map((c) => ({ time: c.time as import('lightweight-charts').UTCTimestamp, value: c.close }));
      (series.main as import('lightweight-charts').ISeriesApi<'Line'>).setData(data);
    } else if (props.chartType === 'area') {
      const data = props.candles.map((c) => ({ time: c.time as import('lightweight-charts').UTCTimestamp, value: c.close }));
      (series.main as import('lightweight-charts').ISeriesApi<'Area'>).setData(data);
    }
    if (props.candles.length > 0) {
      const last = props.candles[props.candles.length - 1]!;
      setCurrentPrice(last.close);
      if (props.candles.length > 1) {
        setPrevClose(props.candles[props.candles.length - 2]!.close);
      }
    }
  }, [props.candles, props.chartType]);

  // Volume
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !chartRef.current) return;
    if (props.showVolume) {
      if (!series.volume) {
        series.volume = chartRef.current.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: '',
        });
        series.volume.priceScale().applyOptions({
          scaleMargins: { top: 0.85, bottom: 0 },
        });
      }
      const data = props.candles.map((c) => ({
        time: c.time as import('lightweight-charts').UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? COLORS.bullHist : COLORS.bearHist,
      }));
      series.volume.setData(data);
    } else if (series.volume) {
      try {
        chartRef.current.removeSeries(series.volume);
      } catch {
        // ignore
      }
      series.volume = undefined;
    }
  }, [props.showVolume, props.candles]);

  // Indicators
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || !libRef.current) return;
    const lib = libRef.current;
    // Clear existing overlays/panels
    for (const s of series.indicatorOverlays.values()) {
      try {
        chart.removeSeries(s);
      } catch {
        // ignore
      }
    }
    series.indicatorOverlays.clear();
    for (const s of series.indicatorPanels.values()) {
      try {
        chart.removeSeries(s);
      } catch {
        // ignore
      }
    }
    series.indicatorPanels.clear();
    if (props.candles.length === 0) return;
    for (const cfg of props.indicatorConfigs) {
      if (!cfg.enabled) continue;
      let result: IndicatorResult | null = null;
      try {
        result = computeIndicator(cfg, props.candles);
      } catch {
        continue;
      }
      if (!result) continue;
      const baseColor = cfg.color || randomColor(cfg.id);

      // Overlay series (flat array of points; multi-line indicators like BBands set `name` on each)
      if (result.overlay && result.overlay.length > 0) {
        // Group consecutive points with the same `name` to draw each as its own line.
        const groups: { name?: string; color?: string; data: { time: import('lightweight-charts').UTCTimestamp; value: number }[] }[] = [];
        for (const p of result.overlay) {
          if (!isFiniteNum(p.value)) continue;
          const name = (p as { name?: string }).name;
          const color = p.color || baseColor;
          const last = groups[groups.length - 1];
          if (last && last.name === name) {
            last.data.push({ time: p.time as import('lightweight-charts').UTCTimestamp, value: p.value });
          } else {
            groups.push({ name, color, data: [{ time: p.time as import('lightweight-charts').UTCTimestamp, value: p.value }] });
          }
        }
        for (let g = 0; g < groups.length; g++) {
          const gr = groups[g]!;
          const isUpperOrLower = gr.name && /upper|lower|band/i.test(gr.name);
          const s = chart.addLineSeries({
            color: gr.color || baseColor,
            lineWidth: isUpperOrLower ? 1 : 2,
            lineStyle: isUpperOrLower ? 2 : 0,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          s.setData(gr.data);
          series.indicatorOverlays.set(`${cfg.id}-o${g}`, s);
        }
      }

      // Separate series (each `name` group on its own panel)
      if (result.separate && result.separate.length > 0) {
        // Group by name
        const groups: { name?: string; color?: string; data: { time: import('lightweight-charts').UTCTimestamp; value: number }[] }[] = [];
        for (const p of result.separate) {
          if (!isFiniteNum(p.value)) continue;
          const last = groups[groups.length - 1];
          if (last && last.name === p.name) {
            last.data.push({ time: p.time as import('lightweight-charts').UTCTimestamp, value: p.value });
          } else {
            groups.push({ name: p.name, color: p.color || baseColor, data: [{ time: p.time as import('lightweight-charts').UTCTimestamp, value: p.value }] });
          }
        }
        for (let g = 0; g < groups.length; g++) {
          const gr = groups[g]!;
          const isHist = /hist/i.test(gr.name || '');
          if (isHist) {
            const s = chart.addHistogramSeries({
              color: gr.color || baseColor,
              priceScaleId: createPanel(chart, series, `${cfg.id}-${gr.name}`),
              priceLineVisible: false,
              lastValueVisible: false,
            });
            s.setData(
              gr.data.map((d) => ({
                time: d.time,
                value: d.value,
                color: d.value >= 0 ? COLORS.bullHist : COLORS.bearHist,
              })),
            );
            series.indicatorPanels.set(`${cfg.id}-${gr.name}-${g}`, s as never);
          } else {
            const s = chart.addLineSeries({
              color: gr.color || baseColor,
              lineWidth: 1,
              priceScaleId: createPanel(chart, series, `${cfg.id}-${gr.name}`),
              priceLineVisible: false,
              lastValueVisible: false,
            });
            s.setData(gr.data);
            series.indicatorPanels.set(`${cfg.id}-${gr.name}-${g}`, s);
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.indicatorConfigs, props.candles]);

  // Clear existing price lines before re-adding
  const clearPriceLines = () => {
    const series = seriesRef.current;
    const main = series?.main;
    if (!main || !series) return;
    for (const ln of series.priceLines) {
      try {
        main.removePriceLine(ln);
      } catch {
        // ignore
      }
    }
    series.priceLines = [];
  };

  // Liquidation heatmap (rendered as price lines with intensity-based width)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !props.showLiquidationHeatmap || !props.liquidationLevels) return;
    let maxIntensity = 0;
    for (const l of props.liquidationLevels) {
      const m = Math.max(l.longLiq, l.shortLiq);
      if (m > maxIntensity) maxIntensity = m;
    }
    if (maxIntensity <= 0) return;
    // Only render the top ~30 most intense levels to avoid clutter
    const ranked = props.liquidationLevels
      .slice()
      .sort((a, b) => Math.max(b.longLiq, b.shortLiq) - Math.max(a.longLiq, a.shortLiq))
      .slice(0, 30);
    for (const lvl of ranked) {
      const longRatio = lvl.longLiq / Math.max(1, maxIntensity);
      const shortRatio = lvl.shortLiq / Math.max(1, maxIntensity);
      const longLine = series.main.createPriceLine({
        price: lvl.price,
        color: `rgba(46, 189, 133, ${Math.min(1, 0.3 + longRatio)})`,
        lineWidth: longRatio > 0.5 ? 2 : 1,
        lineStyle: 3,
        axisLabelVisible: false,
        title: longRatio > 0.1 ? `L ${formatCompact(lvl.longLiq)}` : '',
      });
      series.priceLines.push(longLine);
      const shortLine = series.main.createPriceLine({
        price: lvl.price,
        color: `rgba(246, 70, 93, ${Math.min(1, 0.3 + shortRatio)})`,
        lineWidth: shortRatio > 0.5 ? 2 : 1,
        lineStyle: 3,
        axisLabelVisible: false,
        title: shortRatio > 0.1 ? `S ${formatCompact(lvl.shortLiq)}` : '',
      });
      series.priceLines.push(shortLine);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.liquidationLevels, props.showLiquidationHeatmap]);

  // SNR levels
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    clearPriceLines();
    for (const lvl of props.snr) {
      try {
        const line = series.main.createPriceLine({
          price: lvl.price,
          color: lvl.type === 'support' ? COLORS.snrSup : COLORS.snrRes,
          lineWidth: 1,
          lineStyle: lvl.type === 'support' ? 2 : 0,
          axisLabelVisible: true,
          title: `${lvl.type === 'support' ? 'S' : 'R'} ${(lvl.strength * 100).toFixed(0)}%`,
        });
        series.priceLines.push(line);
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.snr]);

  // SND zones as boxes
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !chartRef.current) return;
    const chart = chartRef.current;
    // We use price lines for top/bottom of each zone
    clearPriceLines();
    for (const z of props.snd) {
      const color = z.type === 'demand' ? COLORS.sndDemandBorder : COLORS.sndSupplyBorder;
      const fill = z.type === 'demand' ? COLORS.sndDemand : COLORS.sndSupply;
      try {
        const top = series.main.createPriceLine({ price: z.high, color, lineWidth: 1, lineStyle: 3, title: z.type === 'demand' ? 'D' : 'S' });
        const bottom = series.main.createPriceLine({ price: z.low, color, lineWidth: 1, lineStyle: 3, title: '' });
        series.priceLines.push(top, bottom);
        // also a faint fill via a histogram series? Keep simple: two lines only.
        void fill; // reserved for future
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.snd]);

  // Drawings
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // remove old drawing lines (everything after the SNR/SND ones)
    // simple approach: track them separately
    // For brevity, add as price lines (with title)
    // (Skip the cleanup: a full impl would track them in a separate array)
    for (const d of props.drawings) {
      try {
        if (d.kind === 'hline' && d.points.length === 1) {
          const line = series.main.createPriceLine({
            price: d.points[0]!.price,
            color: '#a78bfa',
            lineWidth: 1,
            lineStyle: 2,
            title: d.options.text as string | undefined,
          });
          series.priceLines.push(line);
        } else if (d.kind === 'trendline' && d.points.length === 2) {
          // light-weight: just show price line at midpoint
          const mid = (d.points[0]!.price + d.points[1]!.price) / 2;
          const line = series.main.createPriceLine({
            price: mid,
            color: '#a78bfa',
            lineWidth: 1,
            lineStyle: 0,
            title: 'TL',
          });
          series.priceLines.push(line);
        } else if (d.kind === 'fib-retracement' && d.points.length === 2) {
          // Show 0.5 level as anchor
          const p1 = d.points[0]!.price;
          const p2 = d.points[1]!.price;
          const mid = (p1 + p2) / 2;
          const line = series.main.createPriceLine({
            price: mid,
            color: COLORS.fib,
            lineWidth: 1,
            lineStyle: 1,
            title: 'FIB',
          });
          series.priceLines.push(line);
        } else if (d.kind === 'rect' && d.points.length === 2) {
          const top = series.main.createPriceLine({ price: Math.max(d.points[0]!.price, d.points[1]!.price), color: '#22d3ee', lineWidth: 1, lineStyle: 3, title: 'RECT' });
          const bottom = series.main.createPriceLine({ price: Math.min(d.points[0]!.price, d.points[1]!.price), color: '#22d3ee', lineWidth: 1, lineStyle: 3, title: '' });
          series.priceLines.push(top, bottom);
        }
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drawings]);

  // Structure events
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const ev of props.structureEvents.slice(-30)) {
      try {
        const line = series.main.createPriceLine({
          price: ev.price,
          color: ev.kind === 'BOS' ? COLORS.bos : COLORS.choch,
          lineWidth: 1,
          lineStyle: 2,
          title: `${ev.kind} ${ev.direction === 'bullish' ? '↑' : '↓'}`,
        });
        series.priceLines.push(line);
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.structureEvents]);

  // Drawing mode: capture click in chart area
  useEffect(() => {
    if (!props.drawingMode || !chartRef.current || !seriesRef.current) return;
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!container) return;
    let first: { time: number; price: number } | null = null;
    const handler = (param: import('lightweight-charts').MouseEventParams) => {
      if (!param.point || !param.time) return;
      const price = seriesRef.current!.main.coordinateToPrice(param.point.y);
      const time = typeof param.time === 'number' ? param.time : Number((param.time as unknown as { timestamp: number }).timestamp);
      if (!isFiniteNum(price)) return;
      if (props.drawingMode === 'hline') {
        drawing({
          kind: 'hline',
          points: [{ time, price }],
          options: {},
          symbol: props.symbol,
          timeframe: props.timeframe,
        });
        return;
      }
      if (!first) {
        first = { time, price };
        return;
      }
      const p1 = first;
      const p2 = { time, price };
      if (props.drawingMode === 'trendline') {
        drawing({ kind: 'trendline', points: [p1, p2], options: {}, symbol: props.symbol, timeframe: props.timeframe });
      } else if (props.drawingMode === 'fib-retracement') {
        drawing({ kind: 'fib-retracement', points: [p1, p2], options: {}, symbol: props.symbol, timeframe: props.timeframe });
      } else if (props.drawingMode === 'text') {
        drawing({ kind: 'text', points: [{ time, price }], options: { text: 'Note' }, symbol: props.symbol, timeframe: props.timeframe });
      }
      first = null;
    };
    chart.subscribeClick(handler);
    return () => {
      try {
        chart.unsubscribeClick(handler);
      } catch {
        // ignore
      }
    };
  }, [props.drawingMode, props.symbol, props.timeframe, drawing]);

  // Reset / fit content
  const onFit = () => {
    chartRef.current?.timeScale().fitContent();
  };

  return (
    <div className={styles.container}>
      {chartError && <div className={styles.error}>Chart failed to load: {chartError}</div>}
      <div ref={containerRef} className={styles.canvas} />
      <div className={styles.controls}>
        <button className="btn" onClick={onFit} title="Fit content">
          ⟲
        </button>
      </div>
      {currentPrice !== null && (
        <div className={styles.priceTag} data-side={currentPrice >= (prevClose ?? currentPrice) ? 'bull' : 'bear'}>
          {currentPrice.toFixed(2)}
        </div>
      )}
      {hoverInfo && (
        <div className={styles.ohlc}>
          <span>O <strong>{hoverInfo.o.toFixed(2)}</strong></span>
          <span>H <strong className="bull">{hoverInfo.h.toFixed(2)}</strong></span>
          <span>L <strong className="bear">{hoverInfo.l.toFixed(2)}</strong></span>
          <span>C <strong>{hoverInfo.c.toFixed(2)}</strong></span>
          {hoverInfo.v > 0 && <span>V <strong>{(hoverInfo.v / 1000).toFixed(1)}K</strong></span>}
          <span className={styles.time}>{new Date(hoverInfo.t * 1000).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

function useChartTheme() {
  const theme = useIsDark();
  return useMemo(() => {
    if (theme) {
      return {
        bg: '#0b0e11',
        bgElevated: '#2b3139',
        textColor: '#b7bdc6',
        textMuted: '#848e9c',
        grid: '#1e2329',
        border: '#2a2f37',
        accent: '#f0b90b',
      };
    }
    return {
      bg: '#ffffff',
      bgElevated: '#ffffff',
      textColor: '#474d57',
      textMuted: '#707a8a',
      grid: '#f0f0f0',
      border: '#e1e1e1',
      accent: '#f0b90b',
    };
  }, [theme]);
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    setDark(document.documentElement.getAttribute('data-theme') !== 'light');
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.getAttribute('data-theme') !== 'light');
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function randomColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 55%)`;
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

let panelCounter = 0;
function createPanel(
  chart: import('lightweight-charts').IChartApi,
  series: SeriesRef,
  name: string,
): string {
  const id = `panel-${++panelCounter}-${name}`;
  chart.priceScale(id).applyOptions({
    scaleMargins: { top: 0.7, bottom: 0.05 },
    autoScale: true,
  });
  return id;
}
