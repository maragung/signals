/**
 * Smoke test for the LiquidationHeatmapPanel. Verifies that the
 * region-blocked status renders a friendly message instead of
 * the generic "Failed to load" error.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Stub the zustand store before importing the component
vi.mock('@/stores/liquidations', () => {
  return {
    useLiquidations: (selector: (s: { status: string; heatmap: unknown; snapshot: unknown; recent: unknown[] }) => unknown) => {
      const state = { status: 'region-blocked', heatmap: null, snapshot: null, recent: [] };
      return selector(state);
    },
  };
});

vi.mock('@/stores/settings', () => {
  return {
    useSettings: (selector: (s: { symbol: string }) => unknown) => {
      return selector({ symbol: 'BTCUSD' });
    },
  };
});

// Stub the SymbolInfo used by the panel
vi.mock('@/config/symbols', () => ({
  findSymbol: () => ({
    id: 'BTCUSD',
    display: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    category: 'crypto' as const,
    providerIds: { binance: 'BTCUSDT', coingecko: 'bitcoin', binanceFutures: 'BTCUSDT' },
    pricePrecision: 2,
    volumePrecision: 2,
  }),
}));

import { LiquidationHeatmapPanel } from './LiquidationHeatmapPanel';

describe('LiquidationHeatmapPanel — region-blocked state', () => {
  it('shows a friendly "unavailable in your region" message', () => {
    const html = renderToString(React.createElement(LiquidationHeatmapPanel));
    expect(html).toContain('Futures data is unavailable in your region');
    expect(html).toContain('unavailable'); // source tag
  });

  it('does NOT show the generic "Failed to load" message when region-blocked', () => {
    const html = renderToString(React.createElement(LiquidationHeatmapPanel));
    expect(html).not.toContain('Failed to load');
  });

  it('explains that other analytics still work', () => {
    const html = renderToString(React.createElement(LiquidationHeatmapPanel));
    expect(html).toMatch(/spot candles/);
    expect(html).toMatch(/indicators/);
  });
});
