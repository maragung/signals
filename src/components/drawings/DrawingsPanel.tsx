'use client';

import React, { memo, useCallback, useMemo } from 'react';
import type { DrawingObject } from '@/types';
import { DrawingTools, type DrawingKind } from './DrawingTools';

export interface DrawingsPanelProps {
  drawings: DrawingObject[];
  activeTool: DrawingKind | 'select';
  onActiveToolChange: (k: DrawingKind | 'select') => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onInvert?: (id: string) => void;
  /** Optional map of drawing-id → visible flag. */
  visibility?: Record<string, boolean>;
  /** If true, render the tools row at the top. */
  showTools?: boolean;
}

function DrawingsPanelImpl(props: DrawingsPanelProps) {
  const {
    drawings,
    activeTool,
    onActiveToolChange,
    onToggle,
    onRemove,
    onClear,
    onInvert,
    visibility,
    showTools = true,
  } = props;

  const sorted = useMemo(() => {
    return [...drawings].sort((a, b) => b.createdAt - a.createdAt);
  }, [drawings]);

  const handleToggle = useCallback(
    (id: string) => () => onToggle(id),
    [onToggle],
  );
  const handleRemove = useCallback(
    (id: string) => () => onRemove(id),
    [onRemove],
  );
  const handleInvert = useCallback(
    (id: string) => () => onInvert?.(id),
    [onInvert],
  );

  return (
    <div data-testid="drawings-panel" role="region" aria-label="Drawings">
      {showTools ? (
        <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
          <DrawingTools active={activeTool} onChange={onActiveToolChange} />
        </div>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 8,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <strong>Drawings ({sorted.length})</strong>
        <button
          type="button"
          onClick={onClear}
          disabled={sorted.length === 0}
          data-testid="drawings-clear"
        >
          Clear all
        </button>
      </div>
      {sorted.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
          No drawings yet. Pick a tool above and click on the chart.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sorted.map((d) => {
            const isVisible = visibility ? visibility[d.id] !== false : true;
            return (
              <li
                key={d.id}
                data-testid={`drawing-row-${d.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={handleToggle(d.id)}
                  aria-label="Visible"
                  data-testid={`drawing-visible-${d.id}`}
                />
                <span style={{ flex: 1 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{d.kind}</span>
                  {d.points[0] ? (
                    <span style={{ marginLeft: 8 }}>
                      {d.points.map((p, i) => (
                        <span key={i} style={{ color: 'var(--text-muted)', marginRight: 6 }}>
                          [{i}]{' '}
                          {Number.isFinite(p.price) ? p.price.toFixed(2) : '—'} @{' '}
                          {Number.isFinite(p.time) ? new Date(p.time * 1000).toLocaleTimeString() : '—'}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {onInvert ? (
                  <button type="button" onClick={handleInvert(d.id)} aria-label="Invert" title="Invert">↕</button>
                ) : null}
                <button type="button" onClick={handleRemove(d.id)} aria-label="Remove" title="Remove">×</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const DrawingsPanel = memo(DrawingsPanelImpl);
DrawingsPanel.displayName = 'DrawingsPanel';
