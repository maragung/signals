// Public entry point for the indicator engine.
//
// `computeIndicator(config, candles)` is the single dispatcher used by the
// UI layer. Each `IndicatorKind` maps to a pure function in one of the
// module files; the dispatcher normalises the output into a uniform
// `IndicatorResult` with optional `overlay` / `separate` series.

import type { Candle, IndicatorConfig, IndicatorKind } from '@/types';
import { sanitizeCandles } from '@/core/utils/candles';

import {
  adx,
  ema,
  macd,
  sma,
  supertrend,
  vwap,
  wma,
  type ADXOutput,
  type MACDOutput,
  type SupertrendOutput,
} from './trend';
import {
  cci,
  mfi,
  roc,
  rsi,
  stochastic,
  stochRsi,
  williamsR,
  type StochRSIOutput,
  type StochasticOutput,
} from './momentum';
import {
  atr,
  bollingerBands,
  bollingerWidth,
  keltnerChannels,
  type BollingerBandsOutput,
  type KeltnerOutput,
} from './volatility';
import { cmf, obv, volume, volumeSma } from './volume';
import {
  numParam,
  type IndicatorNamedPoint,
  type IndicatorOutput,
  type IndicatorPoint,
  type IndicatorResult,
  type IndicatorSeries,
  type IndicatorNamedSeries,
} from './types';

export * from './types';
export * from './trend';
export * from './momentum';
export * from './volatility';
export * from './volume';

// ---------------------------------------------------------------------------
// Series construction helpers
// ---------------------------------------------------------------------------

function safe(v: number | undefined): number {
  return v === undefined || !Number.isFinite(v) ? NaN : v;
}

function toSeries(
  values: IndicatorOutput,
  candles: ReadonlyArray<Candle>,
  color: string | undefined,
  name?: string,
): IndicatorSeries {
  const out: IndicatorPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const point: IndicatorPoint = { time: c.time, value: safe(values[i]) };
    if (color !== undefined) point.color = color;
    if (name !== undefined) (point as IndicatorNamedPoint).name = name;
    out.push(point);
  }
  return out;
}

function toNamedSeries(
  values: IndicatorOutput,
  candles: ReadonlyArray<Candle>,
  color: string | undefined,
  name: string,
): IndicatorNamedSeries {
  const out: IndicatorNamedPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const point: IndicatorNamedPoint = { time: c.time, value: safe(values[i]), name };
    if (color !== undefined) point.color = color;
    out.push(point);
  }
  return out;
}

function toOverlay(
  series: ReadonlyArray<IndicatorOutput>,
  candles: ReadonlyArray<Candle>,
  color: string | undefined,
  names?: ReadonlyArray<string>,
): IndicatorSeries {
  const out: IndicatorPoint[] = [];
  for (let s = 0; s < series.length; s++) {
    const arr = series[s]!;
    const name = names?.[s];
    for (let i = 0; i < arr.length; i++) {
      const c = candles[i];
      if (!c) continue;
      const point: IndicatorPoint = { time: c.time, value: safe(arr[i]) };
      if (color !== undefined) point.color = color;
      if (name !== undefined) (point as IndicatorNamedPoint).name = name;
      out.push(point);
    }
  }
  return out;
}

/** Concatenate several named series into a single flat array. */
function concatNamedSeries(parts: ReadonlyArray<IndicatorNamedSeries>): IndicatorNamedSeries {
  let total = 0;
  for (const p of parts) total += p.length;
  const out: IndicatorNamedPoint[] = new Array(total);
  let idx = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[idx++] = p[i] as IndicatorNamedPoint;
  }
  return out;
}

function defaultPanel(kind: IndicatorKind): 'overlay' | 'separate' {
  switch (kind) {
    case 'sma':
    case 'ema':
    case 'wma':
    case 'vwap':
    case 'supertrend':
    case 'bbands':
    case 'bbwidth':
    case 'keltner':
      return 'overlay';
    case 'rsi':
    case 'stochrsi':
    case 'stoch':
    case 'cci':
    case 'roc':
    case 'williamsr':
    case 'mfi':
    case 'atr':
    case 'macd':
    case 'adx':
    case 'volume':
    case 'volumesma':
    case 'obv':
    case 'cmf':
      return 'separate';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'separate';
    }
  }
}

function buildSingleResult(
  config: IndicatorConfig,
  candles: ReadonlyArray<Candle>,
  values: IndicatorOutput,
  color: string | undefined,
  name?: string,
): IndicatorResult {
  const panel = config.panel ?? defaultPanel(config.kind);
  if (panel === 'overlay') {
    return {
      id: config.id,
      kind: config.kind,
      overlay: toSeries(values, candles, color, name),
    };
  }
  const series = toNamedSeries(
    values,
    candles,
    color,
    name ?? config.kind.toUpperCase(),
  );
  return {
    id: config.id,
    kind: config.kind,
    separate: concatNamedSeries([series]),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Compute the indicator described by `config` over the given candles and
 * return a normalised result. Candles are sanitized first to drop any
 * malformed entries; the original input array is not mutated.
 */
export function computeIndicator(
  config: IndicatorConfig,
  candles: ReadonlyArray<Candle>,
): IndicatorResult {
  const clean = sanitizeCandles(candles as Candle[]);
  const color = config.color;

  switch (config.kind) {
    case 'sma': {
      const period = numParam(config.params, 'period', 14);
      const out = sma(clean, period);
      return buildSingleResult(config, clean, out, color, 'SMA');
    }
    case 'ema': {
      const period = numParam(config.params, 'period', 14);
      const out = ema(clean, period);
      return buildSingleResult(config, clean, out, color, 'EMA');
    }
    case 'wma': {
      const period = numParam(config.params, 'period', 14);
      const out = wma(clean, period);
      return buildSingleResult(config, clean, out, color, 'WMA');
    }
    case 'vwap': {
      const out = vwap(clean);
      return buildSingleResult(config, clean, out, color, 'VWAP');
    }
    case 'macd': {
      const fast = numParam(config.params, 'fast', 12);
      const slow = numParam(config.params, 'slow', 26);
      const signal = numParam(config.params, 'signal', 9);
      const res: MACDOutput = macd(clean, fast, slow, signal);
      return {
        id: config.id,
        kind: config.kind,
        separate: concatNamedSeries([
          toNamedSeries(res.macd, clean, undefined, 'MACD'),
          toNamedSeries(res.signal, clean, undefined, 'Signal'),
          toNamedSeries(res.histogram, clean, undefined, 'Histogram'),
        ]),
        meta: { macd: res.macd, signal: res.signal, histogram: res.histogram },
      };
    }
    case 'adx': {
      const period = numParam(config.params, 'period', 14);
      const res: ADXOutput = adx(clean, period);
      return {
        id: config.id,
        kind: config.kind,
        separate: concatNamedSeries([
          toNamedSeries(res.adx, clean, undefined, 'ADX'),
          toNamedSeries(res.plusDI, clean, undefined, '+DI'),
          toNamedSeries(res.minusDI, clean, undefined, '-DI'),
        ]),
        meta: { adx: res.adx, plusDI: res.plusDI, minusDI: res.minusDI },
      };
    }
    case 'supertrend': {
      const period = numParam(config.params, 'period', 10);
      const multiplier = numParam(config.params, 'multiplier', 3);
      const res: SupertrendOutput = supertrend(clean, period, multiplier);
      return {
        id: config.id,
        kind: config.kind,
        overlay: toSeries(res.supertrend, clean, color, 'Supertrend'),
        meta: { direction: res.direction },
      };
    }
    case 'rsi': {
      const period = numParam(config.params, 'period', 14);
      const out = rsi(clean, period);
      return buildSingleResult(config, clean, out, color, 'RSI');
    }
    case 'stochrsi': {
      const rsiPeriod = numParam(config.params, 'rsiPeriod', 14);
      const kSmooth = numParam(config.params, 'kSmooth', 3);
      const dSmooth = numParam(config.params, 'dSmooth', 3);
      const res: StochRSIOutput = stochRsi(clean, rsiPeriod, kSmooth, dSmooth);
      return {
        id: config.id,
        kind: config.kind,
        separate: concatNamedSeries([
          toNamedSeries(res.k, clean, undefined, '%K'),
          toNamedSeries(res.d, clean, undefined, '%D'),
        ]),
        meta: { k: res.k, d: res.d },
      };
    }
    case 'stoch': {
      const kPeriod = numParam(config.params, 'kPeriod', 14);
      const dPeriod = numParam(config.params, 'dPeriod', 3);
      const smoothK = numParam(config.params, 'smoothK', 1);
      const res: StochasticOutput = stochastic(clean, kPeriod, dPeriod, smoothK);
      return {
        id: config.id,
        kind: config.kind,
        separate: concatNamedSeries([
          toNamedSeries(res.k, clean, undefined, '%K'),
          toNamedSeries(res.d, clean, undefined, '%D'),
        ]),
        meta: { k: res.k, d: res.d },
      };
    }
    case 'cci': {
      const period = numParam(config.params, 'period', 20);
      const out = cci(clean, period);
      return buildSingleResult(config, clean, out, color, 'CCI');
    }
    case 'roc': {
      const period = numParam(config.params, 'period', 10);
      const out = roc(clean, period);
      return buildSingleResult(config, clean, out, color, 'ROC');
    }
    case 'williamsr': {
      const period = numParam(config.params, 'period', 14);
      const out = williamsR(clean, period);
      return buildSingleResult(config, clean, out, color, 'Williams %R');
    }
    case 'mfi': {
      const period = numParam(config.params, 'period', 14);
      const out = mfi(clean, period);
      return buildSingleResult(config, clean, out, color, 'MFI');
    }
    case 'atr': {
      const period = numParam(config.params, 'period', 14);
      const out = atr(clean, period);
      return buildSingleResult(config, clean, out, color, 'ATR');
    }
    case 'bbands': {
      const period = numParam(config.params, 'period', 20);
      const multiplier = numParam(config.params, 'multiplier', 2);
      const res: BollingerBandsOutput = bollingerBands(clean, period, multiplier);
      return {
        id: config.id,
        kind: config.kind,
        overlay: toOverlay(
          [res.middle, res.upper, res.lower],
          clean,
          color,
          ['Middle', 'Upper', 'Lower'],
        ),
        meta: { middle: res.middle, upper: res.upper, lower: res.lower },
      };
    }
    case 'bbwidth': {
      const period = numParam(config.params, 'period', 20);
      const multiplier = numParam(config.params, 'multiplier', 2);
      const out = bollingerWidth(clean, period, multiplier);
      return buildSingleResult(config, clean, out, color, 'BB Width');
    }
    case 'keltner': {
      const period = numParam(config.params, 'period', 20);
      const multiplier = numParam(config.params, 'multiplier', 2);
      const atrPeriod = numParam(config.params, 'atrPeriod', 10);
      const res: KeltnerOutput = keltnerChannels(clean, period, multiplier, atrPeriod);
      return {
        id: config.id,
        kind: config.kind,
        overlay: toOverlay(
          [res.middle, res.upper, res.lower],
          clean,
          color,
          ['Middle', 'Upper', 'Lower'],
        ),
        meta: { middle: res.middle, upper: res.upper, lower: res.lower },
      };
    }
    case 'volume': {
      const out = volume(clean);
      return buildSingleResult(config, clean, out, color, 'Volume');
    }
    case 'volumesma': {
      const period = numParam(config.params, 'period', 20);
      const out = volumeSma(clean, period);
      return buildSingleResult(config, clean, out, color, 'Vol SMA');
    }
    case 'obv': {
      const out = obv(clean);
      return buildSingleResult(config, clean, out, color, 'OBV');
    }
    case 'cmf': {
      const period = numParam(config.params, 'period', 20);
      const out = cmf(clean, period);
      return buildSingleResult(config, clean, out, color, 'CMF');
    }
    default: {
      const _exhaustive: never = config.kind;
      void _exhaustive;
      return { id: config.id, kind: config.kind as IndicatorKind };
    }
  }
}
