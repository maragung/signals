'use client';

import React, { memo, useCallback, useMemo } from 'react';
import type { IndicatorConfig, IndicatorKind } from '@/types';
import { IndicatorRow } from './IndicatorRow';

export interface IndicatorPanelProps {
  configs: IndicatorConfig[];
  onChange: (next: IndicatorConfig[]) => void;
  onAdd?: (kind: IndicatorKind) => void;
}

const ADDABLE_KINDS: IndicatorKind[] = [
  'sma',
  'ema',
  'wma',
  'vwap',
  'rsi',
  'macd',
  'bbands',
  'atr',
  'adx',
  'supertrend',
  'stoch',
  'stochrsi',
  'cci',
  'roc',
  'williamsr',
  'mfi',
  'obv',
  'cmf',
  'keltner',
  'bbwidth',
  'volume',
  'volumesma',
];

function IndicatorPanelImpl(props: IndicatorPanelProps) {
  const { configs, onChange, onAdd } = props;

  const handleToggle = useCallback(
    (id: string) => {
      onChange(configs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
    },
    [configs, onChange],
  );

  const handleColorChange = useCallback(
    (id: string, color: string) => {
      onChange(configs.map((c) => (c.id === id ? { ...c, color } : c)));
    },
    [configs, onChange],
  );

  const handleParamChange = useCallback(
    (id: string, key: string, value: number | string | boolean) => {
      onChange(
        configs.map((c) =>
          c.id === id ? { ...c, params: { ...c.params, [key]: value } } : c,
        ),
      );
    },
    [configs, onChange],
  );

  const handleRemove = useCallback(
    (id: string) => {
      onChange(configs.filter((c) => c.id !== id));
    },
    [configs, onChange],
  );

  const handleReset = useCallback(
    (id: string) => {
      onChange(
        configs.map((c) =>
          c.id === id ? { ...c, params: defaultsFor(c.kind), color: defaultColor(c.kind) } : c,
        ),
      );
    },
    [configs, onChange],
  );

  const handleAdd = useCallback(
    (kind: IndicatorKind) => () => onAdd?.(kind),
    [onAdd],
  );

  const sorted = useMemo(() => {
    return [...configs].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [configs]);

  return (
    <div data-testid="indicator-panel" role="region" aria-label="Indicators">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 8,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <strong>Indicators</strong>
        {onAdd ? (
          <select
            aria-label="Add indicator"
            onChange={(e) => {
              if (e.target.value) {
                onAdd(e.target.value as IndicatorKind);
                e.target.value = '';
              }
            }}
            value=""
            data-testid="indicator-add"
          >
            <option value="">+ Add…</option>
            {ADDABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
          No indicators configured.
        </div>
      ) : (
        sorted.map((c) => (
          <IndicatorRow
            key={c.id}
            config={c}
            onToggle={handleToggle}
            onColorChange={handleColorChange}
            onParamChange={handleParamChange}
            onRemove={handleRemove}
            onReset={handleReset}
          />
        ))
      )}
    </div>
  );
}

export const IndicatorPanel = memo(IndicatorPanelImpl);
IndicatorPanel.displayName = 'IndicatorPanel';

// ---------------------------------------------------------------------------
// Defaults used by the "Reset" button
// ---------------------------------------------------------------------------

function defaultsFor(kind: IndicatorKind): Record<string, number | string | boolean> {
  switch (kind) {
    case 'sma':
    case 'ema':
    case 'wma':
      return { period: 20 };
    case 'rsi':
      return { period: 14 };
    case 'atr':
    case 'adx':
      return { period: 14 };
    case 'macd':
      return { fast: 12, slow: 26, signal: 9 };
    case 'bbands':
    case 'bbwidth':
      return { period: 20, stddev: 2 };
    case 'keltner':
      return { period: 20, multiplier: 2 };
    case 'stoch':
      return { k: 14, d: 3, smooth: 3 };
    case 'stochrsi':
      return { rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3 };
    case 'cci':
      return { period: 20 };
    case 'roc':
      return { period: 12 };
    case 'williamsr':
      return { period: 14 };
    case 'mfi':
      return { period: 14 };
    case 'cmf':
      return { period: 20 };
    case 'supertrend':
      return { period: 10, multiplier: 3 };
    case 'volumesma':
      return { period: 20 };
    case 'vwap':
    case 'volume':
    case 'obv':
      return {};
  }
}

function defaultColor(kind: IndicatorKind): string {
  switch (kind) {
    case 'sma':
      return '#22d3ee';
    case 'ema':
      return '#f6a609';
    case 'wma':
      return '#ec4899';
    case 'vwap':
      return '#eab308';
    case 'rsi':
      return '#a78bfa';
    case 'macd':
      return '#60a5fa';
    case 'bbands':
    case 'bbwidth':
    case 'keltner':
      return '#60a5fa';
    case 'atr':
      return '#fb923c';
    case 'adx':
      return '#22c55e';
    case 'stoch':
    case 'stochrsi':
      return '#a78bfa';
    case 'cci':
      return '#34d399';
    case 'roc':
      return '#f97316';
    case 'williamsr':
      return '#06b6d4';
    case 'mfi':
      return '#84cc16';
    case 'obv':
      return '#10b981';
    case 'cmf':
      return '#0ea5e9';
    case 'supertrend':
      return '#22c55e';
    case 'volume':
    case 'volumesma':
      return '#94a3b8';
  }
}
