// Binance USDⓈ-M Futures public liquidation WebSocket stream.
//
// Connects to wss://fstream.binance.com/ws/<symbol>@forceOrder and
// forwards each liquidation event to the caller. Public endpoint,
// no API key required.
//
// Implements exponential backoff reconnection (1s → 30s cap),
// heartbeat tracking, and a small in-memory recent-events buffer
// (capped at `maxRecent`) for late subscribers.

import type { LiquidationEvent, LiquidationSide } from '@/types';
import { isFiniteNum } from '@/core/utils/series';

const FSTREAM_BASE = 'wss://fstream.binance.com/ws';

const BACKOFF_SEQUENCE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];

export interface LiquidationStreamOptions {
  symbol: string; // futures symbol, e.g. "BTCUSDT"
  maxRecent?: number;
  /** Override the WebSocket constructor (for testing). */
  WebSocketImpl?: typeof WebSocket;
  /** Override fetch (unused but kept for API parity). */
  fetchImpl?: typeof fetch;
  /**
   * If true, the stream will not attempt to connect at all. Use this
   * when a prior REST call already confirmed the upstream is
   * geo-blocked (451/403) and reconnecting is futile.
   */
  skipOnRegionBlocked?: boolean;
  onEvent?: (ev: LiquidationEvent) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed' | 'region-blocked') => void;
  onError?: (err: Error) => void;
}

interface ForceOrderPayload {
  e: string; // event type, e.g. "forceOrder"
  E: number; // event time
  o: {
    s: string; // symbol
    S: 'BUY' | 'SELL'; // side of the liquidated order
    o: 'LIMIT' | string; // order type
    f: 'IOC' | string; // tif
    q: string; // quantity
    p: string; // price
    ap: string; // average price
    X: 'FILLED' | string; // status
    l: string; // last filled quantity
    z: string; // cumulative filled quantity
    T: number; // trade time
  };
}

function parsePayload(p: ForceOrderPayload): LiquidationEvent | null {
  if (!p || p.e !== 'forceOrder' || !p.o) return null;
  const o = p.o;
  const symbol = o.s;
  if (!symbol) return null;
  const price = Number(o.ap || o.p);
  const qty = Number(o.z || o.q);
  if (!isFiniteNum(price) || !isFiniteNum(qty) || price <= 0 || qty <= 0) return null;
  // SELL side means the user's long position was force-closed
  // (liquidated because price fell below margin). BUY side means
  // a short was liquidated (price rose above margin).
  const side: LiquidationSide = o.S === 'SELL' ? 'long' : 'short';
  return {
    time: o.T || p.E,
    symbol,
    side,
    price,
    quantity: qty,
    notional: price * qty,
  };
}

export type LiquidationStreamStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed'
  | 'region-blocked';

export interface LiquidationStreamHandle {
  close(): void;
  recent(): LiquidationEvent[];
  status(): LiquidationStreamStatus;
}

export function startLiquidationStream(opts: LiquidationStreamOptions): LiquidationStreamHandle {
  const symbol = opts.symbol.toLowerCase();
  const maxRecent = opts.maxRecent ?? 200;
  const WS = opts.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : (undefined as never));
  if (!WS) {
    return {
      close: () => {},
      recent: () => [],
      status: () => 'closed',
    };
  }

  const recentBuffer: LiquidationEvent[] = [];
  let status: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed' | 'region-blocked' = 'connecting';
  let backoffIdx = 0;
  let lastMsgTs = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let ws: WebSocket | null = null;

  const setStatus = (s: typeof status) => {
    status = s;
    opts.onStatus?.(s);
  };

  const connect = () => {
    if (closed) return;
    if (opts.skipOnRegionBlocked) {
      setStatus('region-blocked');
      return;
    }
    setStatus(backoffIdx === 0 ? 'connecting' : 'reconnecting');
    const url = `${FSTREAM_BASE}/${symbol}@forceOrder`;
    let socket: WebSocket;
    try {
      socket = new WS(url);
    } catch (err) {
      scheduleReconnect(err as Error);
      return;
    }
    ws = socket;
    socket.onopen = () => {
      backoffIdx = 0;
      lastMsgTs = Date.now();
      setStatus('connected');
      startHeartbeat();
    };
    socket.onmessage = (ev) => {
      lastMsgTs = Date.now();
      if (typeof ev.data !== 'string') return;
      try {
        const data = JSON.parse(ev.data) as ForceOrderPayload | unknown;
        if (!data || typeof data !== 'object' || (data as { e?: string }).e !== 'forceOrder') return;
        const event = parsePayload(data as ForceOrderPayload);
        if (!event) return;
        recentBuffer.unshift(event);
        if (recentBuffer.length > maxRecent) recentBuffer.length = maxRecent;
        opts.onEvent?.(event);
      } catch (err) {
        opts.onError?.(err as Error);
      }
    };
    socket.onerror = () => {
      setStatus('error');
    };
    socket.onclose = () => {
      stopHeartbeat();
      if (closed) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    };
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastMsgTs > 60_000) {
        // No message in 60s; force reconnect.
        try {
          ws?.close();
        } catch {
          // ignore
        }
      }
    }, 30_000);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const scheduleReconnect = (err?: Error) => {
    if (closed) return;
    if (err) opts.onError?.(err);
    const delay = BACKOFF_SEQUENCE_MS[Math.min(backoffIdx, BACKOFF_SEQUENCE_MS.length - 1)]!;
    backoffIdx += 1;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  };

  connect();

  return {
    close: () => {
      closed = true;
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      setStatus('closed');
    },
    recent: () => recentBuffer.slice(),
    status: () => status,
  };
}
