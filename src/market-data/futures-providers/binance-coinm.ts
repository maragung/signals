// Binance COIN-M (delivery) futures provider.
//
// The COIN-M ("inverse") futures on Binance are served from
// `dapi.binance.com` instead of `fapi.binance.com`. They are margined
// and settled in the base currency (e.g. BTC for BTCUSD_PERP), and
// only BTC and ETH are available on the COIN-M perpetual market.
//
// We expose this as a last-resort fallback for the two symbols the
// app supports on inverse perps: BTCUSDT (mapped to BTCUSD_PERP) and
// ETHUSDT (mapped to ETHUSD_PERP). For every other symbol the
// `symbolFormat` returns the input unchanged, which the caller
// (`fetchFuturesWithFallback`) can use to detect that the provider
// doesn't actually support the symbol and skip it.
//
// All endpoints are public and key-less:
//   - /dapi/v1/premiumIndex?symbol=BTCUSD_PERP     -> mark price
//   - /dapi/v1/openInterest?symbol=BTCUSD_PERP     -> OI in base
//   - /dapi/v1/fundingRate?symbol=BTCUSD_PERP      -> current funding
//   - /dapi/v1/allForceOrders?symbol=BTCUSD_PERP   -> liquidations

import type { FuturesSnapshot, LiquidationEvent, LiquidationSide } from '@/types';
import { isFiniteNum } from '@/core/utils/series';
import {
  isRegionBlockedStatus,
  proxyUrl,
  safeFetch,
  safeNum,
  safePositive,
  anyBlocked,
  emptyResult,
} from './base';
import type { ProviderMeta, ProviderResult } from './types';

export const binanceCoinMMeta: ProviderMeta = {
  id: 'binance-coinm',
  display: 'Binance COIN-M',
  // Only BTCUSD_PERP and ETHUSD_PERP are available on COIN-M perps.
  // The fallback chain checks `onlyFor` separately; returning the
  // input as-is for unknown symbols is safe (the upstream will return
  // an error and we'll move on).
  symbolFormat: (s) => {
    if (s === 'BTCUSDT') return 'BTCUSD_PERP';
    if (s === 'ETHUSDT') return 'ETHUSD_PERP';
    return s;
  },
};

/**
 * Set of canonical symbols this provider actually supports. Used by
 * the fallback chain to skip the provider entirely when the symbol
 * isn't on COIN-M.
 */
export const COINM_SUPPORTED: ReadonlySet<string> = new Set(['BTCUSDT', 'ETHUSDT']);

/**
 * Fetch a futures snapshot for `symbol` from Binance COIN-M. The
 * input is a canonical USDⓈ-M symbol like "BTCUSDT"; the provider
 * translates it internally to the COIN-M equivalent.
 */
export async function fetchBinanceCoinMSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ snapshot: FuturesSnapshot | null; blocked: boolean; degraded: boolean; error?: string }> {
  const internal = binanceCoinMMeta.symbolFormat(symbol);
  if (internal === symbol && !COINM_SUPPORTED.has(symbol)) {
    // No mapping -> don't even try.
    return { snapshot: null, blocked: false, degraded: false, error: 'unsupported_symbol' };
  }

  const prefix = 'binance-coinm';
  try {
    const [mark, oi, funding, ls, tbs] = await Promise.all([
      safeFetch(proxyUrl(prefix, 'premiumIndex', `?symbol=${internal}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'openInterest', `?symbol=${internal}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'fundingRate', `?symbol=${internal}&limit=1`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'globalLongShortAccountRatio', `?symbol=${internal}&period=5m&limit=1`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'takerlongshortRatio', `?symbol=${internal}&period=5m&limit=1`), fetchImpl),
    ]);

    if (anyBlocked([mark, oi, funding, ls, tbs])) {
      return { snapshot: null, blocked: true, degraded: false };
    }
    if (!mark.ok || !oi.ok) {
      return {
        snapshot: null,
        blocked: false,
        degraded: true,
        error: mark.status === 0 || oi.status === 0 ? 'network' : `status_${mark.status}_${oi.status}`,
      };
    }

    const markJson = (await mark.json()) as
      | {
          markPrice?: string | number;
          indexPrice?: string | number;
          nextFundingTime?: number;
        }
      | null;
    const oiJson = (await oi.json()) as
      | Array<{ symbol: string; sumOpenInterest: string; sumOpenInterestValue?: string }>
      | { symbol: string; sumOpenInterest: string; sumOpenInterestValue?: string }
      | null;

    if (!markJson) {
      return { snapshot: null, blocked: false, degraded: true, error: 'parse_error' };
    }

    // COIN-M openInterest is in base (e.g. BTC). The endpoint also
    // returns `sumOpenInterestValue` (USD) when available; fall back
    // to multiplying by mark price if not.
    const markPrice = safePositive(markJson.markPrice);
    const indexPrice = safeNum(markJson.indexPrice);
    const nextFundingTime = safeNum(markJson.nextFundingTime);

    let openInterest = 0;
    let openInterestUsd = 0;
    if (oiJson) {
      const oiRow = Array.isArray(oiJson) ? oiJson[0] : oiJson;
      if (oiRow) {
        openInterest = safeNum(oiRow.sumOpenInterest);
        const usdVal = safeNum(oiRow.sumOpenInterestValue);
        if (usdVal > 0) {
          openInterestUsd = usdVal;
        } else if (openInterest > 0 && markPrice > 0) {
          // COIN-M OI in BTC * mark price (in USD) = USD notional.
          openInterestUsd = openInterest * markPrice;
        }
      }
    }

    let fundingRate = 0;
    if (funding.ok) {
      const fJson = (await funding.json()) as
        | Array<{ symbol: string; fundingRate: string; fundingTime: number }>
        | null;
      if (Array.isArray(fJson) && fJson[0]) {
        fundingRate = safeNum(fJson[0].fundingRate);
      }
    }

    let longShortRatio = 1;
    if (ls.ok) {
      const lsJson = (await ls.json()) as Array<{ longShortRatio: string }> | null;
      if (Array.isArray(lsJson) && lsJson[0]) {
        const v = safeNum(lsJson[0].longShortRatio);
        if (v > 0) longShortRatio = v;
      }
    }

    let takerBuySellRatio = 1;
    let degraded = false;
    if (tbs.ok) {
      const tbsJson = (await tbs.json()) as Array<{ buySellRatio: string }> | null;
      if (Array.isArray(tbsJson) && tbsJson[0]) {
        const v = safeNum(tbsJson[0].buySellRatio);
        if (v > 0) takerBuySellRatio = v;
      }
    } else {
      degraded = true;
    }
    // Missing optional endpoints -> degraded.
    if (!funding.ok || !ls.ok) degraded = true;

    if (!isFiniteNum(markPrice) || markPrice <= 0) {
      return { snapshot: null, blocked: false, degraded: true, error: 'bad_mark' };
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
      blocked: false,
      degraded,
    };
  } catch (err) {
    return { snapshot: null, blocked: false, degraded: true, error: String(err) };
  }
}

/**
 * Fetch historical force orders from Binance COIN-M.
 */
export async function fetchBinanceCoinMForceOrders(
  symbol: string,
  hours = 24,
  fetchImpl: typeof fetch = fetch,
): Promise<{ events: LiquidationEvent[]; blocked: boolean }> {
  const internal = binanceCoinMMeta.symbolFormat(symbol);
  if (internal === symbol && !COINM_SUPPORTED.has(symbol)) {
    return { events: [], blocked: false };
  }
  const startTime = Date.now() - hours * 3600 * 1000;
  const url = proxyUrl(
    'binance-coinm',
    'allForceOrders',
    `?symbol=${internal}&startTime=${startTime}&limit=1000`,
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
      // COIN-M uses the same convention as USDⓈ-M.
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

export async function fetchBinanceCoinMProvider(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const [snap, ev] = await Promise.all([
    fetchBinanceCoinMSnapshot(symbol, fetchImpl),
    fetchBinanceCoinMForceOrders(symbol, 24, fetchImpl).catch(
      () => ({ events: [] as LiquidationEvent[], blocked: false }),
    ),
  ]);
  if (snap.blocked) return emptyResult(binanceCoinMMeta.id, 'region_blocked', true);
  if (!snap.snapshot) {
    return emptyResult(binanceCoinMMeta.id, snap.error ?? 'no_snapshot', false, true);
  }
  return {
    provider: binanceCoinMMeta.id,
    snapshot: snap.snapshot,
    events: ev.events,
    blocked: false,
    degraded: snap.degraded || ev.blocked,
  };
}
