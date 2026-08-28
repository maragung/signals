// Binance USDⓈ-M Futures provider.
//
// This is the original / primary provider: the public fapi.binance.com
// REST endpoints (no API key required). In the browser we fetch
// through the existing `/api/futures/[...path]` Next.js proxy, which
// forwards to fapi.binance.com.
//
// All endpoints are free and public:
//   - /fapi/v1/premiumIndex              -> mark price + funding rate
//   - /fapi/v1/allForceOrders            -> recent liquidations
//   - /futures/data/openInterestHist     -> OI in contracts + USD
//   - /futures/data/globalLongShortAccountRatio
//   - /futures/data/takerlongshortRatio
//
// Symbol format: the canonical "BTCUSDT" string is passed verbatim.

import type { FuturesSnapshot, LiquidationEvent, LiquidationSide } from '@/types';
import { isFiniteNum, safeNum as safeNumCore } from '@/core/utils/series';
import {
  isRegionBlockedStatus,
  proxyUrl,
  safeFetch,
  safeNum,
  safePositive,
  anyBlocked,
  emptyResult,
} from './base';
import type { ProviderMeta, ProviderResult, UpstreamResponse } from './types';

export const binanceMeta: ProviderMeta = {
  id: 'binance',
  display: 'Binance USDⓈ-M',
  symbolFormat: (s) => s,
};

/**
 * Fetch a futures snapshot for `symbol` from Binance USDⓈ-M. Returns
 * `{ snapshot, blocked }` so the caller can decide whether to fall
 * through to the next provider. This is the same function that
 * previously lived in `liquidation-heatmap.ts`, just moved here
 * verbatim so the new fallback chain can call it.
 */
export async function fetchBinanceSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ snapshot: FuturesSnapshot | null; blocked: boolean; events: LiquidationEvent[]; degraded: boolean; error?: string }> {
  const proxy = 'futures';
  try {
    const [mark, oiHist, ls, tbs] = await Promise.all([
      safeFetch(
        proxyUrl(proxy, 'fapi/v1/premiumIndex', `?symbol=${symbol}`),
        fetchImpl,
      ),
      safeFetch(
        proxyUrl(proxy, 'futures/data/openInterestHist', `?symbol=${symbol}&period=5m&limit=1`),
        fetchImpl,
      ),
      safeFetch(
        proxyUrl(proxy, 'futures/data/globalLongShortAccountRatio', `?symbol=${symbol}&period=5m&limit=1`),
        fetchImpl,
      ),
      safeFetch(
        proxyUrl(proxy, 'futures/data/takerlongshortRatio', `?symbol=${symbol}&period=5m&limit=1`),
        fetchImpl,
      ),
    ]);

    const responses: UpstreamResponse[] = [mark, oiHist, ls, tbs];
    if (anyBlocked(responses)) {
      return { snapshot: null, events: [], blocked: true, degraded: false };
    }
    if (!mark.ok || !oiHist.ok) {
      return {
        snapshot: null,
        events: [],
        blocked: false,
        degraded: true,
        error: mark.status === 0 || oiHist.status === 0 ? 'network' : `status_${mark.status}_${oiHist.status}`,
      };
    }

    const markJson = (await mark.json()) as
      | {
          markPrice?: string | number;
          indexPrice?: string | number;
          lastFundingRate?: string | number;
          nextFundingTime?: number;
        }
      | null;
    const oiJson = (await oiHist.json()) as
      | Array<{ sumOpenInterest: string; sumOpenInterestValue: string }>
      | null;

    if (!markJson || !oiJson) {
      return { snapshot: null, events: [], blocked: false, degraded: true, error: 'parse_error' };
    }

    const markPrice = safePositive(markJson.markPrice);
    const indexPrice = safeNum(markJson.indexPrice);
    const fundingRate = safeNum(markJson.lastFundingRate);
    const nextFundingTime = safeNum(markJson.nextFundingTime);
    const oiRow = Array.isArray(oiJson) ? oiJson[0] : null;
    const openInterest = safeNum(oiRow?.sumOpenInterest);
    const openInterestUsd = safeNum(oiRow?.sumOpenInterestValue);

    let longShortRatio = 1;
    let takerBuySellRatio = 1;
    let degraded = false;
    if (ls.ok) {
      const lsJson = (await ls.json()) as Array<{ longShortRatio: string }> | null;
      if (Array.isArray(lsJson)) {
        const v = safeNum(lsJson[0]?.longShortRatio);
        if (v > 0) longShortRatio = v;
      } else {
        degraded = true;
      }
    } else {
      degraded = true;
    }
    if (tbs.ok) {
      const tbsJson = (await tbs.json()) as Array<{ buySellRatio: string }> | null;
      if (Array.isArray(tbsJson)) {
        const v = safeNum(tbsJson[0]?.buySellRatio);
        if (v > 0) takerBuySellRatio = v;
      } else {
        degraded = true;
      }
    } else {
      degraded = true;
    }

    if (!isFiniteNum(markPrice) || markPrice <= 0) {
      return { snapshot: null, events: [], blocked: false, degraded: true, error: 'bad_mark' };
    }
    return {
      snapshot: {
        symbol,
        markPrice,
        indexPrice: isFiniteNum(indexPrice) && indexPrice > 0 ? indexPrice : markPrice,
        fundingRate,
        nextFundingTime,
        openInterest,
        openInterestUsd,
        longShortRatio,
        takerBuySellRatio,
        ts: Date.now(),
      },
      events: [],
      blocked: false,
      degraded,
    };
  } catch (err) {
    return { snapshot: null, events: [], blocked: false, degraded: true, error: String(err) };
  }
}

/**
 * Fetch historical force orders for the last `hours` window from
 * Binance USDⓈ-M. The caller can use this to populate the live
 * `recentEvents` list of the heatmap.
 */
export async function fetchBinanceForceOrders(
  symbol: string,
  hours = 24,
  fetchImpl: typeof fetch = fetch,
): Promise<{ events: LiquidationEvent[]; blocked: boolean }> {
  const startTime = Date.now() - hours * 3600 * 1000;
  const url = proxyUrl(
    'futures',
    'fapi/v1/allForceOrders',
    `?symbol=${symbol}&startTime=${startTime}&limit=1000`,
  );
  try {
    const res = await safeFetch(url, fetchImpl);
    if (isRegionBlockedStatus(res.status)) return { events: [], blocked: true };
    if (!res.ok) return { events: [], blocked: false };
    const data = (await res.json()) as
      | Array<{
          symbol: string;
          side: string;
          time: number;
          price: string;
          executedQty: string;
          avgPrice?: string;
        }>
      | null;
    if (!Array.isArray(data)) return { events: [], blocked: false };
    const events: LiquidationEvent[] = data.map((row) => {
      const price = safeNum(row.avgPrice ?? row.price);
      const qty = safeNum(row.executedQty);
      // Binance: SELL = long liquidation, BUY = short liquidation.
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
    return { events, blocked: false };
  } catch {
    return { events: [], blocked: false };
  }
}

/**
 * Top-level entry point used by the fallback chain. Combines the
 * snapshot and force-order fetches into a single `ProviderResult`.
 */
export async function fetchBinanceProvider(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const [snap, ev] = await Promise.all([
    fetchBinanceSnapshot(symbol, fetchImpl),
    fetchBinanceForceOrders(symbol, 24, fetchImpl).catch(
      () => ({ events: [] as LiquidationEvent[], blocked: false }),
    ),
  ]);
  if (snap.blocked) {
    return emptyResult(binanceMeta.id, 'region_blocked', true);
  }
  if (!snap.snapshot) {
    return emptyResult(binanceMeta.id, snap.error ?? 'no_snapshot', false, true);
  }
  return {
    provider: binanceMeta.id,
    snapshot: snap.snapshot,
    events: ev.events,
    blocked: false,
    degraded: snap.degraded || ev.blocked,
  };
}

// Re-export safeNum so consumers of this module can use it.
export { safeNumCore as safeNum };
