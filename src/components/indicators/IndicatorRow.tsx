'use client';

import React, { memo, useCallback } from 'react';
import type { IndicatorConfig, IndicatorKind } from '@/types';

export interface IndicatorRowProps {
  config: IndicatorConfig;
  onToggle: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
  onParamChange: (id: string, key: string, value: number | string | boolean) => void;
  onRemove?: (id: string) => void;
  onReset?: (id: string) => void;
}

const NUMERIC_PARAM_KEYS: Partial<Record<IndicatorKind, string[]>> = {
  sma: ['period'],
  ema: ['period'],
  wma: ['period'],
  rsi: ['period'],
  atr: ['period'],
  macd: ['fast', 'slow', 'signal'],
  bbands: ['period', 'stddev'],
  bbwidth: ['period', 'stddev'],
  keltner: ['period', 'multiplier'],
  adx: ['period'],
  stoch: ['k', 'd', 'smooth'],
  stochrsi: ['rsiPeriod', 'stochPeriod', 'k', 'd'],
  cci: ['period'],
  roc: ['period'],
  williamsr: ['period'],
  mfi: ['period'],
  cmf: ['period'],
  supertrend: ['period', 'multiplier'],
  volumesma: ['period'],
};

function IndicatorRowImpl(props: IndicatorRowProps) {
  const { config, onToggle, onColorChange, onParamChange, onRemove, onReset } = props;
  const paramKeys = NUMERIC_PARAM_KEYS[config.kind] ?? [];

  const handleToggle = useCallback(() => onToggle(config.id), [config.id, onToggle]);
  const handleColor = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onColorChange(config.id, e.target.value),
    [config.id, onColorChange],
  );
  const handleParam = useCallback(
    (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      const n = Number(v);
      onParamChange(config.id, key, Number.isFinite(n) ? n : v);
    },
    [config.id, onParamChange],
  );
  const handleRemove = useCallback(() => onRemove?.(config.id), [config.id, onRemove]);
  const handleReset = useCallback(() => onReset?.(config.id), [config.id, onReset]);

  return (
    <div
      data-testid={`indicator-row-${config.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 8,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={handleToggle}
          aria-label={`Enable ${config.kind}`}
          data-testid={`indicator-toggle-${config.id}`}
        />
        <span style={{ flex: 1, fontWeight: 500 }}>{config.id}</span>
        <input
          type="color"
          value={config.color ?? '#a78bfa'}
          onChange={handleColor}
          aria-label="Color"
          style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
        />
        {onRemove ? (
          <button type="button" onClick={handleRemove} aria-label="Remove" title="Remove">×</button>
        ) : null}
        {onReset ? (
          <button type="button" onClick={handleReset} aria-label="Reset" title="Reset to defaults">↺</button>
        ) : null}
      </div>
      {paramKeys.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {paramKeys.map((k) => (
            <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <span style={{ color: 'var(--text-muted)' }}>{k}</span>
              <input
                type="number"
                value={Number(config.params?.[k] ?? 0)}
                onChange={handleParam(k)}
                step="any"
                style={{ width: 64 }}
                aria-label={`${k} param`}
                data-testid={`indicator-param-${config.id}-${k}`}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const IndicatorRow = memo(IndicatorRowImpl);
IndicatorRow.displayName = 'IndicatorRow';
