// Cluster nearby price levels into single representative levels.
//
// The clustering rule is symmetric: two levels whose prices are within
// `tolerancePct` (as a percentage of the larger price, default 0.5%)
// are merged into a single level. The merge produces:
//
//   price   = volume-weighted average of the input prices (or arithmetic
//             mean when no touch counts are available)
//   touches = sum of all touch counts
//   strength = max of all input strengths (caller can re-normalize)
//
// The output preserves insertion order so the cluster IDs remain
// stable across calls when the input is identical.

import type { SupportResistanceLevel } from '@/types';
import { isFiniteNum, safeNum } from '@/core/utils/series';

export interface ClusterInput {
  price: number;
  touches: number;
  strength: number;
  kind: SupportResistanceLevel['kind'];
  type: SupportResistanceLevel['type'];
  /** Optional zone for area-based levels (e.g. supply / demand). */
  zone?: { high: number; low: number };
}

export interface ClusterOptions {
  /** Percentage tolerance (e.g. 0.5 = 0.5%). */
  tolerancePct: number;
  /**
   * If true, weighting uses `touches` as the volume proxy. If false, all
   * levels are weighted equally. Default true.
   */
  volumeWeighted: boolean;
  /** Maximum number of clusters to emit. Default 1000. */
  maxClusters: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  tolerancePct: 0.5,
  volumeWeighted: true,
  maxClusters: 1000,
};

interface Internal extends ClusterInput {
  id: string;
  totalWeight: number;
}

let _clusterSeq = 0;
function nextClusterId(): string {
  _clusterSeq += 1;
  return `cl-${_clusterSeq}`;
}

/**
 * Cluster an array of price levels by proximity.
 *
 * Pure function. The function is deterministic for a given input order
 * and the global counter is reset on each call to `resetClusterCounter`
 * (mostly useful for tests).
 */
export function clusterLevels(
  inputs: ClusterInput[],
  options: Partial<ClusterOptions> = {},
): SupportResistanceLevel[] {
  const tolerance = options.tolerancePct ?? DEFAULT_CLUSTER_OPTIONS.tolerancePct;
  const volumeWeighted =
    options.volumeWeighted ?? DEFAULT_CLUSTER_OPTIONS.volumeWeighted;
  const maxClusters = options.maxClusters ?? DEFAULT_CLUSTER_OPTIONS.maxClusters;

  // Filter invalid entries first
  const valid: Internal[] = [];
  for (const inp of inputs) {
    if (!isFiniteNum(inp.price)) continue;
    const touches = isFiniteNum(inp.touches) ? Math.max(0, inp.touches) : 1;
    const strength = isFiniteNum(inp.strength) ? inp.strength : 0;
    valid.push({
      id: nextClusterId(),
      price: inp.price,
      touches,
      strength,
      kind: inp.kind,
      type: inp.type,
      zone: inp.zone,
      totalWeight: 0,
    });
  }

  // Group by type (support and resistance are clustered separately
  // because their price levels can overlap without conflict -- a price
  // can be both the top of a range and the bottom of the next).
  const supports: Internal[] = valid.filter((v) => v.type === 'support');
  const resistances: Internal[] = valid.filter((v) => v.type === 'resistance');

  const clusters: SupportResistanceLevel[] = [];
  for (const group of [supports, resistances] as Internal[][]) {
    if (group.length === 0) continue;
    clusterGroup(group, clusters, tolerance, volumeWeighted);
    if (clusters.length >= maxClusters) break;
  }
  return clusters.slice(0, maxClusters);
}

function clusterGroup(
  group: Internal[],
  out: SupportResistanceLevel[],
  tolerancePct: number,
  volumeWeighted: boolean,
): void {
  // Sort ascending by price so neighbouring levels are adjacent.
  group.sort((a, b) => a.price - b.price);

  let cur: Internal | null = null;
  let curSumWeighted = 0;
  let curSumWeights = 0;
  let curZoneHighSum = 0;
  let curZoneLowSum = 0;
  let curZoneWeight = 0;

  function flush(): void {
    if (!cur) return;
    const meanPrice =
      curSumWeights > 0
        ? curSumWeighted / curSumWeights
        : cur.price;
    const zone =
      curZoneWeight > 0
        ? {
            high: curZoneHighSum / curZoneWeight,
            low: curZoneLowSum / curZoneWeight,
          }
        : undefined;
    out.push({
      id: cur.id,
      price: meanPrice,
      type: cur.type,
      strength: cur.strength,
      touches: cur.touches,
      kind: cur.kind,
      zone,
    });
  }

  for (const item of group) {
    if (!cur) {
      cur = { ...item };
      curSumWeighted = item.price * (volumeWeighted ? Math.max(1, item.touches) : 1);
      curSumWeights = volumeWeighted ? Math.max(1, item.touches) : 1;
      if (item.zone && isFiniteNum(item.zone.high) && isFiniteNum(item.zone.low)) {
        const w = volumeWeighted ? Math.max(1, item.touches) : 1;
        curZoneHighSum = item.zone.high * w;
        curZoneLowSum = item.zone.low * w;
        curZoneWeight = w;
      } else {
        curZoneHighSum = 0;
        curZoneLowSum = 0;
        curZoneWeight = 0;
      }
      continue;
    }
    const ref = Math.max(Math.abs(cur.price), Math.abs(item.price), 1);
    const tol = ref * (tolerancePct / 100);
    if (Math.abs(item.price - cur.price) <= tol) {
      // Merge
      const w = volumeWeighted ? Math.max(1, item.touches) : 1;
      curSumWeighted += item.price * w;
      curSumWeights += w;
      cur.touches += item.touches;
      cur.strength = Math.max(cur.strength, item.strength);
      // Prefer the more specific (less generic) kind label
      if (cur.kind === 'minor' && item.kind !== 'minor') cur.kind = item.kind;
      if (item.zone && isFiniteNum(item.zone.high) && isFiniteNum(item.zone.low)) {
        curZoneHighSum += item.zone.high * w;
        curZoneLowSum += item.zone.low * w;
        curZoneWeight += w;
      }
    } else {
      flush();
      cur = { ...item };
      curSumWeighted = item.price * (volumeWeighted ? Math.max(1, item.touches) : 1);
      curSumWeights = volumeWeighted ? Math.max(1, item.touches) : 1;
      if (item.zone && isFiniteNum(item.zone.high) && isFiniteNum(item.zone.low)) {
        const w = volumeWeighted ? Math.max(1, item.touches) : 1;
        curZoneHighSum = item.zone.high * w;
        curZoneLowSum = item.zone.low * w;
        curZoneWeight = w;
      } else {
        curZoneHighSum = 0;
        curZoneLowSum = 0;
        curZoneWeight = 0;
      }
    }
  }
  flush();
}

/** Reset the internal cluster counter (used by tests for determinism). */
export function resetClusterCounter(): void {
  _clusterSeq = 0;
}

/** Helper: filter out non-finite levels with a sensible fallback. */
export function sanitizeLevels(arr: SupportResistanceLevel[]): SupportResistanceLevel[] {
  return arr.filter(
    (l) =>
      isFiniteNum(l.price) &&
      isFiniteNum(l.strength) &&
      isFiniteNum(l.touches) &&
      safeNum(l.touches) >= 0,
  );
}
