import type { AlertItem, Candle, StrategySignal, MarketStructureEvent, SupportResistanceLevel, SupplyDemandZone } from '@/types';

export interface AlertContext {
  symbol: string;
  candles: Candle[];
  ticker: { price: number } | null;
  rsi?: number;
  prevRsi?: number;
  ema9?: number;
  ema21?: number;
  prevEma9?: number;
  prevEma21?: number;
  macd?: number;
  signal?: number;
  prevMacd?: number;
  prevSignal?: number;
  snr?: SupportResistanceLevel[];
  snd?: SupplyDemandZone[];
  structureEvents?: MarketStructureEvent[];
  signals?: StrategySignal[];
  lastPrice: number;
  prevPrice: number;
}

export interface AlertEvaluation {
  triggered: AlertItem[];
}

function crossUp(prev: number, curr: number, level: number): boolean {
  return prev <= level && curr > level;
}
function crossDown(prev: number, curr: number, level: number): boolean {
  return prev >= level && curr < level;
}

export function evaluateAlerts(alerts: AlertItem[], ctx: AlertContext): AlertEvaluation {
  const triggered: AlertItem[] = [];
  for (const a of alerts) {
    if (!a.active) continue;
    if (a.symbol !== ctx.symbol) continue;
    let hit = false;
    switch (a.kind) {
      case 'price-cross': {
        const level = Number(a.params.level);
        if (Number.isFinite(level)) {
          hit = crossUp(ctx.prevPrice, ctx.lastPrice, level) || crossDown(ctx.prevPrice, ctx.lastPrice, level);
        }
        break;
      }
      case 'break-resistance': {
        const level = Number(a.params.level);
        if (Number.isFinite(level) && ctx.snr) {
          const r = ctx.snr.find((s) => s.type === 'resistance' && Math.abs(s.price - level) / level < 0.005);
          if (r && ctx.lastPrice > r.price && ctx.prevPrice <= r.price) hit = true;
        }
        break;
      }
      case 'break-support': {
        const level = Number(a.params.level);
        if (Number.isFinite(level) && ctx.snr) {
          const s = ctx.snr.find((s) => s.type === 'support' && Math.abs(s.price - level) / level < 0.005);
          if (s && ctx.lastPrice < s.price && ctx.prevPrice >= s.price) hit = true;
        }
        break;
      }
      case 'rsi-threshold': {
        const level = Number(a.params.level);
        const direction = String(a.params.direction || 'above');
        const r = ctx.rsi;
        const prevR = ctx.prevRsi;
        if (Number.isFinite(level) && r !== undefined && prevR !== undefined) {
          if (direction === 'above' && crossUp(prevR, r, level)) hit = true;
          if (direction === 'below' && crossDown(prevR, r, level)) hit = true;
        }
        break;
      }
      case 'macd-crossover': {
        if (
          ctx.macd !== undefined && ctx.signal !== undefined &&
          ctx.prevMacd !== undefined && ctx.prevSignal !== undefined
        ) {
          if (crossUp(ctx.prevMacd, ctx.macd, ctx.prevSignal) && ctx.macd > ctx.signal) hit = true;
          if (crossDown(ctx.prevMacd, ctx.macd, ctx.prevSignal) && ctx.macd < ctx.signal) hit = true;
        }
        break;
      }
      case 'ema-crossover': {
        if (
          ctx.ema9 !== undefined && ctx.ema21 !== undefined &&
          ctx.prevEma9 !== undefined && ctx.prevEma21 !== undefined
        ) {
          if (crossUp(ctx.prevEma9, ctx.ema9, ctx.prevEma21)) hit = true;
          if (crossDown(ctx.prevEma9, ctx.ema9, ctx.prevEma21)) hit = true;
        }
        break;
      }
      case 'bos':
      case 'choch': {
        if (ctx.structureEvents && ctx.structureEvents.length > 0) {
          const last = ctx.structureEvents[ctx.structureEvents.length - 1]!;
          const lastCandleTime = ctx.candles[ctx.candles.length - 1]?.time;
          if (
            (a.kind === 'bos' ? 'BOS' : 'CHOCH') === last.kind &&
            lastCandleTime !== undefined &&
            last.time === lastCandleTime
          ) {
            hit = true;
          }
        }
        break;
      }
      case 'supply-entry':
      case 'demand-entry': {
        if (ctx.snd) {
          const want = a.kind === 'supply-entry' ? 'supply' : 'demand';
          for (const z of ctx.snd) {
            if (z.type === want && z.status === 'fresh' && ctx.lastPrice >= z.low && ctx.lastPrice <= z.high) {
              hit = true;
              break;
            }
          }
        }
        break;
      }
      case 'strategy-signal': {
        if (ctx.signals) {
          const last = ctx.signals[ctx.signals.length - 1];
          if (last && last.time === ctx.candles[ctx.candles.length - 1]?.time) hit = true;
        }
        break;
      }
    }
    if (hit) triggered.push(a);
  }
  return { triggered };
}

export async function notifyBrowser(title: string, body: string): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/favicon.ico' });
    } catch {
      // some browsers block
    }
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }
  return Notification.permission;
}
