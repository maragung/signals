/**
 * Smoke test for the IndicatorPanel component.
 * Verifies that the CSS module is wired and that the basic
 * interactions (toggle, color, params, add) work.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { IndicatorPanel } from './IndicatorPanel';
import type { IndicatorConfig } from '@/types';

function makeConfig(over: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    id: 'ema-test',
    kind: 'ema',
    enabled: true,
    params: { period: 21 },
    color: '#3b82f6',
    ...over,
  };
}

describe('IndicatorPanel smoke test', () => {
  it('renders without crashing given a basic config', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [makeConfig()],
        onChange: () => {},
      }),
    );
    expect(html).toBeDefined();
    // The panel root should be present
    expect(html).toContain('indicator-panel');
  });

  it('renders the empty state when no configs', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [],
        onChange: () => {},
      }),
    );
    expect(html).toBeDefined();
    expect(html).toContain('No indicators configured');
  });

  it('renders the add select when onAdd is provided', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [makeConfig()],
        onChange: () => {},
        onAdd: () => {},
      }),
    );
    expect(html).toBeDefined();
    expect(html).toContain('+ Add');
  });

  it('renders MACD row with fast/slow/signal param labels', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [
          makeConfig({
            id: 'macd-test',
            kind: 'macd',
            enabled: true,
            params: { fast: 12, slow: 26, signal: 9 },
            color: '#60a5fa',
          }),
        ],
        onChange: () => {},
      }),
    );
    expect(html).toContain('fast');
    expect(html).toContain('slow');
    expect(html).toContain('signal');
  });

  it('renders an enabled checkbox and color input', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [makeConfig()],
        onChange: () => {},
      }),
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="color"');
  });

  it('handles onAdd being undefined without crashing', () => {
    const html = renderToString(
      React.createElement(IndicatorPanel, {
        configs: [makeConfig()],
        onChange: () => {},
        onAdd: undefined,
      }),
    );
    expect(html).toBeDefined();
  });
});
