// Liquidation heatmap engine.
//
// Two data sources, both free, no API key required:
//
// 1. **Live** (preferred when reachable):
//    - WebSocket: wss://fstream.binance.com/ws/<symbol>@forceOrder
//      (Binance USDⓈ-M Futures public liquidation stream).
//    - REST: https://fapi.binance.com/fapi/v1/allForceOrders
//      (historical liquidations, last 7 days).
//
// 2. **Synthetic** (deterministic fallback derived from free public
//    market data: open interest, mark price, funding rate, long/short
//    ratio, taker buy/sell ratio, recent volatility):
//    We project the open interest across standard leverage buckets
//    (5x, 10x, 15x, 20x, 25x, 50x, 100x) around the mark price, using
//    the L/S ratio to skew longs vs shorts. The result is a
//    deterministic per-level estimate of clustered liquidations.
//
// The two sources are merged: live events update `recentEvents` and
// the per-level intensities for the most recent buckets; synthetic
// fills the rest of the price ladder.

import type {
  FuturesSnapshot,
  LiquidationEvent,
  LiquidationHeatmap,
  LiquidationLevel,
  LiquidationSide,
} from '@/types';
import { isFiniteNum } from '@/core/utils/series';

export interface HeatmapProviderOptions {
  symbol: string;
  /** Number of levels above/below the mark price to render. */
  rangePct?: number;
  /** Granularity of the price ladder (in percent of mark price). */
  stepPct?: number;
  /** Leverage buckets to consider when synthesising. */
  leverageBuckets?: number[];
  /** Cap on `recentEvents` to retain. */
  maxRecentEvents?: number;
}

const DEFAULT_OPTIONS: Required<HeatmapProviderOptions> = {
  symbol: '',
  rangePct: 8,
  stepPct: 0.1,
  leverageBuckets: [5, 10, 15, 20, 25, 50, 75, 100],
  maxRecentEvents: 100,
};

// Round a price to the nearest step (in percent of mark).
function priceLadder(mark: number, stepPct: number, rangePct: number): number[] {
  if (!isFiniteNum(mark) || mark <= 0 || !isFiniteNum(stepPct) || stepPct <= 0) return [];
  const step = (mark * stepPct) / 100;
  const range = (mark * rangePct) / 100;
  const out: number[] = [];
  // Start just above the lowest level so we never include mark itself.
  for (let p = mark - range; p <= mark + range; p += step) {
    if (p > 0) out.push(Number(p.toFixed(4)));
  }
  return out;
}

// Closest index in the ladder to a given price.
function nearestLadderIndex(levels: number[], price: number): number {
  if (levels.length === 0) return -1;
  let lo = 0;
  let hi = levels.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid]! < price) lo = mid + 1;
    else hi = mid;
  }
  // Pick whichever neighbour is closer.
  if (lo > 0 && Math.abs(levels[lo - 1]! - price) < Math.abs(levels[lo]! - price)) {
    return lo - 1;
  }
  return lo;
}

/**
 * Build a synthetic heatmap from a futures snapshot.
 * The algorithm:
 *   - Build a symmetric price ladder around the mark.
 *   - For each leverage bucket, compute the long liquidation price
 *     (mark * (1 - 1/leverage) using cross-margin initial) and the
 *     short liquidation price (mark * (1 + 1/leverage)). Assign the
 *     "weight" for that bucket (proportional to the inverse of
 *     leverage, with a small extra mass on the most common 10x/20x).
 *   - Skew longs vs shorts by the global L/S ratio: if L/S > 1 there
 *     are more longs, so we assign more weight to long liquidation
 *     clusters.
 *   - Distribute the per-bucket notional across the nearest ladder
 *     level. Aggregate by level.
 */
export function synthesizeHeatmap(
  snapshot: FuturesSnapshot,
  options: HeatmapProviderOptions,
): LiquidationHeatmap {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ladder = priceLadder(snapshot.markPrice, opts.stepPct, opts.rangePct);
  const levels: LiquidationLevel[] = ladder.map((price) => ({ price, longLiq: 0, shortLiq: 0 }));
  if (ladder.length === 0 || snapshot.openInterestUsd <= 0) {
    return {
      symbol: opts.symbol,
      generatedAt: Date.now(),
      source: 'synthetic',
      levels,
      totalLongLiq: 0,
      totalShortLiq: 0,
      recentEvents: [],
      meta: {
        markPrice: snapshot.markPrice,
        indexPrice: snapshot.indexPrice,
        openInterest: snapshot.openInterest,
        openInterestUsd: snapshot.openInterestUsd,
        fundingRate: snapshot.fundingRate,
        longShortRatio: snapshot.longShortRatio,
        takerBuySellRatio: snapshot.takerBuySellRatio,
      },
    };
  }

  // Total OI: split by the global L/S ratio. A ratio of 1.0 means
  // 50/50 longs and shorts; >1 means more longs. Use a saturating
  // logistic to prevent extreme skew.
  const ls = isFiniteNum(snapshot.longShortRatio) && snapshot.longShortRatio > 0
    ? snapshot.longShortRatio
    : 1;
  const longShare = ls / (1 + ls); // 0..1
  const shortShare = 1 - longShare;
  const longOi = snapshot.openInterestUsd * longShare;
  const shortOi = snapshot.openInterestUsd * shortShare;

  // Weight function: leverage buckets (5..100) get weights inversely
  // proportional to leverage (more retail on low leverage, but the
  // largest notional typically sits on 10-25x).
  const weights = opts.leverageBuckets.map((lev) => {
    // Boost 10/15/20x slightly.
    const boost = lev === 10 || lev === 15 || lev === 20 ? 1.5 : 1.0;
    return boost / lev;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let totalLong = 0;
  let totalShort = 0;
  for (let i = 0; i < opts.leverageBuckets.length; i++) {
    const lev = opts.leverageBuckets[i]!;
    const w = weights[i]! / totalWeight;
    // Long liquidation price (cross/isolated, no maintenance margin
    // adjustment — a conservative approximation that puts the cluster
    // exactly at the "100% loss" mark).
    const longPrice = snapshot.markPrice * (1 - 1 / lev);
    const shortPrice = snapshot.markPrice * (1 + 1 / lev);
    // Cluster the notional into the nearest ladder level.
    const longIdx = nearestLadderIndex(ladder, longPrice);
    const shortIdx = nearestLadderIndex(ladder, shortPrice);
    if (longIdx >= 0) {
      const add = longOi * w;
      levels[longIdx]!.longLiq += add;
      totalLong += add;
    }
    if (shortIdx >= 0) {
      const add = shortOi * w;
      levels[shortIdx]!.shortLiq += add;
      totalShort += add;
    }
  }

  // Taker buy/sell ratio tells us which side is currently hitting
  // the market more aggressively. Apply a small boost to the
  // relevant side at the nearest levels to reflect near-term
  // squeeze pressure. Caps ensure the total never exceeds OI.
  const tbs = isFiniteNum(snapshot.takerBuySellRatio) && snapshot.takerBuySellRatio > 0
    ? snapshot.takerBuySellRatio
    : 1;
  if (tbs > 1) {
    const boost = Math.min(0.1, (tbs - 1) * 0.05);
    const idx = nearestLadderIndex(ladder, snapshot.markPrice * 0.99);
    if (idx >= 0) {
      const add = snapshot.openInterestUsd * boost;
      levels[idx]!.longLiq += add;
      totalLong += add;
    }
  } else if (tbs < 1) {
    const boost = Math.min(0.1, (1 - tbs) * 0.05);
    const idx = nearestLadderIndex(ladder, snapshot.markPrice * 1.01);
    if (idx >= 0) {
      const add = snapshot.openInterestUsd * boost;
      levels[idx]!.shortLiq += add;
      totalShort += add;
    }
  }

  // Funding rate contributes a small directional bias: positive
  // funding means longs pay shorts, so short squeeze is more likely.
  if (isFiniteNum(snapshot.fundingRate)) {
    const sign = Math.sign(snapshot.fundingRate);
    const mag = Math.min(0.03, Math.abs(snapshot.fundingRate) * 30);
    if (sign > 0) totalShort += snapshot.openInterestUsd * mag;
    else if (sign < 0) totalLong += snapshot.openInterestUsd * mag;
  }

  // Hard cap: combined liquidation notional cannot exceed OI (each
  // contract is either long or short, never both). Scale the two
  // sides down proportionally if the cap is exceeded.
  if (totalLong + totalShort > snapshot.openInterestUsd) {
    const scale = snapshot.openInterestUsd / (totalLong + totalShort);
    totalLong *= scale;
    totalShort *= scale;
    // Re-distribute the scaled totals back into the levels.
    const origLong = levels.map((l) => l.longLiq);
    const origShort = levels.map((l) => l.shortLiq);
    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i]!;
      levels[i] = {
        price: lvl.price,
        longLiq: origLong[i]! * scale,
        shortLiq: origShort[i]! * scale,
      };
    }
  }

  return {
    symbol: opts.symbol,
    generatedAt: Date.now(),
    source: 'synthetic',
    levels,
    totalLongLiq: totalLong,
    totalShortLiq: totalShort,
    recentEvents: [],
    meta: {
      markPrice: snapshot.markPrice,
      indexPrice: snapshot.indexPrice,
      openInterest: snapshot.openInterest,
      openInterestUsd: snapshot.openInterestUsd,
      fundingRate: snapshot.fundingRate,
      longShortRatio: snapshot.longShortRatio,
      takerBuySellRatio: snapshot.takerBuySellRatio,
    },
  };
}

/**
 * Apply a live liquidation event to an existing heatmap by adding
 * the notional to the appropriate level. If the price is outside
 * the existing ladder, the call is a no-op (the level range can be
 * expanded by the caller as needed).
 */
export function applyLiquidationEvent(
  heatmap: LiquidationHeatmap,
  ev: LiquidationEvent,
): LiquidationHeatmap {
  const idx = nearestLadderIndex(
    heatmap.levels.map((l) => l.price),
    ev.price,
  );
  if (idx < 0) return heatmap;
  const level = heatmap.levels[idx]!;
  const next: LiquidationLevel = {
    price: level.price,
    longLiq: level.longLiq + (ev.side === 'long' ? ev.notional : 0),
    shortLiq: level.shortLiq + (ev.side === 'short' ? ev.notional : 0),
  };
  const recent = [ev, ...heatmap.recentEvents].slice(0, 200);
  const totalLong = heatmap.totalLongLiq + (ev.side === 'long' ? ev.notional : 0);
  const totalShort = heatmap.totalShortLiq + (ev.side === 'short' ? ev.notional : 0);
  const levels = heatmap.levels.slice();
  levels[idx] = next;
  return { ...heatmap, levels, recentEvents: recent, totalLongLiq: totalLong, totalShortLiq: totalShort, source: 'live' };
}

/**
 * Fetch a futures snapshot for a symbol from the public Binance
 * futures REST endpoints (all key-less). Falls back to null on any
 * failure (the caller is expected to fall back to a synthetic
 * snapshot if needed).
 *
 * Uses the /api/futures proxy when available to bypass CORS in
 * the browser; the proxy forwards to fapi.binance.com.
 */
export async function fetchFuturesSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FuturesSnapshot | null> {
  const useProxy = typeof window !== 'undefined';
  const base = useProxy ? '/api/futures' : 'https://fapi.binance.com';

  const safeNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  try {
    const [mark, oiHist, ls, tbs] = await Promise.all([
      fetchImpl(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`, { cache: 'no-store' }).then(
        (r) => (r.ok ? r.json() : null),
      ).catch(() => null),
      fetchImpl(`${base}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=1`, { cache: 'no-store' }).then(
        (r) => (r.ok ? r.json() : null),
      ).catch(() => null),
      fetchImpl(`${base}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`, { cache: 'no-store' }).then(
        (r) => (r.ok ? r.json() : null),
      ).catch(() => null),
      fetchImpl(`${base}/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=1`, { cache: 'no-store' }).then(
        (r) => (r.ok ? r.json() : null),
      ).catch(() => null),
    ]);

    if (!mark || !oiHist) return null;
    const markPrice = safeNum((mark as { markPrice?: number }).markPrice);
    const indexPrice = safeNum((mark as { indexPrice?: number }).indexPrice);
    const fundingRate = safeNum((mark as { lastFundingRate?: number }).lastFundingRate);
    const nextFundingTime = safeNum((mark as { nextFundingTime?: number }).nextFundingTime);
    const oiRow = Array.isArray(oiHist) ? (oiHist as Array<{ sumOpenInterest: string; sumOpenInterestValue: string }>)[0] : null;
    const openInterest = safeNum(oiRow?.sumOpenInterest);
    const openInterestUsd = safeNum(oiRow?.sumOpenInterestValue);
    const longShortRatio = safeNum(Array.isArray(ls) ? (ls as Array<{ longShortRatio: string }>)[0]?.longShortRatio : 0);
    const takerBuySellRatio = safeNum(
      Array.isArray(tbs) ? (tbs as Array<{ buySellRatio: string }>)[0]?.buySellRatio : 0,
    );
    if (!isFiniteNum(markPrice) || markPrice <= 0) return null;
    return {
      symbol,
      markPrice,
      indexPrice: isFiniteNum(indexPrice) && indexPrice > 0 ? indexPrice : markPrice,
      fundingRate,
      nextFundingTime,
      openInterest,
      openInterestUsd,
      longShortRatio: longShortRatio > 0 ? longShortRatio : 1,
      takerBuySellRatio: takerBuySellRatio > 0 ? takerBuySellRatio : 1,
      ts: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch historical force orders for the last `hours` window. Returns
 * an array of normalised events sorted descending by time. Returns
 * an empty array on any failure.
 */
export async function fetchRecentForceOrders(
  symbol: string,
  hours = 24,
  fetchImpl: typeof fetch = fetch,
): Promise<LiquidationEvent[]> {
  const useProxy = typeof window !== 'undefined';
  const base = useProxy ? '/api/futures' : 'https://fapi.binance.com';
  const startTime = Date.now() - hours * 3600 * 1000;
  const safeNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  try {
    const url = `${base}/fapi/v1/allForceOrders?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      symbol: string;
      side: string;
      time: number;
      price: string;
      executedQty: string;
      avgPrice?: string;
    }>;
    if (!Array.isArray(data)) return [];
    return data.map((row) => {
      const price = safeNum(row.avgPrice ?? row.price);
      const qty = safeNum(row.executedQty);
      // Binance convention: SELL = long liquidation (force-closed long),
      // BUY = short liquidation (force-closed short).
      const side: LiquidationSide = row.side === 'SELL' ? 'long' : 'short';
      return {
        time: row.time,
        symbol: row.symbol,
        side,
        price,
        quantity: qty,
        notional: price * qty,
      };
    });
  } catch {
    return [];
  }
}

export function buildHeatmapFromEvents(
  events: LiquidationEvent[],
  symbol: string,
  options: HeatmapProviderOptions,
): LiquidationHeatmap {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ladder = priceLadder(
    events[0]?.price ?? 0,
    opts.stepPct,
    opts.rangePct,
  );
  const levels: LiquidationLevel[] = ladder.map((price) => ({ price, longLiq: 0, shortLiq: 0 }));
  let totalLong = 0;
  let totalShort = 0;
  for (const ev of events) {
    const idx = nearestLadderIndex(ladder, ev.price);
    if (idx < 0) continue;
    if (ev.side === 'long') {
      levels[idx]!.longLiq += ev.notional;
      totalLong += ev.notional;
    } else {
      levels[idx]!.shortLiq += ev.notional;
      totalShort += ev.notional;
    }
  }
  return {
    symbol,
    generatedAt: Date.now(),
    source: 'live',
    levels,
    totalLongLiq: totalLong,
    totalShortLiq: totalShort,
    recentEvents: events,
    meta: {},
  };
}
