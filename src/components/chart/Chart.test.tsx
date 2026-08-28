/**
 * Smoke test for the chart component.
 */
import { describe, expect, it, vi } from 'vitest';
import React, { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Chart } from './Chart';
import type { Candle } from '@/types';

vi.mock('lightweight-charts', () => {
  const noop = () => {};
  const mkSeries = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
    removePriceLine: vi.fn(),
    setMarkers: vi.fn(),
    applyOptions: vi.fn(),
    coordinateToPrice: vi.fn(() => 100),
    priceToCoordinate: vi.fn(() => 50),
    priceScale: vi.fn(() => ({ applyOptions: noop })),
  });
  return {
    createChart: vi.fn(() => ({
      addCandlestickSeries: vi.fn(mkSeries),
      addBarSeries: vi.fn(mkSeries),
      addLineSeries: vi.fn(mkSeries),
      addAreaSeries: vi.fn(mkSeries),
      addHistogramSeries: vi.fn(mkSeries),
      removeSeries: noop,
      applyOptions: vi.fn(),
      resize: noop,
      remove: noop,
      timeScale: vi.fn(() => ({ fitContent: noop, setVisibleRange: noop })),
      priceScale: vi.fn(() => ({ applyOptions: noop })),
      subscribeCrosshairMove: noop,
      subscribeClick: vi.fn(() => noop),
    })),
    ColorType: { Solid: 'solid' },
    LineStyle: { Solid: 0 },
  };
});

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverMock;

function makeCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    out.push({ time: 1700000000 + i * 60, open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1000 });
    p += 0.1;
  }
  return out;
}

const baseProps = {
  symbol: 'BTCUSD',
  timeframe: '1h' as never,
  chartType: 'candles' as const,
  indicatorConfigs: [],
  snr: [],
  snd: [],
  structurePoints: [],
  structureEvents: [],
  fibLevels: [],
  drawings: [],
  signals: [],
};

describe('Chart smoke test', () => {
  it('renders without crashing given empty data', () => {
    const html = renderToString(React.createElement(Chart, { ...baseProps, candles: [] }));
    expect(html).toBeDefined();
  });

  it('renders without crashing given mock data', () => {
    const html = renderToString(React.createElement(Chart, { ...baseProps, candles: makeCandles(50) }));
    expect(html).toBeDefined();
  });

  it('handles 10,000 candles without throwing', () => {
    const html = renderToString(React.createElement(Chart, { ...baseProps, candles: makeCandles(10000) }));
    expect(html).toBeDefined();
  });
});
