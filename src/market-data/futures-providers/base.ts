// Shared utilities for the futures provider chain.
//
// These helpers are deliberately tiny and side-effect free: each
// provider module imports them so that the only thing that changes
// between providers is the URL shape and the JSON parsing logic.
//
// No state lives in this module — it is safe to import on the server
// and in tests.

import { isFiniteNum } from '@/core/utils/series';
import type { ProviderResult, UpstreamResponse } from './types';

/**
 * Status codes that indicate the upstream is deliberately refusing
 * to serve the request because of the user's jurisdiction. We treat
 * these as a hard "stop and try the next provider" signal.
 *
 * - 451: "Unavailable For Legal Reasons" — Binance's geo-block code.
 * - 403: "Forbidden" — often Cloudflare's generic region block.
 * - 407: "Proxy Authentication Required" — used by some upstreams.
 */
export function isRegionBlockedStatus(status: number): boolean {
  return status === 451 || status === 403 || status === 407;
}

/**
 * Build a Next.js API proxy URL for a given provider prefix. In the
 * browser we always go through the proxy (CORS); on the server
 * (e.g. in tests with a mocked `fetchImpl`) we use the upstream
 * directly.
 */
export function proxyUrl(prefix: string, path: string, query = ''): string {
  const inBrowser = typeof window !== 'undefined';
  const base = inBrowser ? `/api/${prefix}` : upstreamBaseFor(prefix);
  return `${base}/${path}${query}`;
}

/**
 * The canonical upstream base URL for each provider prefix. Used
 * when running server-side or in tests (no proxy in between).
 */
export function upstreamBaseFor(prefix: string): string {
  switch (prefix) {
    case 'futures':
      return 'https://fapi.binance.com';
    case 'binance':
      return 'https://api.binance.com';
    case 'binance-coinm':
      return 'https://dapi.binance.com/dapi/v1';
    case 'okx':
      return 'https://www.okx.com/api/v5';
    case 'gate':
      return 'https://api.gateio.ws/api/v4';
    case 'bitget':
      return 'https://api.bitget.com/api/v2/mix/market';
    case 'coingecko':
      return 'https://api.coingecko.com/api/v3';
    default:
      throw new Error(`Unknown provider prefix: ${prefix}`);
  }
}

/**
 * Coerce a value (typically a string from JSON) to a finite number,
 * returning 0 for anything that isn't a real number. Used to defend
 * against malformed upstream responses.
 */
export function safeNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Coerce to a positive finite number, falling back to 0 if the value
 * is non-positive (which is the convention used throughout this
 * module for fields like `markPrice`).
 */
export function safePositive(v: unknown): number {
  const n = safeNum(v);
  return isFiniteNum(n) && n > 0 ? n : 0;
}

/**
 * Helper that wraps a raw `fetch` call and returns a normalised
 * `UpstreamResponse` that will never throw. Any thrown error (network
 * failure, abort, JSON parse error) becomes a synthetic response
 * with `status: 0` and `ok: false`.
 *
 * This lets providers simply `.then(r => ...)` every fetch without
 * littering the code with try/catch.
 */
export async function safeFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
  init?: RequestInit,
): Promise<UpstreamResponse> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store', ...init });
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json().catch(() => null),
      text: () => res.text().catch(() => ''),
    };
  } catch {
    return {
      status: 0,
      ok: false,
      json: async () => null,
      text: async () => '',
    };
  }
}

/**
 * Build a "no-data" `ProviderResult` for a provider that was reachable
 * but returned no usable data. Used to short-circuit the fallback
 * chain when something succeeds but returns nothing.
 */
export function emptyResult(
  provider: string,
  error?: string,
  blocked = false,
  degraded = false,
): ProviderResult {
  return {
    provider,
    snapshot: null,
    events: [],
    blocked,
    degraded,
    error,
  };
}

/**
 * Given an array of upstream responses, return `true` if any of them
 * returned a region-blocked status. Used to decide whether to abort
 * the chain and fall through to the next provider.
 */
export function anyBlocked(responses: UpstreamResponse[]): boolean {
  return responses.some((r) => isRegionBlockedStatus(r.status));
}
