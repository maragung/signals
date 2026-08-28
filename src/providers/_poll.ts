// Shared polling helper for live (but server-proxied) market data.
//
// When a provider runs with `useProxy: true`, its live updates cannot use a
// raw WebSocket (the /api/* routes are REST-only and Vercel does not support
// WebSocket upgrades). Instead the provider polls the upstream's REST ticker
// and kline endpoints THROUGH the server-side proxy: the browser issues a
// normal fetch to `/api/<provider>/...`, the Next.js server fetches the
// upstream, and the result streams back. This keeps all egress server-side so
// client-side geo-blocks (HTTP 451/403) never reach the browser.

import type { Candle, ConnectionStatus, TickerData } from '@/types';
import type { CandleCallback, StatusCallback, TickerCallback, Unsubscribe } from './types';
import { isBrowser, makeStatusEmitter } from './_utils';

export interface PollingStreamOptions {
  /** Fetch the latest candle (or null). Polled on each tick. */
  candleFetcher?: () => Promise<Candle | null>;
  /** Fetch the latest ticker (or null). Polled on each tick. */
  tickerFetcher?: () => Promise<TickerData | null>;
  /** Poll interval in ms (default 2000, min 500). */
  intervalMs?: number;
  onCandle?: CandleCallback;
  onTicker?: TickerCallback;
  onStatus: StatusCallback;
}

/**
 * Start a polling loop that drives `onCandle`/`onTicker` from REST fetches.
 * Returns an unsubscribe function. Always runs in the browser (it relies on
 * setInterval + fetch); the fetches themselves target the server proxy so the
 * upstream request originates server-side.
 */
export function startPollingStream(opts: PollingStreamOptions): Unsubscribe {
  const intervalMs = Math.max(500, opts.intervalMs ?? 2000);
  const emitStatus = makeStatusEmitter(opts.onStatus);
  let closed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (!isBrowser()) {
    queueMicrotask(() => emitStatus('error'));
    return () => undefined;
  }

  emitStatus('connecting');

  const tick = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      if (opts.tickerFetcher) {
        const t = await opts.tickerFetcher();
        if (t && t.price > 0) {
          emitStatus('connected');
          opts.onTicker?.(t);
        }
      }
      if (opts.candleFetcher) {
        const c = await opts.candleFetcher();
        if (c) {
          emitStatus('connected');
          opts.onCandle?.(c);
        }
      }
    } catch {
      emitStatus('error');
    } finally {
      inFlight = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), intervalMs);

  return () => {
    closed = true;
    if (timer) clearInterval(timer);
    emitStatus('closed');
  };
}
