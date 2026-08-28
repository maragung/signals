// Shared WebSocket stream controller for the secondary spot providers
// (Bybit / OKX / Gate / Bitget). It is intentionally SIMPLER than Binance's
// `createStreamController` and independent of it so Binance's existing tests
// keep passing.
//
// Behaviour:
//   - Tries each candidate URL in order. A failure before the first successful
//     `connected` advances to the next URL (multi-server resilience). Only when
//     every URL has failed does it emit `error` (so the manager can fail over
//     to the next provider).
//   - After a successful connection a dropped socket reconnects to the SAME URL
//     with exponential backoff + jitter and emits `reconnecting`.
//   - A heartbeat watchdog closes the socket if no message arrives within the
//     timeout window (mirrors Binance).
//
// The Promise/controller never throws to the caller; listener errors are swallowed.

import type { ConnectionStatus } from '@/types';
import { backoffDelay } from './_utils';

export interface MultiStreamControllerOptions {
  /** Candidate WebSocket URLs, tried in order on connection failure. */
  urls: string[];
  WebSocketCtor: new (url: string) => WebSocket;
  onStatus: (s: ConnectionStatus) => void;
  onMessage: (raw: string) => void;
  /**
   * Called once per successful socket open. Providers use this to send an
   * initial subscribe/authentication frame (e.g. Bybit/OKX require an explicit
   * subscribe op after the connection is established).
   */
  onOpen?: (ws: WebSocket) => void;
  /** Override sleep (used in tests). */
  sleepFn?: (ms: number) => Promise<void>;
  heartbeatTimeoutMs?: number;
  heartbeatCheckMs?: number;
}

export interface MultiStreamController {
  close: () => void;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_CHECK_MS = 5_000;

export function createMultiStreamController(opts: MultiStreamControllerOptions): MultiStreamController {
  const sleepFn = opts.sleepFn ?? (async (ms: number) => new Promise((r) => setTimeout(r, ms)));
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const heartbeatCheckMs = opts.heartbeatCheckMs ?? HEARTBEAT_CHECK_MS;

  let closed = false;
  let baseIndex = 0;
  let attempt = 0;
  let connectedOnce = false;
  let lastMessage = 0;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const startHeartbeat = () => {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastMessage > heartbeatTimeoutMs) {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      }
    }, heartbeatCheckMs);
  };

  const failExhausted = () => {
    clearReconnect();
    opts.onStatus('error');
  };

  const advanceBase = () => {
    baseIndex += 1;
    if (baseIndex >= opts.urls.length) {
      failExhausted();
      return;
    }
    connect();
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const wait = backoffDelay(attempt);
    attempt += 1;
    opts.onStatus('reconnecting');
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };

  const connect = () => {
    if (closed) return;
    if (baseIndex >= opts.urls.length) {
      failExhausted();
      return;
    }
    opts.onStatus(baseIndex === 0 && attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new opts.WebSocketCtor(opts.urls[baseIndex]!);
    } catch {
      advanceBase();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      connectedOnce = true;
      lastMessage = Date.now();
      opts.onStatus('connected');
      startHeartbeat();
      try {
        opts.onOpen?.(socket);
      } catch {
        /* ignore subscribe-send errors */
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      lastMessage = Date.now();
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      try {
        opts.onMessage(data);
      } catch {
        /* listener error: swallow */
      }
    };

    socket.onerror = () => {
      // Defer the decision to onclose; if we never connected we advance the
      // base, otherwise we reconnect on the same base. We deliberately do NOT
      // emit 'error' here so a transient blip does not prematurely fail the
      // whole provider over to the manager.
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };

    socket.onclose = () => {
      clearHeartbeat();
      if (closed) {
        opts.onStatus('closed');
        return;
      }
      if (!connectedOnce) {
        advanceBase();
      } else {
        scheduleReconnect();
      }
    };
  };

  // Kick off asynchronously so the caller sees a clean 'connecting' first.
  queueMicrotask(connect);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearHeartbeat();
      clearReconnect();
      if (ws) {
        try {
          ws.onclose = null;
          ws.onerror = null;
          ws.onmessage = null;
          ws.onopen = null;
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      opts.onStatus('closed');
    },
  };
}
