// Multi-provider futures data fallback chain.
//
// When the user is in a region where Binance USDⓈ-M is geo-blocked
// (HTTP 451 / 403), we silently try OKX, then Gate.io, then Bitget,
// then Binance COIN-M in that order. The first provider that returns
// a usable snapshot "wins", and the caller never has to know which
// one it was — the `FuturesSnapshot` shape is the same across all
// providers.
//
// This module is the only thing the rest of the app should import
// from the `futures-providers/` directory; the individual provider
// modules are considered internal implementation details.

import type { ProviderResult } from './types';
import { fetchBinanceProvider, binanceMeta } from './binance';
import { fetchBinanceCoinMProvider, binanceCoinMMeta, COINM_SUPPORTED } from './binance-coinm';
import { fetchOkxProvider, okxMeta } from './okx';
import { fetchGateProvider, gateMeta } from './gate';
import { fetchBitgetProvider, bitgetMeta } from './bitget';

export type { ProviderResult, ProviderMeta } from './types';
export { binanceMeta, binanceCoinMMeta, okxMeta, gateMeta, bitgetMeta };

interface ChainEntry {
  id: string;
  fetcher: (symbol: string, fetchImpl?: typeof fetch) => Promise<ProviderResult>;
  /**
   * If set, this provider is only consulted for the canonical symbols
   * listed in the set. The chain checks this before calling the
   * fetcher so we never even hit the network for symbols the provider
   * doesn't support.
   */
  onlyFor?: ReadonlySet<string>;
}

/**
 * The order in which providers are consulted. Binance is preferred
 * because it has the only public liquidation feed among the five;
 * everything else is a graceful degradation.
 */
const PROVIDER_CHAIN: ChainEntry[] = [
  { id: binanceMeta.id, fetcher: fetchBinanceProvider },
  { id: okxMeta.id, fetcher: fetchOkxProvider },
  { id: gateMeta.id, fetcher: fetchGateProvider },
  { id: bitgetMeta.id, fetcher: fetchBitgetProvider },
  {
    id: binanceCoinMMeta.id,
    fetcher: fetchBinanceCoinMProvider,
    onlyFor: COINM_SUPPORTED,
  },
];

export interface FetchFuturesWithFallbackOptions {
  /**
   * If set, try this provider first. If it succeeds we return its
   * result; if it returns `blocked: true` or no snapshot, we fall
   * through to the rest of the chain in the usual order.
   */
  preferredProvider?: string;
  /**
   * Optional fetch implementation, primarily for tests. Defaults to
   * the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Try each provider in order. Returns the first non-blocked result
 * that has a valid snapshot. If all are blocked or fail, returns the
 * last result (with `snapshot: null`, `blocked: true`) so the caller
 * knows the user is fully geo-blocked.
 *
 * The fallback is transparent: a successful OKX/Gate/Bitget response
 * produces the same `ProviderResult` shape as a successful Binance
 * one, so the caller's downstream code (synthesize heatmap, push to
 * zustand store, etc.) does not need any branching.
 */
export async function fetchFuturesWithFallback(
  symbol: string,
  options: FetchFuturesWithFallbackOptions = {},
): Promise<ProviderResult> {
  const { preferredProvider, fetchImpl } = options;

  // If a preferred provider is set, hoist it to the front of the
  // chain. The rest of the chain stays in the default order so the
  // fallback behaviour is consistent regardless of preference.
  let chain: ChainEntry[] = PROVIDER_CHAIN;
  if (preferredProvider) {
    const head = PROVIDER_CHAIN.find((p) => p.id === preferredProvider);
    if (head) {
      chain = [head, ...PROVIDER_CHAIN.filter((p) => p.id !== preferredProvider)];
    }
  }

  let lastResult: ProviderResult | null = null;
  for (const entry of chain) {
    // Skip providers that explicitly opt out of this symbol.
    if (entry.onlyFor && !entry.onlyFor.has(symbol)) continue;

    try {
      const result = await entry.fetcher(symbol, fetchImpl);
      lastResult = result;
      if (!result.blocked && result.snapshot) {
        return result;
      }
      // If blocked or no snapshot, try the next provider. A "degraded"
      // result with a snapshot is still returned as a success — the
      // snapshot is good enough; degraded just means some optional
      // endpoints failed.
    } catch (err) {
      // Should be rare: provider implementations swallow their own
      // errors and return a ProviderResult. This catch is a safety
      // net so a thrown bug in one provider cannot break the whole
      // chain.
      lastResult = {
        provider: entry.id,
        snapshot: null,
        events: [],
        blocked: false,
        degraded: true,
        error: String(err),
      };
    }
  }
  if (lastResult) return lastResult;
  return {
    provider: 'none',
    snapshot: null,
    events: [],
    blocked: true,
    degraded: false,
  };
}
