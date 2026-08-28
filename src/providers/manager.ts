// ProviderManager - dispatches requests to the best provider for a symbol
// and applies cross-cutting concerns:
//   - throttling candle updates (max 10/sec per symbol)
//   - deduplication of out-of-order candles by timestamp
//   - exponential backoff reconnection (provider-level, but the manager
//     tracks the canonical "current" status per (symbol,kind) and resets
//     its own retry counter on a successful first message)
//
// Providers are tried in registration order. For each symbol the manager
// iterates providers, returning the first one that has the symbol in its
// `providerIds` map. A preference list (e.g. ["binance", "coingecko"]) is
// honoured by sorting matching providers accordingly.

import type {
  Candle,
  ConnectionStatus,
  SymbolInfo,
  TickerData,
  Timeframe,
} from '@/types';
import type {
  CandleCallback,
  MarketDataProvider,
  StatusCallback,
  TickerCallback,
  Unsubscribe,
} from './types';
import { sanitizeCandle } from './_utils';

const THROTTLE_MS = 100; // 10 updates per second

export interface ProviderManagerOptions {
  /** Ordered list of provider names to prefer when picking a provider. */
  preference?: string[];
  /** Override the throttle window in ms (used in tests). */
  throttleMs?: number;
}

interface SymbolProviderState {
  /** The most recent candle time we have ever observed (used for dedup). */
  lastSeenTime: number;
  /** The time of the most recent candle we have emitted to the consumer. */
  lastEmittedTime: number;
  /** Wall-clock ms of the most recent emission. */
  lastEmitMs: number;
  /** A candle that is ready to emit but is being held by the throttle. */
  pendingCandle: Candle | null;
  /** Map<time, merged candle> of pending candles awaiting emission in the
   *  current batch. Replaces single pendingCandle. */
  pendingByTime: Map<number, Candle>;
  /** The throttle timer, if any. */
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** Whether a microtask is currently scheduled to emit. */
  microtaskScheduled: boolean;
}

/**
 * The ProviderManager multiplexes subscriptions across multiple providers
 * and applies per-symbol throttling and deduplication. Each subscription is
 * fully independent and may be closed without affecting others.
 */
export class ProviderManager {
  private readonly providers: MarketDataProvider[] = [];
  private readonly preference: string[];
  private readonly throttleMs: number;
  private readonly state = new Map<string, SymbolProviderState>();

  constructor(options: ProviderManagerOptions = {}) {
    this.preference = options.preference ?? ['binance', 'coingecko'];
    this.throttleMs = options.throttleMs ?? THROTTLE_MS;
  }

  /** Register a provider. Order of registration is the tie-breaker. */
  registerProvider(provider: MarketDataProvider): void {
    this.providers.push(provider);
  }

  /** Returns the list of registered provider names in order. */
  getProviderNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Pick the best provider for a symbol. Uses the preference order, then
   * registration order, then any provider that has the symbol.
   */
  pickProvider(symbol: SymbolInfo): MarketDataProvider | undefined {
    return this.pickProviders(symbol)[0];
  }

  /**
   * Like {@link pickProvider} but returns ALL matching providers sorted by
   * preference (best first). Used by the auto-switch failover logic so the
   * manager can try each provider in turn until one connects / returns data.
   */
  pickProviders(symbol: SymbolInfo): MarketDataProvider[] {
    const matches = this.providers.filter((p) => p.getSymbolInfo(symbol.id));
    if (matches.length === 0) return [];
    return matches.slice().sort((a, b) => {
      const ai = this.preference.indexOf(a.name);
      const bi = this.preference.indexOf(b.name);
      const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (av !== bv) return av - bv;
      return this.providers.indexOf(a) - this.providers.indexOf(b);
    });
  }

  /** Look up a symbol across all registered providers. */
  resolveSymbol(id: string): SymbolInfo | undefined {
    for (const p of this.providers) {
      const s = p.getSymbolInfo(id);
      if (s) return s;
    }
    return undefined;
  }

  async getHistoricalCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const providers = this.pickProviders(symbol);
    if (providers.length === 0) return [];
    // Try each matching provider in preference order. Return the first
    // non-empty, sanitize-filtered result. A throw or empty result falls
    // through to the next provider transparently (geo-block failover).
    for (const provider of providers) {
      try {
        const result = await provider.getHistoricalCandles(symbol, timeframe, limit, endTime);
        const sanitized = result.filter((c) => sanitizeCandle(c) !== null) as Candle[];
        if (sanitized.length > 0) return sanitized;
      } catch {
        // try the next provider
      }
    }
    return [];
  }

  /**
   * Subscribe to candles with throttling and dedup applied at the manager
   * level. The underlying provider does its own stream management.
   */
  subscribeCandles(
    symbol: SymbolInfo,
    timeframe: Timeframe,
    onCandle: CandleCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const providers = this.pickProviders(symbol);
    if (providers.length === 0) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }

    const key = this.stateKey(symbol.id, 'candle', timeframe);
    const state = this.getOrCreateState(key);

    // Wrap onStatus so we flush any pending burst on close. We deliberately
    // do NOT call clearState here: a burst that arrived in the same tick as
    // the 'closed' status still has a coalesced trailing emission owed to the
    // consumer, and clearing the throttle/pending state would drop it. The
    // throttle timer (if any) will fire and deliver the trailing candle.
    const wrappedStatus: StatusCallback = (s) => {
      if (s === 'closed') {
        this.flushPending(state, onCandle);
      }
      onStatus(s);
    };

    const wrappedCandle: CandleCallback = (c) => {
      this.enqueueCandle(state, c, onCandle);
    };

    return this.failoverSubscribe(
      providers,
      wrappedCandle,
      wrappedStatus,
      (provider, onStream, onStatusProxy) => provider.subscribeCandles(symbol, timeframe, onStream, onStatusProxy),
    );
  }

  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const providers = this.pickProviders(symbol);
    if (providers.length === 0) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    return this.failoverSubscribe(
      providers,
      onTicker,
      onStatus,
      (provider, onStream, onStatusProxy) => provider.subscribeTicker(symbol, onStream, onStatusProxy),
    );
  }

  // ------------- internal helpers (exposed for tests) -------------

  /** State key for (symbol, kind, timeframe) tuples. */
  stateKey(symbolId: string, kind: 'candle' | 'ticker', timeframe?: Timeframe): string {
    return `${symbolId}::${kind}::${timeframe ?? ''}`;
  }

  private getOrCreateState(key: string): SymbolProviderState {
    let s = this.state.get(key);
    if (!s) {
      s = {
        lastSeenTime: -1,
        lastEmittedTime: -1,
        lastEmitMs: 0,
        pendingCandle: null,
        pendingByTime: new Map(),
        throttleTimer: null,
        microtaskScheduled: false,
      };
      this.state.set(key, s);
    }
    return s;
  }

  private clearState(state: SymbolProviderState): void {
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    // Don't delete the entry; keep lastSeenTime for re-subscription dedup.
    state.pendingCandle = null;
    state.pendingByTime.clear();
  }

  /**
   * Dedup + throttle:
   *   - Drop candles whose time is strictly less than the most recently
   *     observed time (out-of-order duplicates).
   *   - All updates that arrive in a single tick are buffered in a
   *     `pendingByTime` map. Same-time updates are merged; different-
   *     time updates each get their own entry.
   *   - On the next microtask boundary, we emit each unique time as a
   *     separate event, subject to the throttle.
   */
  private enqueueCandle(state: SymbolProviderState, candle: Candle, onCandle: CandleCallback): void {
    const safe = sanitizeCandle(candle);
    if (!safe) return;

    // 1) Drop strictly-older candles.
    if (state.lastSeenTime !== -1 && safe.time < state.lastSeenTime) {
      return;
    }

    // 2) Update the "most recent seen" tracker.
    state.lastSeenTime = safe.time;

    // 3) Buffer the candle in pendingByTime (merging with any same-
    //    time entry). For a same-tick batch, every distinct time gets
    //    its own emission on the next microtask.
    const existing = state.pendingByTime.get(safe.time);
    if (existing) {
      state.pendingByTime.set(safe.time, {
        time: safe.time,
        open: existing.open,
        high: Math.max(existing.high, safe.high),
        low: Math.min(existing.low, safe.low),
        close: safe.close,
        volume: existing.volume + safe.volume,
      });
    } else {
      state.pendingByTime.set(safe.time, safe);
    }

    // 4) Schedule a microtask to emit. If a microtask is already
    //    scheduled, the existing one will pick up the new entry.
    if (state.microtaskScheduled) return;
    state.microtaskScheduled = true;
    queueMicrotask(() => {
      state.microtaskScheduled = false;
      this.flushPending(state, onCandle);
    });
  }

  private emitOne(state: SymbolProviderState, c: Candle, onCandle: CandleCallback): void {
    state.lastEmittedTime = c.time;
    state.lastEmitMs = Date.now();
    try {
      onCandle(c);
    } catch {
      /* swallow listener error */
    }
  }

  private flushPending(state: SymbolProviderState, onCandle: CandleCallback): void {
    if (state.pendingByTime.size === 0) return;
    // Sort times ascending so consumers see them in order. Emit every
    // pending candle that the throttle window allows. After the first
    // emission, the elapsed window resets to 0, so for throttleMs > 0
    // only one leading emission is possible per call.
    const times = Array.from(state.pendingByTime.keys()).sort((a, b) => a - b);
    for (const t of times) {
      const c = state.pendingByTime.get(t);
      if (!c) continue;
      const elapsed = Date.now() - state.lastEmitMs;
      if (elapsed >= this.throttleMs) {
        state.pendingByTime.delete(t);
        this.emitOne(state, c, onCandle);
        continue;
      }
      // Throttled: the remaining candles will be coalesced into a single
      // trailing emission below. Stop iterating.
      break;
    }
    // Coalesce all remaining pending candles into the latest one and
    // schedule a single trailing emission after the throttle window.
    // This bounds a burst of N updates to at most 2 emissions per window
    // (1 immediate + 1 trailing) regardless of N.
    if (state.pendingByTime.size > 0 && !state.throttleTimer) {
      const wait = Math.max(0, this.throttleMs - (Date.now() - state.lastEmitMs));
      state.throttleTimer = setTimeout(() => {
        state.throttleTimer = null;
        if (state.pendingByTime.size > 0) {
          // Emit only the latest pending candle; discard the rest
          // (they are superseded by the latest in a burst).
          let latestT = -Infinity;
          for (const t of state.pendingByTime.keys()) {
            if (t > latestT) latestT = t;
          }
          const latestC = state.pendingByTime.get(latestT);
          if (latestC) {
            this.emitOne(state, latestC, onCandle);
          }
          state.pendingByTime.clear();
        }
      }, wait);
    }
  }

  private flushPendingCandle(state: SymbolProviderState, onCandle: CandleCallback): void {
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushPending(state, onCandle);
  }

  /**
   * Drive a live subscription across multiple providers with AUTO-SWITCH
   * failover. Starts with the first matching provider and transparently
   * swaps to the next one if:
   *   - the underlying provider emits `error`, or
   *   - the underlying provider emits `closed` before it ever connected, or
   *   - no `connected` status arrives within {@link FAILOVER_CONNECT_TIMEOUT_MS}.
   *
   * The consumer callbacks (`onStream`, `onStatus`) are never swapped — only
   * the underlying provider subscription changes. Throttle/dedup (for candles)
   * is applied upstream by the caller's wrapped callbacks, so it keeps working
   * on whichever provider ultimately connects.
   */
  private failoverSubscribe<StreamCb extends (...args: any[]) => void>(
    providers: MarketDataProvider[],
    onStream: StreamCb,
    onStatus: StatusCallback,
    subscribe: (provider: MarketDataProvider, onStream: StreamCb, onStatusProxy: StatusCallback) => Unsubscribe,
  ): Unsubscribe {
    const FAILOVER_CONNECT_TIMEOUT_MS = 8000;
    let connected = false;
    let cancelled = false;
    let currentUnsub: Unsubscribe | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let token = 0;

    const clearTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const switchTo = (next: number) => {
      if (cancelled) return;
      token += 1; // invalidate the current provider's in-flight callbacks
      clearTimer();
      currentUnsub?.();
      currentUnsub = null;
      if (next < providers.length) {
        tryProvider(next);
      } else {
        onStatus('error');
      }
    };

    const tryProvider = (i: number) => {
      if (cancelled) return;
      connected = false;
      const myToken = ++token;
      const provider = providers[i]!;
      const statusProxy: StatusCallback = (s) => {
        if (myToken !== token) return; // stale provider (superseded by failover)
        if (s === 'connected') {
          connected = true;
          clearTimer();
        }
        // Failover triggers: a hard error, or a close before any connection.
        if (s === 'error' || (s === 'closed' && !connected)) {
          switchTo(i + 1);
          return;
        }
        onStatus(s);
      };
      currentUnsub = subscribe(provider, onStream, statusProxy);

      clearTimer();
      timeoutId = setTimeout(() => {
        if (cancelled || myToken !== token) return;
        if (!connected) switchTo(i + 1);
      }, FAILOVER_CONNECT_TIMEOUT_MS);
    };

    tryProvider(0);

    return () => {
      cancelled = true;
      clearTimer();
      currentUnsub?.();
      currentUnsub = null;
    };
  }
}

/**
 * Re-export the canonical backoff sequence so tests and consumers don't
 * need to import the utility directly.
 */
export const BACKOFF_SEQUENCE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];
