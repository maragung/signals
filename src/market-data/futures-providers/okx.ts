// OKX swap (USDT-margined perpetual futures) provider.
//
// OKX is the primary fallback after Binance USDⓈ-M because it is
// reachable in most jurisdictions and its public REST API requires
// no API key.
//
// Endpoints (all under `https://www.okx.com/api/v5/`):
//   - market/ticker?instId=BTC-USDT-SWAP     -> last price, 24h vol
//   - market/open-interest?instId=BTC-USDT-SWAP
//   - public/funding-rate?instId=BTC-USDT-SWAP
//   - rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=5m
//
// Symbol format: "BTCUSDT" -> "BTC-USDT-SWAP". The base currency is
// split off by stripping the trailing "USDT" / "USDC" suffix.
//
// Note: OKX does NOT expose a public liquidation feed via REST or
// WebSocket for the free tier. We return an empty `events` array and
// the heatmap will fall back to its deterministic synthetic mode.

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
import type { ProviderMeta, ProviderResult, UpstreamResponse } from './types';

export const okxMeta: ProviderMeta = {
  id: 'okx',
  display: 'OKX',
  /**
   * Convert "BTCUSDT" -> "BTC-USDT-SWAP". For the small set of
   * quote currencies we support, this is a simple prefix split.
   */
  symbolFormat: (s) => {
    const upper = s.toUpperCase();
    for (const quote of ['USDT', 'USDC', 'USD']) {
      if (upper.endsWith(quote) && upper.length > quote.length) {
        const base = upper.slice(0, upper.length - quote.length);
        return `${base}-${quote}-SWAP`;
      }
    }
    return s;
  },
};

/**
 * Parse an OKX "ticker" response. The API wraps its payload as
 * `{ code, msg, data: [...] }`. We return the first entry of `data`
 * or `null` if the response is malformed.
 */
interface OkxTicker {
  instType: string;
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  vol24h: string;
  ts: string;
}

function asOkxTicker(json: unknown): OkxTicker | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as { code?: string; data?: unknown };
  if (obj.code !== '0') return null;
  if (!Array.isArray(obj.data) || obj.data.length === 0) return null;
  const row = obj.data[0] as OkxTicker | undefined;
  if (!row || typeof row.last !== 'string') return null;
  return row;
}

interface OkxOpenInterest {
  instType: string;
  instId: string;
  oi: string;
  oiCcy: string;
  ts: string;
}

function asOkxOpenInterest(json: unknown): OkxOpenInterest | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as { code?: string; data?: unknown };
  if (obj.code !== '0') return null;
  if (!Array.isArray(obj.data) || obj.data.length === 0) return null;
  const row = obj.data[0] as OkxOpenInterest | undefined;
  if (!row || typeof row.oi !== 'string') return null;
  return row;
}

interface OkxFunding {
  instType: string;
  instId: string;
  fundingRate: string;
  nextFundingTime?: string;
  fundingTime?: string;
}

function asOkxFunding(json: unknown): OkxFunding | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as { code?: string; data?: unknown };
  if (obj.code !== '0') return null;
  if (!Array.isArray(obj.data) || obj.data.length === 0) return null;
  const row = obj.data[0] as OkxFunding | undefined;
  if (!row || typeof row.fundingRate !== 'string') return null;
  return row;
}

interface OkxLongShort {
  longShortRatio: string;
}

function asOkxLongShort(json: unknown): OkxLongShort | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as { code?: string; data?: unknown };
  if (obj.code !== '0') return null;
  if (!Array.isArray(obj.data) || obj.data.length === 0) return null;
  const row = obj.data[0] as OkxLongShort | undefined;
  if (!row || typeof row.longShortRatio !== 'string') return null;
  return row;
}

/**
 * Fetch an OKX swap snapshot. The shape mirrors Binance's snapshot
 * (mark, funding, OI, L/S ratio) so it can be consumed uniformly.
 *
 * Note: OKX `market/ticker` does not return a separate "mark" price;
 * we use `last` (the last trade price) as the mark. For liquidation
 * heatmap purposes this is close enough.
 */
export async function fetchOkxSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ snapshot: FuturesSnapshot | null; blocked: boolean; degraded: boolean; error?: string }> {
  const instId = okxMeta.symbolFormat(symbol);
  // Split off the base ccy for the long/short endpoint.
  const baseCcy = instId.split('-')[0] ?? '';

  const prefix = 'okx';
  try {
    const [ticker, oi, funding, ls] = await Promise.all([
      safeFetch(proxyUrl(prefix, 'market/ticker', `?instId=${instId}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'market/open-interest', `?instId=${instId}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'public/funding-rate', `?instId=${instId}`), fetchImpl),
      baseCcy
        ? safeFetch(
            proxyUrl(
              prefix,
              'rubik/stat/contracts/long-short-account-ratio',
              `?ccy=${baseCcy}&period=5m`,
            ),
            fetchImpl,
          )
        : Promise.resolve<UpstreamResponse>({
            status: 200,
            ok: true,
            json: async () => ({ code: '0', data: [] }),
            text: async () => '',
          }),
    ]);

    if (anyBlocked([ticker, oi, funding, ls])) {
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
    const fundingJson = funding.ok ? ((await funding.json()) as unknown) : null;
    const lsJson = ls.ok ? ((await ls.json()) as unknown) : null;

    const t = asOkxTicker(tickerJson);
    const o = asOkxOpenInterest(oiJson);
    if (!t) {
      return { snapshot: null, blocked: false, degraded: true, error: 'parse_error' };
    }

    const markPrice = safePositive(t.last);
    const indexPrice = safeNum(t.last); // OKX has no separate index field in ticker
    let fundingRate = 0;
    let nextFundingTime = 0;
    if (fundingJson) {
      const f = asOkxFunding(fundingJson);
      if (f) {
        fundingRate = safeNum(f.fundingRate);
        nextFundingTime = safeNum(f.nextFundingTime ?? f.fundingTime);
      }
    }
    // OI in contracts (`oi`) and OI in ccy (`oiCcy`, which is in
    // base currency). For USD notional we multiply contracts * mark
    // price. (Each contract on OKX swap is 0.01 BTC for BTC-USDT-SWAP
    // and 0.1 ETH for ETH-USDT-SWAP, but the exact multiplier varies
    // by instrument — `oiCcy` is the simpler approximation in base
    // units. We use the USD-quote volume from the ticker as a more
    // reliable USD notional when available.)
    let openInterest = 0;
    let openInterestUsd = 0;
    if (o) {
      openInterest = safeNum(o.oi);
      const volCcy24h = safeNum(t.volCcy24h);
      // Notional: prefer `oiCcy * mark` (base ccy) if present.
      const oiCcy = safeNum(o.oiCcy);
      if (oiCcy > 0 && markPrice > 0) {
        openInterestUsd = oiCcy * markPrice;
      } else if (volCcy24h > 0) {
        // Fall back to 24h notional volume as a rough estimate.
        openInterestUsd = volCcy24h;
      }
    }
    let longShortRatio = 1;
    if (lsJson) {
      const lsRow = asOkxLongShort(lsJson);
      if (lsRow) {
        const v = safeNum(lsRow.longShortRatio);
        if (v > 0) longShortRatio = v;
      }
    }
    const degraded = !funding.ok || !ls.ok;

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
        takerBuySellRatio: 1, // OKX does not expose a public taker buy/sell ratio on the free REST
        ts: Date.now(),
      },
      blocked: false,
      degraded,
    };
  } catch (err) {
    return { snapshot: null, blocked: false, degraded: true, error: String(err) };
  }
}

export async function fetchOkxProvider(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const snap = await fetchOkxSnapshot(symbol, fetchImpl);
  if (snap.blocked) return emptyResult(okxMeta.id, 'region_blocked', true);
  if (!snap.snapshot) {
    return emptyResult(okxMeta.id, snap.error ?? 'no_snapshot', false, true);
  }
  return {
    provider: okxMeta.id,
    snapshot: snap.snapshot,
    events: [],
    blocked: false,
    degraded: snap.degraded,
  };
}

// Re-export isRegionBlockedStatus so consumers don't have to import
// from base directly.
export { isRegionBlockedStatus };
