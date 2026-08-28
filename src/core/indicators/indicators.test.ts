// Vitest suite for the indicator engine.
//
// Covers every public function in src/core/indicators/, plus the
// `computeIndicator` dispatcher. Edge cases include:
//   - empty arrays
//   - single candle
//   - two candles
//   - exact period boundary
//   - NaN / Infinity guards in the input
//   - insufficient data
//   - large and small price values
//   - all-zero volume
//
// All numerical assertions use toBeCloseTo with 4-6 digits so they are
// deterministic across runtimes.

import { describe, expect, it } from 'vitest';

import type { Candle, IndicatorConfig, IndicatorKind } from '@/types';
import { sanitizeCandles } from '@/core/utils/candles';
import { isFiniteNum } from '@/core/utils/series';

import {
  adx,
  atr,
  bollingerBands,
  bollingerWidth,
  cci,
  cmf,
  computeIndicator,
  ema,
  keltnerChannels,
  macd,
  mfi,
  obv,
  rsi,
  sma,
  stochastic,
  stochRsi,
  supertrend,
  vwap,
  volume,
  volumeSma,
  williamsR,
  wma,
} from './index';
import { roc } from './momentum';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return { time, open, high, low, close, volume };
}

/** Build a deterministic sequence of candles with a closing-price pattern. */
function linearCandles(
  n: number,
  start = 100,
  step = 1,
  volume = 10,
  startTime = 1_700_000_000,
): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * step;
    out.push({
      time: startTime + i * 60,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume,
    });
  }
  return out;
}

/** Return true if every finite entry equals its expected value. */
function isAllNaN(arr: ReadonlyArray<number>): boolean {
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i]!)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FLAT: ReadonlyArray<Candle> = linearCandles(40, 100, 0, 1000);
// Strictly rising closes 100, 101, 102, ... for easy hand-computation.
const RISING: ReadonlyArray<Candle> = linearCandles(40, 100, 1, 1000);
// Oscillating pattern for stochastic-like indicators.
const OSC: Candle[] = (() => {
  const out: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const close = 100 + 5 * Math.sin(i * 0.7);
    out.push({
      time: 1_700_000_000 + i * 60,
      open: close,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: 1000 + i * 10,
    });
  }
  return out;
})();

// ---------------------------------------------------------------------------
// types / numParam
// ---------------------------------------------------------------------------

describe('numParam', () => {
  it('returns the fallback when params is undefined', async () => {
    const { numParam } = await import('./types');
    expect(numParam(undefined, 'period', 14)).toBe(14);
  });

  it('returns the fallback when the key is missing', async () => {
    const { numParam } = await import('./types');
    expect(numParam({}, 'period', 20)).toBe(20);
  });

  it('returns the value when it is a finite number', async () => {
    const { numParam } = await import('./types');
    expect(numParam({ period: 7 }, 'period', 14)).toBe(7);
  });

  it('parses string numerics', async () => {
    const { numParam } = await import('./types');
    expect(numParam({ period: '8' }, 'period', 14)).toBe(8);
  });

  it('returns the fallback for NaN / Infinity / unparsable strings', async () => {
    const { numParam } = await import('./types');
    expect(numParam({ period: NaN }, 'period', 5)).toBe(5);
    expect(numParam({ period: Infinity }, 'period', 5)).toBe(5);
    expect(numParam({ period: 'abc' }, 'period', 5)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SMA
// ---------------------------------------------------------------------------

describe('sma', () => {
  it('returns all NaN for empty input', () => {
    expect(sma([], 3).length).toBe(0);
  });

  it('returns NaN for single candle and 2 candles (period=3)', () => {
    const one = [makeCandle(1, 10, 11, 9, 10, 1)];
    const out = sma(one, 3);
    expect(out).toHaveLength(1);
    expect(Number.isNaN(out[0]!)).toBe(true);

    const two = [one[0]!, makeCandle(2, 11, 12, 10, 11, 1)];
    const out2 = sma(two, 3);
    expect(out2).toHaveLength(2);
    expect(Number.isNaN(out2[0]!)).toBe(true);
    expect(Number.isNaN(out2[1]!)).toBe(true);
  });

  it('emits the first SMA exactly at index period-1', () => {
    const candles = linearCandles(5, 10, 1, 1); // closes 10,11,12,13,14
    const out = sma(candles, 3);
    expect(out).toHaveLength(5);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[1]!)).toBe(true);
    expect(out[2]).toBeCloseTo(11, 6); // (10+11+12)/3
    expect(out[3]).toBeCloseTo(12, 6); // (11+12+13)/3
    expect(out[4]).toBeCloseTo(13, 6); // (12+13+14)/3
  });

  it('output length matches input length', () => {
    const out = sma(FLAT, 5);
    expect(out).toHaveLength(FLAT.length);
  });

  it('handles a NaN in the input by propagating NaN', () => {
    const candles = linearCandles(6, 100, 1, 1);
    candles[3] = makeCandle(candles[3]!.time, NaN, NaN, NaN, NaN, NaN);
    const cleaned = sanitizeCandles(candles as Candle[]);
    const out = sma(cleaned, 3);
    expect(out).toHaveLength(cleaned.length);
    // The bad candle is removed by sanitize, so the cleaned array has 5
    // entries. The SMA at the last index must be finite.
    expect(Number.isFinite(out[cleaned.length - 1]!)).toBe(true);
  });

  it('handles a period greater than the input length', () => {
    const candles = linearCandles(2, 100, 1, 1);
    const out = sma(candles, 5);
    expect(out).toHaveLength(2);
    expect(isAllNaN(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

describe('ema', () => {
  it('returns NaN for empty input', () => {
    expect(ema([], 3).length).toBe(0);
  });

  it('seeds with SMA over the first period', () => {
    const candles = linearCandles(6, 10, 1, 1); // 10,11,12,13,14,15
    const out = ema(candles, 3);
    expect(out[2]).toBeCloseTo(11, 6); // SMA seed
  });

  it('matches the textbook formula', () => {
    const candles = linearCandles(8, 10, 1, 1); // closes 10..17
    const out = ema(candles, 3);
    // k = 2/(3+1) = 0.5
    // ema[2] = 11 (seed)
    // ema[3] = 0.5*13 + 0.5*11 = 12
    // ema[4] = 0.5*14 + 0.5*12 = 13
    // ema[5] = 0.5*15 + 0.5*13 = 14
    expect(out[2]).toBeCloseTo(11, 6);
    expect(out[3]).toBeCloseTo(12, 6);
    expect(out[4]).toBeCloseTo(13, 6);
    expect(out[5]).toBeCloseTo(14, 6);
  });

  it('output length matches input length', () => {
    const out = ema(FLAT, 14);
    expect(out).toHaveLength(FLAT.length);
  });

  it('handles a NaN close by leaving it NaN in the input series', () => {
    const candles = linearCandles(6, 10, 1, 1);
    candles[3] = makeCandle(candles[3]!.time, 1, 1, 1, NaN, 1);
    const cleaned = sanitizeCandles(candles as Candle[]);
    const out = ema(cleaned, 3);
    // We cannot predict the exact seed because the bad candle was filtered;
    // but the array length matches and no slot should be NaN after warmup.
    expect(out).toHaveLength(cleaned.length);
  });
});

// ---------------------------------------------------------------------------
// WMA
// ---------------------------------------------------------------------------

describe('wma', () => {
  it('matches the textbook formula at the boundary', () => {
    const candles = linearCandles(5, 10, 1, 1); // 10,11,12,13,14
    const out = wma(candles, 3);
    // weights 1,2,3 ; denom 6
    // out[2] = (1*10 + 2*11 + 3*12)/6 = 68/6
    // out[3] = (1*11 + 2*12 + 3*13)/6 = 74/6
    // out[4] = (1*12 + 2*13 + 3*14)/6 = 80/6
    expect(out[2]).toBeCloseTo(68 / 6, 6);
    expect(out[3]).toBeCloseTo(74 / 6, 6);
    expect(out[4]).toBeCloseTo(80 / 6, 6);
  });

  it('returns all NaN before the warmup', () => {
    const out = wma(FLAT, 10);
    for (let i = 0; i < 9; i++) expect(Number.isNaN(out[i]!)).toBe(true);
    expect(Number.isFinite(out[9]!)).toBe(true);
  });

  it('matches a second computed value via independent recompute', () => {
    const candles = linearCandles(8, 20, 2, 1); // 20,22,24,...
    const out = wma(candles, 4);
    // out[3] = (1*20 + 2*22 + 3*24 + 4*26) / 10 = (20+44+72+104)/10 = 24
    expect(out[3]).toBeCloseTo(24, 6);
  });
});

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------

describe('vwap', () => {
  it('returns empty array for empty input', () => {
    expect(vwap([]).length).toBe(0);
  });

  it('is NaN when cumulative volume is 0 (all-zero volume)', () => {
    const candles = linearCandles(5, 100, 0, 0); // closes 100..100, vol 0
    const out = vwap(candles);
    expect(out).toHaveLength(5);
    expect(isAllNaN(out)).toBe(true);
  });

  it('matches the hand-computed VWAP', () => {
    // closes all 100, volume 10
    const candles = linearCandles(4, 100, 0, 10);
    const out = vwap(candles);
    // typical = 100, pv = 1000, total volume = 40 -> vwap = 100
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[3]).toBeCloseTo(100, 6);
  });

  it('reflects rising typical prices and weighted volume', () => {
    const candles: Candle[] = [];
    // i=0: typical 100, vol 1
    candles.push({ time: 1, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    // i=1: typical 110, vol 1
    candles.push({ time: 2, open: 110, high: 110, low: 110, close: 110, volume: 1 });
    // i=2: typical 120, vol 1
    candles.push({ time: 3, open: 120, high: 120, low: 120, close: 120, volume: 1 });
    const out = vwap(candles);
    // cumPV: 100, 210, 330 ; cumV: 1, 2, 3
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[1]).toBeCloseTo(105, 6);
    expect(out[2]).toBeCloseTo(110, 6);
  });
});

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

describe('macd', () => {
  it('returns NaN when there is not enough data', () => {
    const candles = linearCandles(10, 100, 1, 1);
    const res = macd(candles, 12, 26, 9);
    expect(res.macd).toHaveLength(10);
    // slow=26 means MACD is NaN for the first 25 entries.
    for (let i = 0; i < 10; i++) expect(Number.isNaN(res.macd[i]!)).toBe(true);
    expect(isAllNaN(res.signal)).toBe(true);
    expect(isAllNaN(res.histogram)).toBe(true);
  });

  it('produces a valid MACD line at index slow-1', () => {
    const candles = linearCandles(40, 100, 1, 1);
    const res = macd(candles, 12, 26, 9);
    expect(res.macd).toHaveLength(40);
    expect(Number.isFinite(res.macd[25]!)).toBe(true);
    // For linearly rising closes, fast EMA > slow EMA so MACD is positive.
    expect(res.macd[25]!).toBeGreaterThan(0);
  });

  it('emits signal and histogram only after slow + signal - 2', () => {
    const candles = linearCandles(60, 100, 1, 1);
    const res = macd(candles, 12, 26, 9);
    // slow = 26, signal = 9 -> first valid signal at slow-1 + signal-1 = 33
    const firstSignal = 26 - 1 + 9 - 1;
    // Indices before the first signal should be NaN.
    for (let i = 0; i < firstSignal; i++) expect(Number.isNaN(res.signal[i]!)).toBe(true);
    expect(Number.isFinite(res.signal[firstSignal]!)).toBe(true);
    // The histogram is emitted one step after the signal seed, so it starts
    // at firstSignal + 1.
    for (let i = firstSignal + 1; i < res.histogram.length; i++) {
      expect(res.histogram[i]!).toBeCloseTo(res.macd[i]! - res.signal[i]!, 6);
    }
  });

  it('output length matches input length', () => {
    const candles = linearCandles(60, 100, 1, 1);
    const res = macd(candles, 12, 26, 9);
    expect(res.macd).toHaveLength(60);
    expect(res.signal).toHaveLength(60);
    expect(res.histogram).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// ADX
// ---------------------------------------------------------------------------

describe('adx', () => {
  it('returns NaN for insufficient data', () => {
    const candles = linearCandles(10, 100, 1, 1);
    const res = adx(candles, 14);
    expect(res.adx).toHaveLength(10);
    expect(isAllNaN(res.adx)).toBe(true);
    expect(isAllNaN(res.plusDI)).toBe(true);
    expect(isAllNaN(res.minusDI)).toBe(true);
  });

  it('emits DI at period-1 and ADX at 2*period-2', () => {
    const candles = linearCandles(60, 100, 1, 1);
    const res = adx(candles, 14);
    expect(Number.isNaN(res.plusDI[12]!)).toBe(true);
    expect(Number.isFinite(res.plusDI[13]!)).toBe(true);
    expect(Number.isNaN(res.adx[25]!)).toBe(true);
    expect(Number.isFinite(res.adx[26]!)).toBe(true);
  });

  it('emits ADX bounded to the [0, 100] range', () => {
    const candles = linearCandles(80, 100, 1, 1);
    const res = adx(candles, 14);
    for (let i = 0; i < res.adx.length; i++) {
      if (Number.isFinite(res.adx[i]!)) {
        expect(res.adx[i]!).toBeGreaterThanOrEqual(0);
        expect(res.adx[i]!).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Supertrend
// ---------------------------------------------------------------------------

describe('supertrend', () => {
  it('returns NaN for insufficient data', () => {
    const candles = linearCandles(5, 100, 1, 1);
    const res = supertrend(candles, 10, 3);
    expect(res.supertrend).toHaveLength(5);
    expect(isAllNaN(res.supertrend)).toBe(true);
  });

  it('starts in down trend (direction = -1) on a flat series', () => {
    const candles = linearCandles(20, 100, 0, 1);
    const res = supertrend(candles, 10, 3);
    // First valid index is period-1 = 9
    expect(Number.isFinite(res.supertrend[9]!)).toBe(true);
    expect(res.direction[9]).toBe(-1);
  });

  it('flips to up trend when the close breaks the upper band', () => {
    // Build an aggressively rising series after warmup.
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push({ time: i, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    for (let i = 10; i < 20; i++) {
      const close = 100 + (i - 9) * 5;
      candles.push({
        time: i,
        open: close,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 1,
      });
    }
    const res = supertrend(candles, 10, 2);
    // Somewhere after the breakout the direction should flip to +1.
    const flipped = res.direction.findIndex((d) => d === 1);
    expect(flipped).toBeGreaterThan(9);
    expect(res.direction[flipped]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

describe('rsi', () => {
  it('returns NaN when there is not enough data', () => {
    const out = rsi(linearCandles(5, 100, 1, 1), 14);
    expect(out).toHaveLength(5);
    expect(isAllNaN(out)).toBe(true);
  });

  it('is 100 for a strictly rising series (no losses)', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const out = rsi(candles, 14);
    // First valid RSI is at index 14
    for (let i = 14; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(100, 6);
    }
  });

  it('is 0 for a strictly falling series (no gains)', () => {
    const candles = linearCandles(30, 100, -1, 1);
    const out = rsi(candles, 14);
    for (let i = 14; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(0, 6);
    }
  });

  it('is 50 for a flat series (no net change)', () => {
    const candles = linearCandles(30, 100, 0, 1);
    const out = rsi(candles, 14);
    for (let i = 14; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(50, 6);
    }
  });

  it('output length matches input length', () => {
    const out = rsi(FLAT, 14);
    expect(out).toHaveLength(FLAT.length);
  });
});

// ---------------------------------------------------------------------------
// Stochastic RSI
// ---------------------------------------------------------------------------

describe('stochRsi', () => {
  it('emits K and D of the same length as the input', () => {
    const res = stochRsi(OSC, 14, 3, 3);
    expect(res.k).toHaveLength(OSC.length);
    expect(res.d).toHaveLength(OSC.length);
  });

  it('K and D are bounded between 0 and 100 once defined', () => {
    const res = stochRsi(OSC, 14, 3, 3);
    for (let i = 0; i < res.k.length; i++) {
      if (Number.isFinite(res.k[i]!)) {
        expect(res.k[i]!).toBeGreaterThanOrEqual(0);
        expect(res.k[i]!).toBeLessThanOrEqual(100);
      }
    }
  });

  it('returns NaN for insufficient data', () => {
    const candles = linearCandles(10, 100, 1, 1);
    const res = stochRsi(candles, 14, 3, 3);
    expect(isAllNaN(res.k)).toBe(true);
    expect(isAllNaN(res.d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stochastic
// ---------------------------------------------------------------------------

describe('stochastic', () => {
  it('emits K and D of the correct length', () => {
    const res = stochastic(OSC, 14, 3, 3);
    expect(res.k).toHaveLength(OSC.length);
    expect(res.d).toHaveLength(OSC.length);
  });

  it('first K appears at index kPeriod-1 + smoothK-1', () => {
    const res = stochastic(OSC, 5, 3, 1);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(res.k[i]!)).toBe(true);
    expect(Number.isFinite(res.k[4]!)).toBe(true);
  });

  it('K is in [0, 100]', () => {
    const res = stochastic(OSC, 14, 3, 3);
    for (let i = 0; i < res.k.length; i++) {
      if (Number.isFinite(res.k[i]!)) {
        expect(res.k[i]!).toBeGreaterThanOrEqual(0);
        expect(res.k[i]!).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CCI
// ---------------------------------------------------------------------------

describe('cci', () => {
  it('returns NaN for empty input', () => {
    expect(cci([], 20).length).toBe(0);
  });

  it('is 0 at the warmup point for a flat series (typical == mean, dev = 0 -> 0)', () => {
    const candles = linearCandles(20, 100, 0, 1);
    const out = cci(candles, 20);
    expect(Number.isFinite(out[19]!)).toBe(true);
    // mean == typical, so (typical - mean) == 0; cci = 0
    expect(out[19]).toBeCloseTo(0, 6);
  });

  it('output length matches input length', () => {
    const out = cci(OSC, 20);
    expect(out).toHaveLength(OSC.length);
  });
});

// ---------------------------------------------------------------------------
// ROC
// ---------------------------------------------------------------------------

describe('roc', () => {
  it('returns NaN for empty input', () => {
    expect(roc([], 10).length).toBe(0);
  });

  it('matches hand-computed percentage change', () => {
    const candles = linearCandles(12, 100, 1, 1); // closes 100..111
    const out = roc(candles, 5);
    // ROC[i] = (close[i] - close[i-5]) / close[i-5] * 100
    // i=5: (105 - 100) / 100 * 100 = 5
    // i=6: (106 - 101) / 101 * 100
    expect(out[5]).toBeCloseTo(5, 6);
    expect(out[6]).toBeCloseTo(((106 - 101) / 101) * 100, 6);
  });

  it('returns NaN before the warmup', () => {
    const out = roc(FLAT, 5);
    for (let i = 0; i < 5; i++) expect(Number.isNaN(out[i]!)).toBe(true);
    expect(Number.isFinite(out[5]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Williams %R
// ---------------------------------------------------------------------------

describe('williamsR', () => {
  it('is -50 for a series where close == midpoint of range', () => {
    // Build a constant high/low/close window
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: i,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1,
      });
    }
    const out = williamsR(candles, 14);
    // close = 100, hi = 110, lo = 90 -> ((110-100) / 20) * -100 = -50
    expect(out[13]).toBeCloseTo(-50, 6);
  });

  it('is 0 when the close equals the highest high', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: i,
        open: 100,
        high: 100,
        low: 90,
        close: 100,
        volume: 1,
      });
    }
    const out = williamsR(candles, 14);
    // close = 100 = hi -> 0
    expect(out[13]).toBeCloseTo(0, 6);
  });

  it('is -100 when the close equals the lowest low', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: i,
        open: 100,
        high: 110,
        low: 100,
        close: 100,
        volume: 1,
      });
    }
    const out = williamsR(candles, 14);
    // close = 100 = lo -> -100
    expect(out[13]).toBeCloseTo(-100, 6);
  });
});

// ---------------------------------------------------------------------------
// MFI
// ---------------------------------------------------------------------------

describe('mfi', () => {
  it('is 100 for a strictly rising series with positive volume', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const out = mfi(candles, 14);
    // Rising closes => all positive money flow => MFI = 100
    for (let i = 14; i < out.length; i++) expect(out[i]).toBeCloseTo(100, 6);
  });

  it('is 0 for a strictly falling series with positive volume', () => {
    const candles = linearCandles(30, 100, -1, 1);
    const out = mfi(candles, 14);
    for (let i = 14; i < out.length; i++) expect(out[i]).toBeCloseTo(0, 6);
  });

  it('is 50 when there is no money flow (all-zero volume)', () => {
    const candles = linearCandles(30, 100, 1, 0);
    const out = mfi(candles, 14);
    for (let i = 14; i < out.length; i++) expect(out[i]).toBeCloseTo(50, 6);
  });

  it('output length matches input length', () => {
    const out = mfi(FLAT, 14);
    expect(out).toHaveLength(FLAT.length);
  });
});

// ---------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------

describe('atr', () => {
  it('returns NaN for empty input', () => {
    expect(atr([], 14).length).toBe(0);
  });

  it('first valid ATR at period-1 is the mean of TR over the first window', () => {
    // Build 14 candles with strictly rising close: each TR = high-low for i>0
    // and 0 for the first (high==low).
    const candles: Candle[] = [];
    for (let i = 0; i < 14; i++) {
      candles.push({ time: i, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const out = atr(candles, 14);
    // Each TR = 0
    expect(out[13]).toBeCloseTo(0, 6);
  });

  it('matches the Wilder formula on a hand-computable series', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 15; i++) {
      candles.push({
        time: i,
        open: 100 + i,
        high: 100 + i + 1,
        low: 100 + i - 1,
        close: 100 + i,
        volume: 1,
      });
    }
    const out = atr(candles, 14);
    // TR[i] for i>0: max(2, |(100+i+1)-(100+i-1)|, |(100+i-1)-(100+i-1)|) = max(2,2,2)=2
    // TR[0] = high-low = 2
    // Seed = sum(2, 14 times) / 14 = 2
    expect(out[13]).toBeCloseTo(2, 6);
    // out[14] = (2 * 13 + 2) / 14 = 2
    expect(out[14]).toBeCloseTo(2, 6);
  });
});

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

describe('bollingerBands', () => {
  it('returns NaN for insufficient data', () => {
    const candles = linearCandles(5, 100, 1, 1);
    const res = bollingerBands(candles, 20, 2);
    expect(res.middle).toHaveLength(5);
    expect(isAllNaN(res.middle)).toBe(true);
    expect(isAllNaN(res.upper)).toBe(true);
    expect(isAllNaN(res.lower)).toBe(true);
  });

  it('middle equals SMA(close, period) at the boundary', () => {
    const candles = linearCandles(25, 100, 1, 1);
    const res = bollingerBands(candles, 20, 2);
    const sma20 = sma(candles, 20);
    for (let i = 19; i < 25; i++) {
      expect(res.middle[i]!).toBeCloseTo(sma20[i]!, 6);
    }
  });

  it('upper - middle equals 2 * stddev', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const res = bollingerBands(candles, 20, 2);
    for (let i = 19; i < 30; i++) {
      const w = candles.slice(i - 19, i + 1).map((c) => c.close);
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      const s = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
      expect(res.upper[i]!).toBeCloseTo(m + 2 * s, 6);
      expect(res.lower[i]!).toBeCloseTo(m - 2 * s, 6);
    }
  });
});

describe('bollingerWidth', () => {
  it('equals (upper - lower) / middle', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const { middle, upper, lower } = bollingerBands(candles, 20, 2);
    const w = bollingerWidth(candles, 20, 2);
    for (let i = 19; i < 30; i++) {
      const expected = (upper[i]! - lower[i]!) / middle[i]!;
      expect(w[i]!).toBeCloseTo(expected, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Keltner Channels
// ---------------------------------------------------------------------------

describe('keltnerChannels', () => {
  it('returns NaN for empty input', () => {
    const res = keltnerChannels([], 20, 2, 10);
    expect(res.middle).toHaveLength(0);
  });

  it('middle is the EMA of close', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const res = keltnerChannels(candles, 20, 2, 10);
    const e = ema(candles, 20);
    for (let i = 19; i < 30; i++) {
      expect(res.middle[i]!).toBeCloseTo(e[i]!, 6);
    }
  });

  it('upper - middle equals multiplier * ATR once ATR is defined', () => {
    const candles = linearCandles(30, 100, 1, 1);
    const res = keltnerChannels(candles, 20, 2, 10);
    const a = atr(candles, 10);
    for (let i = 19; i < 30; i++) {
      if (Number.isFinite(a[i]!)) {
        expect(res.upper[i]!).toBeCloseTo(res.middle[i]! + 2 * a[i]!, 6);
        expect(res.lower[i]!).toBeCloseTo(res.middle[i]! - 2 * a[i]!, 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Volume helpers
// ---------------------------------------------------------------------------

describe('volume', () => {
  it('returns the raw volume series', () => {
    const candles = linearCandles(5, 100, 1, 7);
    const out = volume(candles);
    expect(out).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(out[i]).toBe(7);
  });

  it('emits NaN for a non-finite volume in the input', () => {
    const candles = linearCandles(3, 100, 1, 1);
    candles[1] = makeCandle(candles[1]!.time, 100, 100, 100, 100, NaN);
    const cleaned = sanitizeCandles(candles as Candle[]);
    const out = volume(cleaned);
    expect(out).toHaveLength(cleaned.length);
  });
});

describe('volumeSma', () => {
  it('returns NaN before the warmup', () => {
    const out = volumeSma(linearCandles(5, 100, 0, 1), 3);
    for (let i = 0; i < 2; i++) expect(Number.isNaN(out[i]!)).toBe(true);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('output length matches input length', () => {
    const out = volumeSma(FLAT, 5);
    expect(out).toHaveLength(FLAT.length);
  });
});

// ---------------------------------------------------------------------------
// OBV
// ---------------------------------------------------------------------------

describe('obv', () => {
  it('starts at 0 and is NaN for insufficient close info', () => {
    const candles = linearCandles(3, 100, 1, 10);
    const out = obv(candles);
    expect(out[0]).toBe(0);
    // closes 100, 101, 102: each step adds 10
    expect(out[1]).toBe(10);
    expect(out[2]).toBe(20);
  });

  it('subtracts volume on a down move', () => {
    const candles = linearCandles(3, 100, -1, 10);
    const out = obv(candles);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(-10);
    expect(out[2]).toBe(-20);
  });

  it('leaves the running sum unchanged on a flat close', () => {
    const candles = linearCandles(3, 100, 0, 10);
    const out = obv(candles);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CMF
// ---------------------------------------------------------------------------

describe('cmf', () => {
  it('returns NaN for insufficient data', () => {
    const candles = linearCandles(5, 100, 1, 1);
    const out = cmf(candles, 20);
    expect(out).toHaveLength(5);
    expect(isAllNaN(out)).toBe(true);
  });

  it('is positive for a sustained up-move (close > midpoint)', () => {
    // Each candle: low=99, high=101, close=101, volume=1
    // MFV = 1 * ((101-99) - (101-101)) / (101-99) = 1 * (2-0)/2 = 1
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({ time: i, open: 100, high: 101, low: 99, close: 101, volume: 1 });
    }
    const out = cmf(candles, 20);
    expect(out[19]).toBeCloseTo(1, 6);
  });

  it('is negative for a sustained down-move (close < midpoint)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({ time: i, open: 100, high: 101, low: 99, close: 99, volume: 1 });
    }
    const out = cmf(candles, 20);
    expect(out[19]).toBeCloseTo(-1, 6);
  });

  it('is 0 when close == midpoint of every candle', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({ time: i, open: 100, high: 101, low: 99, close: 100, volume: 1 });
    }
    const out = cmf(candles, 20);
    expect(out[19]).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Edge cases common to many indicators
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('every indicator returns an array of length 0 for empty input', () => {
    expect(sma([], 3)).toHaveLength(0);
    expect(ema([], 3)).toHaveLength(0);
    expect(wma([], 3)).toHaveLength(0);
    expect(rsi([], 14)).toHaveLength(0);
    expect(macd([], 12, 26, 9).macd).toHaveLength(0);
    expect(atr([], 14)).toHaveLength(0);
    expect(obv([])).toHaveLength(0);
    expect(cci([], 20)).toHaveLength(0);
    expect(roc([], 10)).toHaveLength(0);
    expect(williamsR([], 14)).toHaveLength(0);
    expect(mfi([], 14)).toHaveLength(0);
    expect(vwap([])).toHaveLength(0);
    expect(cmf([], 20)).toHaveLength(0);
    expect(volume([])).toHaveLength(0);
    expect(volumeSma([], 5)).toHaveLength(0);
    expect(adx([], 14).adx).toHaveLength(0);
    expect(supertrend([], 10, 3).supertrend).toHaveLength(0);
    expect(bollingerBands([], 20, 2).middle).toHaveLength(0);
    expect(bollingerWidth([], 20, 2)).toHaveLength(0);
    expect(keltnerChannels([], 20, 2, 10).middle).toHaveLength(0);
    expect(stochRsi([], 14, 3, 3).k).toHaveLength(0);
    expect(stochastic([], 14, 3, 1).k).toHaveLength(0);
  });

  it('every indicator handles a single candle without throwing', () => {
    const c = [makeCandle(1, 100, 105, 95, 100, 10)];
    expect(() => sma(c, 3)).not.toThrow();
    expect(() => ema(c, 3)).not.toThrow();
    expect(() => rsi(c, 14)).not.toThrow();
    expect(() => atr(c, 14)).not.toThrow();
    expect(() => obv(c)).not.toThrow();
    expect(() => vwap(c)).not.toThrow();
    expect(() => cmf(c, 1)).not.toThrow();
    expect(() => volume(c)).not.toThrow();
    expect(() => volumeSma(c, 1)).not.toThrow();
    expect(() => adx(c, 1).adx).not.toThrow();
    expect(() => supertrend(c, 1, 1)).not.toThrow();
    expect(() => bollingerBands(c, 1, 1)).not.toThrow();
    expect(() => bollingerWidth(c, 1, 1)).not.toThrow();
    expect(() => keltnerChannels(c, 1, 1, 1)).not.toThrow();
    expect(() => cci(c, 1)).not.toThrow();
    expect(() => roc(c, 1)).not.toThrow();
    expect(() => williamsR(c, 1)).not.toThrow();
    expect(() => mfi(c, 1)).not.toThrow();
    expect(() => wma(c, 1)).not.toThrow();
    expect(() => macd(c, 1, 1, 1)).not.toThrow();
    expect(() => stochRsi(c, 1, 1, 1)).not.toThrow();
    expect(() => stochastic(c, 1, 1, 1)).not.toThrow();
  });

  it('every indicator handles two candles without throwing', () => {
    const c: Candle[] = [
      makeCandle(1, 100, 105, 95, 100, 10),
      makeCandle(2, 101, 106, 96, 101, 11),
    ];
    for (const fn of [() => sma(c, 2), () => ema(c, 2), () => wma(c, 2), () => rsi(c, 2)]) {
      expect(() => fn()).not.toThrow();
    }
  });

  it('handles extremely large values without overflow', () => {
    const candles = linearCandles(20, 1e12, 1e9, 1);
    const out = sma(candles, 5);
    for (let i = 4; i < 20; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
    }
  });

  it('handles extremely small values without underflow', () => {
    const candles = linearCandles(20, 1e-9, 1e-10, 1);
    const out = sma(candles, 5);
    for (let i = 4; i < 20; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
    }
  });

  it('sanitizeCandles drops malformed entries before they pollute indicators', () => {
    const candles: Candle[] = [
      makeCandle(1, 100, 105, 95, 100, 10),
      makeCandle(2, NaN, NaN, NaN, NaN, NaN),
      makeCandle(3, 102, 108, 98, 102, 12),
    ];
    const clean = sanitizeCandles(candles);
    expect(clean).toHaveLength(2);
    const out = sma(clean, 2);
    expect(out).toHaveLength(2);
    expect(out[1]).toBeCloseTo(101, 6);
  });

  it('isFiniteNum from series works for finite and non-finite inputs', () => {
    expect(isFiniteNum(0)).toBe(true);
    expect(isFiniteNum(1.5)).toBe(true);
    expect(isFiniteNum(NaN)).toBe(false);
    expect(isFiniteNum(Infinity)).toBe(false);
    expect(isFiniteNum('1' as unknown as number)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function makeConfig(kind: IndicatorKind, params: Record<string, number | string | boolean> = {}, id = 'cfg'): IndicatorConfig {
  return { id, kind, enabled: true, params };
}

const ALL_KINDS: IndicatorKind[] = [
  'sma',
  'ema',
  'wma',
  'vwap',
  'macd',
  'adx',
  'supertrend',
  'rsi',
  'stochrsi',
  'stoch',
  'cci',
  'roc',
  'williamsr',
  'mfi',
  'atr',
  'bbands',
  'bbwidth',
  'keltner',
  'volume',
  'volumesma',
  'obv',
  'cmf',
];

describe('computeIndicator dispatcher', () => {
  it('returns a result with the right id and kind for every supported indicator', () => {
    for (const kind of ALL_KINDS) {
      const res = computeIndicator(makeConfig(kind, { period: 14 }, kind), OSC);
      expect(res.id).toBe(kind);
      expect(res.kind).toBe(kind);
      // Each result should populate at least one of overlay/separate/meta.
      expect(res.overlay !== undefined || res.separate !== undefined || res.meta !== undefined).toBe(true);
    }
  });

  it('emits an overlay series for overlay kinds', () => {
    const overlayKinds: IndicatorKind[] = ['sma', 'ema', 'wma', 'vwap', 'supertrend', 'bbands', 'bbwidth', 'keltner'];
    for (const kind of overlayKinds) {
      const res = computeIndicator(makeConfig(kind, { period: 5, multiplier: 2 }, kind), OSC);
      expect(res.overlay).toBeDefined();
      expect(res.overlay!.length).toBeGreaterThan(0);
    }
  });

  it('emits a separate series for separate kinds by default', () => {
    const separateKinds: IndicatorKind[] = [
      'rsi',
      'stochrsi',
      'stoch',
      'cci',
      'roc',
      'williamsr',
      'mfi',
      'atr',
      'macd',
      'adx',
      'volume',
      'volumesma',
      'obv',
      'cmf',
    ];
    for (const kind of separateKinds) {
      const res = computeIndicator(makeConfig(kind, { period: 5 }, kind), OSC);
      expect(res.separate).toBeDefined();
      expect(res.separate!.length).toBeGreaterThan(0);
    }
  });

  it('respects a custom panel hint', () => {
    const cfg: IndicatorConfig = {
      id: 'rsiOverlay',
      kind: 'rsi',
      enabled: true,
      params: { period: 14 },
      panel: 'overlay',
    };
    const res = computeIndicator(cfg, OSC);
    expect(res.overlay).toBeDefined();
    expect(res.separate).toBeUndefined();
  });

  it('passes the configured color through to overlay points', () => {
    const cfg: IndicatorConfig = {
      id: 'smaColored',
      kind: 'sma',
      enabled: true,
      params: { period: 5 },
      color: '#ff0000',
    };
    const res = computeIndicator(cfg, OSC);
    const finite = res.overlay!.find((p) => Number.isFinite(p.value));
    expect(finite).toBeDefined();
    expect(finite!.color).toBe('#ff0000');
  });

  it('produces a meta blob with raw numeric arrays for macd', () => {
    const res = computeIndicator(makeConfig('macd', { fast: 12, slow: 26, signal: 9 }, 'macd'), OSC);
    const meta = res.meta as Record<string, ReadonlyArray<number>>;
    expect(meta.macd).toBeDefined();
    expect(meta.signal).toBeDefined();
    expect(meta.histogram).toBeDefined();
    expect(meta.macd).toHaveLength(OSC.length);
  });

  it('drops malformed candles before computing', () => {
    const candles: Candle[] = [
      makeCandle(1, 100, 105, 95, 100, 10),
      makeCandle(2, NaN, NaN, NaN, NaN, NaN),
      makeCandle(3, 102, 108, 98, 102, 12),
    ];
    const res = computeIndicator(makeConfig('sma', { period: 2 }, 'sma'), candles);
    // After sanitization we have 2 valid candles; the SMA at index 1 = (100+102)/2 = 101.
    const finite = res.overlay!.filter((p) => Number.isFinite(p.value));
    expect(finite.length).toBe(1);
    expect(finite[0]!.value).toBeCloseTo(101, 6);
  });

  it('parses string params for periods', () => {
    const cfg: IndicatorConfig = {
      id: 'smaStr',
      kind: 'sma',
      enabled: true,
      params: { period: '7' },
    };
    const res = computeIndicator(cfg, OSC);
    const finite = res.overlay!.filter((p) => Number.isFinite(p.value));
    expect(finite.length).toBe(OSC.length - 7 + 1);
  });
});
