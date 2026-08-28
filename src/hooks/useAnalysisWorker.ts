'use client';

import { useEffect, useRef, useState } from 'react';
import type { Candle, IndicatorConfig, SupportResistanceLevel, SupplyDemandZone, MarketStructurePoint, MarketStructureEvent } from '@/types';

export interface AnalysisResult {
  indicatorResults: Record<string, unknown>;
  snr: SupportResistanceLevel[];
  snd: SupplyDemandZone[];
  structurePoints: MarketStructurePoint[];
  structureEvents: MarketStructureEvent[];
  computing: boolean;
  lastRunAt: number;
}

export function useAnalysisWorker(
  candles: Candle[],
  indicatorConfigs: IndicatorConfig[],
): AnalysisResult {
  const [result, setResult] = useState<AnalysisResult>({
    indicatorResults: {},
    snr: [],
    snd: [],
    structurePoints: [],
    structureEvents: [],
    computing: false,
    lastRunAt: 0,
  });
  const workerRef = useRef<Worker | null>(null);
  const lastRunRef = useRef<number>(0);
  const idRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current.onmessage = (e: MessageEvent) => {
        const data = e.data as {
          id: number;
          indicatorResults?: Record<string, unknown>;
          snr?: SupportResistanceLevel[];
          snd?: SupplyDemandZone[];
          structurePoints?: MarketStructurePoint[];
          structureEvents?: MarketStructureEvent[];
          error?: string;
        };
        if (data.id !== idRef.current) return;
        setResult((r) => ({
          ...r,
          indicatorResults: data.indicatorResults || {},
          snr: data.snr || [],
          snd: data.snd || [],
          structurePoints: data.structurePoints || [],
          structureEvents: data.structureEvents || [],
          computing: false,
          lastRunAt: Date.now(),
        }));
      };
      workerRef.current.onerror = () => {
        setResult((r) => ({ ...r, computing: false }));
      };
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerRef.current) return;
    if (candles.length < 30) return;
    // throttle: at most once per 750ms
    const now = Date.now();
    if (now - lastRunRef.current < 750) return;
    lastRunRef.current = now;
    const myId = ++idRef.current;
    setResult((r) => ({ ...r, computing: true }));
    workerRef.current.postMessage({
      id: myId,
      candles,
      indicatorConfigs,
    });
  }, [candles, indicatorConfigs]);

  return result;
}
