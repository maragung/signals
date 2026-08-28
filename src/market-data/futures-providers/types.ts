// Common types for the multi-provider futures data fallback chain.
//
// All providers in this module expose the same return shape so the
// caller (`fetchFuturesWithFallback`) can transparently swap between
// them. The user-facing shape (`FuturesSnapshot` + `LiquidationEvent`)
// is unchanged from the previous single-provider implementation; this
// module only adds the plumbing that lets the system keep working when
// the primary upstream (Binance USDⓈ-M) is geo-blocked.

import type { FuturesSnapshot, LiquidationEvent } from '@/types';

/**
 * Metadata describing a single futures data provider.
 *
 * `symbolFormat` converts the canonical "BTCUSDT"-style symbol the rest
 * of the app uses into whatever the provider's API expects (e.g. OKX
 * wants "BTC-USDT-SWAP", Gate.io wants "BTC_USDT").
 */
export interface ProviderMeta {
  /** Stable identifier, used in logs and as a `preferredProvider` option. */
  id: string;
  /** Human-readable name for the UI / debug output. */
  display: string;
  /** Convert canonical "BTCUSDT" -> provider-specific symbol. */
  symbolFormat: (canonical: string) => string;
}

/**
 * Result of a single provider attempt. `snapshot` may be `null` if the
 * provider was reachable but the data could not be parsed; in that
 * case `error` is set and the caller should move to the next provider.
 */
export interface ProviderResult {
  /** Provider id that produced this result. */
  provider: string;
  /** Normalised snapshot, or `null` if the fetch failed. */
  snapshot: FuturesSnapshot | null;
  /** Recent liquidation events. Empty when the provider has no public feed. */
  events: LiquidationEvent[];
  /** True if upstream returned a geo-block status (451/403/407). */
  blocked: boolean;
  /**
   * True when data is partial (some endpoints failed but the provider
   * itself is reachable). Distinct from `blocked` — `blocked` is a
   * "stop trying" signal, `degraded` is just a quality flag.
   */
  degraded: boolean;
  /** Error message if the provider returned a non-blocked failure. */
  error?: string;
}

/**
 * Internal helper — a normalized response wrapper used by all
 * providers so they can uniformly detect 451/403/407 without each
 * one re-implementing the same boilerplate.
 */
export interface UpstreamResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
