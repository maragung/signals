'use client';

import React, { memo, useCallback } from 'react';

export type DrawingKind =
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'pricerange'
  | 'daterange'
  | 'fib-retracement'
  | 'fib-extension'
  | 'arrow'
  | 'text'
  | 'measure';

export interface DrawingToolsProps {
  /** Active tool id (or 'select' when no tool is active). */
  active: DrawingKind | 'select';
  /** Called when the user picks a tool. Pass null/select to clear. */
  onChange: (k: DrawingKind | 'select') => void;
  /** Optional list of tools to render; defaults to a common set. */
  tools?: readonly DrawingTool[];
}

export interface DrawingTool {
  id: DrawingKind;
  label: string;
  /** When true, the tool is a single-click rather than click-drag. */
  oneShot?: boolean;
}

const DEFAULT_TOOLS: readonly DrawingTool[] = [
  { id: 'trendline', label: 'Trend' },
  { id: 'ray', label: 'Ray' },
  { id: 'hline', label: 'H-Line', oneShot: true },
  { id: 'vline', label: 'V-Line', oneShot: true },
  { id: 'rect', label: 'Rect' },
  { id: 'fib-retracement', label: 'Fib Ret' },
  { id: 'fib-extension', label: 'Fib Ext' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'text', label: 'Text' },
  { id: 'measure', label: 'Measure' },
];

function DrawingToolsImpl(props: DrawingToolsProps) {
  const { active, onChange, tools = DEFAULT_TOOLS } = props;
  const handle = useCallback(
    (id: DrawingKind | 'select') => () => onChange(id),
    [onChange],
  );
  return (
    <div role="toolbar" aria-label="Drawing tools" data-testid="drawing-tools">
      <button
        type="button"
        title="Select / pan"
        onClick={handle('select')}
        aria-pressed={active === 'select'}
        data-testid="drawing-tool-select"
        style={{
          padding: '4px 8px',
          fontSize: 12,
          background: active === 'select' ? 'var(--accent)' : 'var(--bg-tertiary)',
          color: active === 'select' ? '#000' : 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          marginRight: 4,
        }}
      >
        ✥
      </button>
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          title={`Draw ${t.label}`}
          onClick={handle(t.id)}
          aria-pressed={active === t.id}
          data-testid={`drawing-tool-${t.id}`}
          style={{
            padding: '4px 8px',
            fontSize: 12,
            background: active === t.id ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: active === t.id ? '#000' : 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            marginRight: 4,
            marginBottom: 4,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const DrawingTools = memo(DrawingToolsImpl);
DrawingTools.displayName = 'DrawingTools';

export { DEFAULT_TOOLS };
