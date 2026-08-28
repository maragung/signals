// Bitget USDT-FUTURES provider.
//
// Bitget's mix market REST API lives on
// `https://api.bitget.com/api/v2/mix/market/`. All endpoints used
// here are free and key-less. Note: Bitget wraps all responses in
// `{ code, msg, data: ... }`, where `code === "00000"` means OK.
//
// Endpoints:
//   - ticker?productType=USDT-FUTURES&symbol=BTCUSDT
//     -> lastPr, markPr, fundingRate, etc.
//   - open-interest?productType=USDT-FUTURES&symbol=BTCUSDT
//   - account?productType=USDT-FUTURES&symbol=BTCUSDT&period=5m
//     -> long/short account ratio
//   - taker-buy-sell?productType=USDT-FUTURES&symbol=BTCUSDT&period=5m
//     -> taker buy/sell ratio
//
// Symbol format: "BTCUSDT" -> "BTCUSDT" (no change).

import type { FuturesSnapshot } from '@/types';
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

export const bitgetMeta: ProviderMeta = {
  id: 'bitget',
  display: 'Bitget',
  symbolFormat: (s) => s,
};

interface BitgetEnvelope {
  code: string;
  msg?: string;
  data?: unknown;
}

function asOk(json: unknown): unknown {
  if (!json || typeof json !== 'object') return null;
  const env = json as BitgetEnvelope;
  if (env.code !== '00000') return null;
  return env.data ?? null;
}

interface BitgetTicker {
  symbol: string;
  lastPr: string;
  markPr: string;
  indexPr?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  holdVol?: string;
  quoteVolume?: string;
  baseVolume?: string;
}

function asTicker(json: unknown): BitgetTicker | null {
  const data = asOk(json);
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0] as BitgetTicker | undefined;
    if (!first || typeof first.lastPr !== 'string') return null;
    return first;
  }
  const row = data as BitgetTicker;
  if (typeof row.lastPr !== 'string') return null;
  return row;
}

interface BitgetOpenInterest {
  symbol: string;
  holdVol: string; // base ccy
}

function asOI(json: unknown): BitgetOpenInterest | null {
  const data = asOk(json);
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0] as BitgetOpenInterest | undefined;
    if (!first || typeof first.holdVol !== 'string') return null;
    return first;
  }
  const row = data as BitgetOpenInterest;
  if (typeof row.holdVol !== 'string') return null;
  return row;
}

interface BitgetAccount {
  longAccountRatio: string;
  shortAccountRatio: string;
}

function asAccount(json: unknown): BitgetAccount | null {
  const data = asOk(json);
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0] as BitgetAccount | undefined;
    if (!first || typeof first.longAccountRatio !== 'string') return null;
    return first;
  }
  const row = data as BitgetAccount;
  if (typeof row.longAccountRatio !== 'string') return null;
  return row;
}

interface BitgetTakerBuySell {
  buyRatio: string;
  sellRatio: string;
}

function asTakerBuySell(json: unknown): BitgetTakerBuySell | null {
  const data = asOk(json);
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0] as BitgetTakerBuySell | undefined;
    if (!first || typeof first.buyRatio !== 'string') return null;
    return first;
  }
  const row = data as BitgetTakerBuySell;
  if (typeof row.buyRatio !== 'string') return null;
  return row;
}

export async function fetchBitgetSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ snapshot: FuturesSnapshot | null; blocked: boolean; degraded: boolean; error?: string }> {
  const prefix = 'bitget';
  const sym = bitgetMeta.symbolFormat(symbol);
  const qs = `productType=USDT-FUTURES&symbol=${sym}`;
  try {
    const [ticker, oi, account, tbs] = await Promise.all([
      safeFetch(proxyUrl(prefix, 'ticker', `?${qs}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'open-interest', `?${qs}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'account', `?${qs}&period=5m`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'taker-buy-sell', `?${qs}&period=5m`), fetchImpl),
    ]);

    if (anyBlocked([ticker, oi, account, tbs])) {
      return { snapshot: null, blocked: true, degraded: false };
    }
    if (!ticker.ok || !oi.ok) {
      return {
        snapshot: null,
        blocked: false,
        degraded: true,
        error: ticker.status === 0 || oi.status === 0 ? 'network' : `status_${ticker.status}_${oi.status}`,
      };
    }

    const tickerJson = (await ticker.json()) as unknown;
    const oiJson = (await oi.json()) as unknown;
    const accountJson = account.ok ? ((await account.json()) as unknown) : null;
    const tbsJson = tbs.ok ? ((await tbs.json()) as unknown) : null;

    const t = asTicker(tickerJson);
    const o = asOI(oiJson);
    if (!t || !o) {
      return { snapshot: null, blocked: false, degraded: true, error: 'parse_error' };
    }

    // Bitget returns markPr in the ticker and OI in base ccy in the
    // open-interest endpoint. We prefer the mark price from the
    // ticker; the OI USD notional is `holdVol * markPr`.
    const markPrice = safePositive(t.markPr) || safePositive(t.lastPr);
    const lastPrice = safePositive(t.lastPr);
    const fundingRate = safeNum(t.fundingRate);
    const nextFundingTime = safeNum(t.nextFundingTime);
    const openInterest = safeNum(o.holdVol);
    const openInterestUsd = openInterest * markPrice;

    let longShortRatio = 1;
    if (accountJson) {
      const a = asAccount(accountJson);
      if (a) {
        const longA = safeNum(a.longAccountRatio);
        const shortA = safeNum(a.shortAccountRatio);
        // Bitget publishes both halves; the ratio is long/short.
        if (longA > 0 && shortA > 0) {
          longShortRatio = longA / shortA;
        } else if (longA > 0) {
          longShortRatio = longA;
        }
      }
    }
    let takerBuySellRatio = 1;
    if (tbsJson) {
      const tb = asTakerBuySell(tbsJson);
      if (tb) {
        const buy = safeNum(tb.buyRatio);
        const sell = safeNum(tb.sellRatio);
        if (buy > 0 && sell > 0) {
          takerBuySellRatio = buy / sell;
        } else if (buy > 0) {
          takerBuySellRatio = buy;
        }
      }
    }
    const degraded = !account.ok || !tbs.ok;

    if (!isFiniteNum(markPrice) || markPrice <= 0) {
      return { snapshot: null, blocked: false, degraded: true, error: 'bad_mark' };
    }
    return {
      snapshot: {
        symbol,
        markPrice,
        indexPrice: safePositive(t.indexPr) || lastPrice || markPrice,
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

export async function fetchBitgetProvider(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const snap = await fetchBitgetSnapshot(symbol, fetchImpl);
  if (snap.blocked) return emptyResult(bitgetMeta.id, 'region_blocked', true);
  if (!snap.snapshot) {
    return emptyResult(bitgetMeta.id, snap.error ?? 'no_snapshot', false, true);
  }
  return {
    provider: bitgetMeta.id,
    snapshot: snap.snapshot,
    events: [],
    blocked: false,
    degraded: snap.degraded,
  };
}

export { isRegionBlockedStatus };
