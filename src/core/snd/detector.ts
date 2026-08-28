// Main supply & demand zone detection pipeline.
//
//   1) Scan for pattern candidates (base-rally, base-drop, RBR, DBD)
//   2) Score each candidate
//   3) Classify status (fresh / tested / broken) using future price
//   4) Filter, deduplicate, and return
//
// All functions are pure. The detector returns a deterministic set of
// zones for a given input.

import type { Candle, SupplyDemandZone } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import { detectPatterns, type PatternOptions, type ZoneCandidate } from './patterns';
import { scoreCandidate, scoreZone, type StrengthOptions } from './strength';
import { classifyZone, type StatusOptions } from './status';
import { nanoid } from 'nanoid';

export interface DetectSndOptions {
  pattern: Partial<PatternOptions>;
  strength: Partial<StrengthOptions>;
  status: Partial<StatusOptions>;
  /**
   * Minimum strength score to keep a zone. Default 0 (keep all).
   */
  minStrength: number;
  /** Maximum zones to return. Default 50. */
  maxZones: number;
  /** Cluster tolerance: merge zones whose midpoints are within this %. */
  clusterTolerancePct: number;
}

export const DEFAULT_SND_OPTIONS: DetectSndOptions = {
  pattern: {},
  strength: {},
  status: {},
  minStrength: 0,
  maxZones: 50,
  clusterTolerancePct: 0.5,
};

function makeId(): string {
  try {
    return nanoid(10);
  } catch {
    return `snd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function candidateToZone(cand: ZoneCandidate, strength: number): SupplyDemandZone {
  return {
    id: makeId(),
    type: cand.type,
    high: cand.high,
    low: cand.low,
    originTime: cand.originTime,
    status: 'fresh',
    strength,
    base: cand.base,
    pattern: cand.pattern,
  };
}

function midpoint(z: SupplyDemandZone): number {
  return (z.high + z.low) / 2;
}

function clusterZones(
  zones: SupplyDemandZone[],
  tolerancePct: number,
): SupplyDemandZone[] {
  if (zones.length === 0) return zones;
  // Sort by origin time so output is deterministic
  const sorted = zones.slice().sort((a, b) => a.originTime - b.originTime);
  const out: SupplyDemandZone[] = [];
  for (const z of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.type === z.type &&
      Math.abs(midpoint(last) - midpoint(z)) <=
        Math.max(Math.abs(midpoint(z)), 1) * (tolerancePct / 100)
    ) {
      // Merge: keep the stronger zone, widen the high/low envelope
      const merged: SupplyDemandZone = {
        id: last.strength >= z.strength ? last.id : z.id,
        type: last.type,
        high: Math.max(last.high, z.high),
        low: Math.min(last.low, z.low),
        originTime: Math.min(last.originTime, z.originTime),
        status: last.status === 'broken' || z.status === 'broken' ? 'broken' : last.status === 'tested' || z.status === 'tested' ? 'tested' : 'fresh',
        strength: Math.max(last.strength, z.strength),
        base: last.base
          ? { high: Math.max(last.base.high, z.base?.high ?? last.base.high), low: Math.min(last.base.low, z.base?.low ?? last.base.low) }
          : z.base,
        pattern: last.pattern,
      };
      out[out.length - 1] = merged;
    } else {
      out.push(z);
    }
  }
  return out;
}

/**
 * Main entry point: detect supply and demand zones for a candle series.
 */
export function detectSupplyDemandZones(
  candles: Candle[],
  options: Partial<DetectSndOptions> = {},
): SupplyDemandZone[] {
  const opts: DetectSndOptions = {
    ...DEFAULT_SND_OPTIONS,
    ...options,
    pattern: { ...DEFAULT_SND_OPTIONS.pattern, ...(options.pattern ?? {}) },
    strength: { ...DEFAULT_SND_OPTIONS.strength, ...(options.strength ?? {}) },
    status: { ...DEFAULT_SND_OPTIONS.status, ...(options.status ?? {}) },
  };

  if (candles.length < 4) return [];

  const cands = detectPatterns(candles, opts.pattern);

  // Score
  const zones: SupplyDemandZone[] = [];
  for (const c of cands) {
    const s = scoreCandidate(c, candles, opts.strength);
    if (!isFiniteNum(s)) continue;
    if (s < opts.minStrength) continue;
    zones.push(candidateToZone(c, s));
  }

  // Status
  const classified = zones.map((z) => {
    const status = classifyZone(z, candles, opts.status);
    return { ...z, status };
  });

  // Cluster nearby zones
  const clustered = clusterZones(classified, opts.clusterTolerancePct);

  // Re-score (strength is monotonic so cluster step doesn't need re-scoring)
  const rescored = clustered.map((z) => scoreZone(z, candles, opts.strength));

  // Sort by originTime ascending
  rescored.sort((a, b) => a.originTime - b.originTime);

  return rescored.slice(0, opts.maxZones);
}
