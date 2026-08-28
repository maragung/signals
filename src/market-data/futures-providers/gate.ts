// Gate.io USDT perpetual futures provider.
//
// Gate.io's public REST API for USDT-margined perps is on
// `https://api.gateio.ws/api/v4/`. All endpoints used here are free
// and key-less.
//
// Endpoints:
//   - futures/usdt/contract_stats?contract=BTC_USDT
//     -> mark_price, total_size, etc.
//   - futures/usdt/funding_rates?contract=BTC_USDT
//     -> current funding rate
//   - futures/usdt/tickers?contract=BTC_USDT
//     -> last, mark_price, volume_24h_*
//
// Symbol format: "BTCUSDT" -> "BTC_USDT" (underscore separator).
//
// Note: Gate.io does not expose a public liquidation feed for the
// free tier. We return an empty `events` array.

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

export const gateMeta: ProviderMeta = {
  id: 'gate',
  display: 'Gate.io',
  symbolFormat: (s) => {
    const upper = s.toUpperCase();
    for (const quote of ['USDT', 'USDC', 'USD']) {
      if (upper.endsWith(quote) && upper.length > quote.length) {
        const base = upper.slice(0, upper.length - quote.length);
        return `${base}_${quote}`;
      }
    }
    return s;
  },
};

interface GateTicker {
  contract: string;
  last: string;
  mark_price: string;
  index_price: string;
  funding_rate: string;
  funding_rate_indicative?: string;
  volume_24h_base: string;
  volume_24h_quote: string;
}

function asGateTicker(json: unknown): GateTicker | null {
  if (!json || typeof json !== 'object') return null;
  // /tickers returns an array; /ticker returns a single object.
  let row: GateTicker | null = null;
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    const first = json[0];
    if (first && typeof first === 'object' && 'mark_price' in first) {
      row = first as GateTicker;
    }
  } else if (typeof json === 'object' && 'mark_price' in (json as Record<string, unknown>)) {
    row = json as GateTicker;
  }
  if (!row) return null;
  return row;
}

interface GateContractStats {
  time: number;
  mark_price: string;
  open_interest: string;
}

function asGateStats(json: unknown): GateContractStats | null {
  if (!json || typeof json !== 'object') return null;
  // /contract_stats returns an array.
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    const first = json[0];
    if (first && typeof first === 'object' && 'mark_price' in first) {
      return first as GateContractStats;
    }
  }
  if (typeof json === 'object' && 'mark_price' in (json as Record<string, unknown>)) {
    return json as GateContractStats;
  }
  return null;
}

interface GateFunding {
  contract: string;
  funding_rate: string;
}

function asGateFunding(json: unknown): GateFunding | null {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    const first = json[0];
    if (first && typeof first === 'object' && 'funding_rate' in first) {
      return first as GateFunding;
    }
  }
  if (typeof json === 'object' && 'funding_rate' in (json as Record<string, unknown>)) {
    return json as GateFunding;
  }
  return null;
}

export async function fetchGateSnapshot(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ snapshot: FuturesSnapshot | null; blocked: boolean; degraded: boolean; error?: string }> {
  const contract = gateMeta.symbolFormat(symbol);
  const prefix = 'gate';
  try {
    const [ticker, stats, funding] = await Promise.all([
      safeFetch(proxyUrl(prefix, 'futures/usdt/tickers', `?contract=${contract}`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'futures/usdt/contract_stats', `?contract=${contract}&interval=1h`), fetchImpl),
      safeFetch(proxyUrl(prefix, 'futures/usdt/funding_rates', `?contract=${contract}`), fetchImpl),
    ]);

    if (anyBlocked([ticker, stats, funding])) {
      return { snapshot: null, blocked: true, degraded: false };
    }
    if (!ticker.ok || !stats.ok) {
      return {
        snapshot: null,
        blocked: false,
        degraded: true,
        error: ticker.status === 0 || stats.status === 0 ? 'network' : `status_${ticker.status}_${stats.status}`,
      };
    }

    const tickerJson = (await ticker.json()) as unknown;
    const statsJson = (await stats.json()) as unknown;
    const fundingJson = funding.ok ? ((await funding.json()) as unknown) : null;

    const t = asGateTicker(tickerJson);
    const s = asGateStats(statsJson);
    if (!t || !s) {
      return { snapshot: null, blocked: false, degraded: true, error: 'parse_error' };
    }

    const markPrice = safePositive(s.mark_price) || safePositive(t.mark_price);
    const indexPrice = safeNum(t.index_price);
    const fundingRate = fundingJson ? safeNum(asGateFunding(fundingJson)?.funding_rate) : 0;
    const openInterest = safeNum(s.open_interest);
    // contract_stats' `mark_price` * `open_interest` gives a clean
    // USD notional for the OI (open_interest is in contracts, and
    // each contract on Gate.io USDT perps is typically the
    // corresponding base unit, e.g. 1 BTC for BTC_USDT).
    const openInterestUsd = markPrice > 0 ? openInterest * markPrice : 0;
    const degraded = !funding.ok;

    if (!isFiniteNum(markPrice) || markPrice <= 0) {
      return { snapshot: null, blocked: false, degraded: true, error: 'bad_mark' };
    }
    return {
      snapshot: {
        symbol,
        markPrice,
        indexPrice: isFiniteNum(indexPrice) && indexPrice > 0 ? indexPrice : markPrice,
        fundingRate,
        nextFundingTime: 0,
        openInterest,
        openInterestUsd,
        longShortRatio: 1, // not exposed on free tier
        takerBuySellRatio: 1, // not exposed on free tier
        ts: Date.now(),
      },
      blocked: false,
      degraded,
    };
  } catch (err) {
    return { snapshot: null, blocked: false, degraded: true, error: String(err) };
  }
}

export async function fetchGateProvider(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const snap = await fetchGateSnapshot(symbol, fetchImpl);
  if (snap.blocked) return emptyResult(gateMeta.id, 'region_blocked', true);
  if (!snap.snapshot) {
    return emptyResult(gateMeta.id, snap.error ?? 'no_snapshot', false, true);
  }
  return {
    provider: gateMeta.id,
    snapshot: snap.snapshot,
    events: [],
    blocked: false,
    degraded: snap.degraded,
  };
}

export { isRegionBlockedStatus };
