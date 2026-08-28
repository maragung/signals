'use client';

import type {
  Candle,
  LiquidationHeatmap,
  MarketStructureEvent,
  MarketStructurePoint,
  MTFAnalysis,
  ScoringResult,
  StrategySignal,
  SupplyDemandZone,
  SupportResistanceLevel,
  TechnicalProjection,
  Timeframe,
} from '@/types';
import { MTFDashboard } from '@/components/mtf/MTFDashboard';
import { ProjectionPanel } from '@/components/signals/ProjectionPanel';
import { ScorePanel } from '@/components/signals/ScorePanel';
import { SignalsPanel } from '@/components/signals/SignalsPanel';
import { LevelsPanel } from '@/components/signals/LevelsPanel';
import { MarketStructurePanel } from '@/components/signals/MarketStructurePanel';
import { LiquidationHeatmapPanel } from '@/components/signals/LiquidationHeatmapPanel';
import { useState } from 'react';
import styles from './RightPanel.module.css';

export function RightPanel({
  symbol,
  tf,
  score,
  projection,
  signals,
  snr,
  snd,
  structurePoints,
  structureEvents,
  mtf,
  liquidationHeatmap,
}: {
  symbol: string;
  tf: Timeframe;
  score: ScoringResult | null;
  projection: TechnicalProjection | null;
  signals: StrategySignal[];
  snr: SupportResistanceLevel[];
  snd: SupplyDemandZone[];
  structurePoints: MarketStructurePoint[];
  structureEvents: MarketStructureEvent[];
  mtf: MTFAnalysis | null;
  liquidationHeatmap: LiquidationHeatmap | null;
}) {
  const [tab, setTab] = useState<'signal' | 'mtf' | 'levels' | 'structure' | 'signals' | 'liq'>('signal');
  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {(['signal', 'mtf', 'levels', 'structure', 'signals', 'liq'] as const).map((t) => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'liq' ? 'LIQ' : t.toUpperCase()}
          </button>
        ))}
      </div>
      <div className={styles.content}>
        {tab === 'signal' && (
          <>
            <ScorePanel score={score} />
            <ProjectionPanel projection={projection} />
            <SignalsPanel signals={signals} />
          </>
        )}
        {tab === 'mtf' && <MTFDashboard mtf={mtf} />}
        {tab === 'levels' && <LevelsPanel snr={snr} snd={snd} />}
        {tab === 'structure' && <MarketStructurePanel points={structurePoints} events={structureEvents} />}
        {tab === 'signals' && <SignalsPanel signals={signals} detailed />}
        {tab === 'liq' && <LiquidationHeatmapPanel />}
      </div>
    </div>
  );
}
