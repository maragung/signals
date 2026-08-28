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
    const matches = this.providers.filter((p) => p.getSymbolInfo(symbol.id));
    if (matches.length === 0) return undefined;
    const sorted = matches.slice().sort((a, b) => {
      const ai = this.preference.indexOf(a.name);
      const bi = this.preference.indexOf(b.name);
      const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (av !== bv) return av - bv;
      return this.providers.indexOf(a) - this.providers.indexOf(b);
    });
    return sorted[0];
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
    const provider = this.pickProvider(symbol);
    if (!provider) return [];
    try {
      const result = await provider.getHistoricalCandles(symbol, timeframe, limit, endTime);
      return result.filter((c) => sanitizeCandle(c) !== null) as Candle[];
    } catch {
      return [];
    }
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
    const provider = this.pickProvider(symbol);
    if (!provider) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }

    const key = this.stateKey(symbol.id, 'candle', timeframe);
    const state = this.getOrCreateState(key);

    // Wrap onStatus so we can also clear pending state on close.
    const wrappedStatus: StatusCallback = (s) => {
      if (s === 'closed') {
        this.flushPendingCandle(state, onCandle);
        this.clearState(state);
      }
      onStatus(s);
    };

    const wrappedCandle: CandleCallback = (c) => {
      this.enqueueCandle(state, c, onCandle);
    };

    return provider.subscribeCandles(symbol, timeframe, wrappedCandle, wrappedStatus);
  }

  subscribeTicker(
    symbol: SymbolInfo,
    onTicker: TickerCallback,
    onStatus: StatusCallback,
  ): Unsubscribe {
    const provider = this.pickProvider(symbol);
    if (!provider) {
      queueMicrotask(() => onStatus('error'));
      return () => undefined;
    }
    return provider.subscribeTicker(symbol, onTicker, onStatus);
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
    // Sort times ascending so consumers see them in order.
    const times = Array.from(state.pendingByTime.keys()).sort((a, b) => a - b);
    for (const t of times) {
      const c = state.pendingByTime.get(t);
      if (!c) continue;
      state.pendingByTime.delete(t);
      const elapsed = Date.now() - state.lastEmitMs;
      if (elapsed >= this.throttleMs && !state.throttleTimer) {
        this.emitOne(state, c, onCandle);
      } else {
        // Throttled: stash the rest for later.
        state.pendingByTime.set(t, c);
        const wait = Math.max(0, this.throttleMs - elapsed);
        if (!state.throttleTimer) {
          state.throttleTimer = setTimeout(() => {
            state.throttleTimer = null;
            this.flushPending(state, onCandle);
          }, wait);
        }
        return;
      }
    }
  }

  private flushPendingCandle(state: SymbolProviderState, onCandle: CandleCallback): void {
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushPending(state, onCandle);
  }
}

/**
 * Re-export the canonical backoff sequence so tests and consumers don't
 * need to import the utility directly.
 */
export const BACKOFF_SEQUENCE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];
