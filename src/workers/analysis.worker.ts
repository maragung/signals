// Web worker for heavy indicator/structure/SNR/SND calculations.
// Receives { candles, indicatorConfigs, snrOptions, sndOptions, structureOptions }
// posts { indicatorResults, snr, snd, structurePoints, structureEvents }

import type { Candle, IndicatorConfig } from '@/types';

interface WorkRequest {
  id: string;
  candles: Candle[];
  indicatorConfigs: IndicatorConfig[];
  snrOptions?: Record<string, unknown>;
  sndOptions?: Record<string, unknown>;
  structureOptions?: Record<string, unknown>;
}

interface WorkResponse {
  id: string;
  indicatorResults?: Record<string, unknown>;
  snr?: unknown;
  snd?: unknown;
  structurePoints?: unknown;
  structureEvents?: unknown;
  error?: string;
}

self.onmessage = async (e: MessageEvent<WorkRequest>) => {
  const req = e.data;
  try {
    const [indicators, { detectSupportResistance }, { detectSupplyDemandZones }, { detectStructure }] = await Promise.all([
      import('@/core/indicators'),
      import('@/core/snr'),
      import('@/core/snd'),
      import('@/core/market-structure'),
    ]);
    const indicatorResults: Record<string, unknown> = {};
    for (const cfg of req.indicatorConfigs) {
      if (!cfg.enabled) continue;
      try {
        indicatorResults[cfg.id] = indicators.computeIndicator(cfg, req.candles);
      } catch (err) {
        indicatorResults[cfg.id] = { kind: cfg.kind, error: String(err) };
      }
    }
    const snr = detectSupportResistance(req.candles, req.snrOptions);
    const snd = detectSupplyDemandZones(req.candles, req.sndOptions);
    const structure = detectStructure(req.candles, req.structureOptions);
    const response: WorkResponse = {
      id: req.id,
      indicatorResults,
      snr,
      snd,
      structurePoints: structure.points,
      structureEvents: structure.events,
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: WorkResponse = { id: req.id, error: String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};

export {};
