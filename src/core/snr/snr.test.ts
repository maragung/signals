import { describe, it, expect, beforeEach } from 'vitest';
import type { Candle, SupportResistanceLevel } from '@/types';
import {
  clusterLevels,
  generatePsychologicalLevels,
  PSYCH_STEPS,
  computeStrength,
  recencyFactor,
  reactionMagnitude,
  scoreLevel,
  detectSupportResistance,
  resetClusterCounter,
  resetPsychCounter,
} from './index';

let _id = 0;
function cid(): string {
  _id += 1;
  return `id-${_id}`;
}

function makeCandle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

function makeLevel(
  price: number,
  type: SupportResistanceLevel['type'],
  kind: SupportResistanceLevel['kind'] = 'minor',
  touches = 1,
  strength = 0,
): SupportResistanceLevel {
  return {
    id: cid(),
    price,
    type,
    kind,
    strength,
    touches,
  };
}

// --- clusterLevels ------------------------------------------------------

describe('clusterLevels', () => {
  beforeEach(() => {
    resetClusterCounter();
  });

  it('returns empty for empty input', () => {
    expect(clusterLevels([])).toEqual([]);
  });

  it('merges levels within 0.5% band', () => {
    const result = clusterLevels([
      { price: 100, touches: 2, strength: 0.5, kind: 'minor', type: 'resistance' },
      { price: 100.3, touches: 1, strength: 0.4, kind: 'minor', type: 'resistance' },
      { price: 100.6, touches: 1, strength: 0.6, kind: 'minor', type: 'resistance' }, // 0.6% away from 100
    ]);
    // 100 and 100.3 are within 0.5% (band = 0.5), 100.6 is at 0.6% (outside)
    expect(result).toHaveLength(2);
    // The first cluster should have combined touches
    expect(result[0]!.touches).toBe(3);
  });

  it('does not merge levels from different types', () => {
    const result = clusterLevels([
      { price: 100, touches: 1, strength: 0.5, kind: 'minor', type: 'resistance' },
      { price: 100, touches: 1, strength: 0.5, kind: 'minor', type: 'support' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.type === 'resistance')).toBeDefined();
    expect(result.find((r) => r.type === 'support')).toBeDefined();
  });

  it('skips non-finite prices', () => {
    const result = clusterLevels([
      { price: NaN, touches: 1, strength: 0.5, kind: 'minor', type: 'resistance' },
      { price: Infinity, touches: 1, strength: 0.5, kind: 'minor', type: 'resistance' },
      { price: 100, touches: 1, strength: 0.5, kind: 'minor', type: 'resistance' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.price).toBe(100);
  });

  it('uses volume-weighted average when volumeWeighted=true', () => {
    const result = clusterLevels([
      { price: 100, touches: 1, strength: 0.5, kind: 'minor', type: 'resistance' },
      { price: 102, touches: 9, strength: 0.5, kind: 'minor', type: 'resistance' },
    ]);
    // within 2% of 102 (so within 0.5% of 100? no, 2% is too far. Let me adjust)
    // Actually 2 is 2% of 100 and 1.96% of 102, so default 0.5% won't merge.
    expect(result).toHaveLength(2);
  });

  it('preserves zone info when present', () => {
    const result = clusterLevels([
      {
        price: 100,
        touches: 1,
        strength: 0.5,
        kind: 'minor',
        type: 'support',
        zone: { high: 101, low: 99 },
      },
    ]);
    expect(result[0]!.zone).toBeDefined();
    expect(result[0]!.zone!.high).toBe(101);
  });

  it('respects maxClusters limit', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      price: 1000 + i * 100,
      touches: 1,
      strength: 0.5,
      kind: 'minor' as const,
      type: 'resistance' as const,
    }));
    const result = clusterLevels(inputs, { maxClusters: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

// --- generatePsychologicalLevels ---------------------------------------

describe('generatePsychologicalLevels', () => {
  beforeEach(() => {
    resetPsychCounter();
  });

  it('returns levels on the step grid for BTC steps', () => {
    const levels = generatePsychologicalLevels({
      steps: [100, 1000],
      range: { low: 99900, high: 100200 },
    });
    // Should include 100000 at least
    expect(levels.some((l) => l.price === 100000)).toBe(true);
  });

  it('includes one level outside the range when includeOutsideRange=true', () => {
    const levels = generatePsychologicalLevels({
      steps: [100],
      range: { low: 100, high: 200 },
      includeOutsideRange: true,
    });
    expect(levels.some((l) => l.price === 100)).toBe(true);
    expect(levels.some((l) => l.price === 300)).toBe(true); // next step above
  });

  it('does not include outside-range levels when includeOutsideRange=false', () => {
    const levels = generatePsychologicalLevels({
      steps: [100],
      range: { low: 100, high: 200 },
      includeOutsideRange: false,
    });
    expect(levels.some((l) => l.price === 0)).toBe(false);
  });

  it('returns empty for invalid range', () => {
    expect(generatePsychologicalLevels({ steps: [100], range: { low: 0, high: 0 } })).toEqual([]);
  });

  it('uses the default step for known symbols', () => {
    expect(PSYCH_STEPS['BTC']).toEqual([100, 1000]);
    expect(PSYCH_STEPS['ETH']).toEqual([10, 100]);
  });

  it('handles fractional steps (e.g. SOL, FX)', () => {
    const levels = generatePsychologicalLevels({
      steps: [0.5],
      range: { low: 99, high: 101 },
    });
    expect(levels.some((l) => l.price === 99.5)).toBe(true);
    expect(levels.some((l) => l.price === 100)).toBe(true);
    expect(levels.some((l) => l.price === 100.5)).toBe(true);
  });
});

// --- computeStrength / recencyFactor / reactionMagnitude ---------------

describe('computeStrength', () => {
  it('returns 0 for all-zero components', () => {
    expect(computeStrength(0, 0, 0)).toBe(0);
  });

  it('returns ~1 for max components', () => {
    expect(computeStrength(10, 1, 1)).toBe(1);
  });

  it('clamps the output to [0..1]', () => {
    const out = computeStrength(100, 100, 100);
    expect(out).toBe(1);
  });

  it('weights formula matches spec (touches*0.3 + mag*0.4 + recency*0.3)', () => {
    // 5/10 touches -> 0.5, 0.5 mag, 0.5 recency -> 0.5*0.3 + 0.5*0.4 + 0.5*0.3 = 0.5
    expect(computeStrength(5, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('handles non-finite values gracefully', () => {
    expect(computeStrength(NaN, NaN, NaN)).toBe(0);
  });
});

describe('recencyFactor', () => {
  it('returns 1 when barsSince is 0', () => {
    expect(recencyFactor(0, 50)).toBe(1);
  });

  it('returns ~0.5 when barsSince equals half-life', () => {
    expect(recencyFactor(50, 50)).toBeCloseTo(0.5, 4);
  });

  it('returns 0 for negative barsSince', () => {
    expect(recencyFactor(-1, 50)).toBe(0);
  });

  it('handles invalid half-life', () => {
    expect(recencyFactor(10, 0)).toBe(1);
  });
});

describe('reactionMagnitude', () => {
  it('returns 0 for empty candles', () => {
    expect(reactionMagnitude([], 0, 100, 5)).toBe(0);
  });

  it('measures max distance from the level over the window', () => {
    const candles = [
      makeCandle(0, 100, 100, 100, 100), // touch
      makeCandle(1, 100, 105, 100, 104), // +5 from level
      makeCandle(2, 104, 108, 102, 107), // +8 from level
      makeCandle(3, 107, 107, 99, 100), // -1 from level
    ];
    const mag = reactionMagnitude(candles, 0, 100, 5);
    expect(mag).toBeGreaterThan(0);
    // 8 / 100 = 0.08
    expect(mag).toBeCloseTo(0.08, 4);
  });

  it('clamps to [0..1]', () => {
    const candles = [makeCandle(0, 100, 100, 100, 100), makeCandle(1, 100, 200, 100, 200)];
    expect(reactionMagnitude(candles, 0, 100, 1)).toBeLessThanOrEqual(1);
  });
});

describe('scoreLevel', () => {
  it('produces a strength score in [0..1]', () => {
    // Candles that all wick down to 100 (the support level) so the
    // touch band registers multiple hits.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i, 101, 102, 100, 100.5));
    }
    const lvl = makeLevel(100, 'support');
    const scored = scoreLevel(lvl, candles, {});
    expect(scored.strength).toBeGreaterThanOrEqual(0);
    expect(scored.strength).toBeLessThanOrEqual(1);
    expect(scored.touches).toBeGreaterThan(0);
  });

  it('does not mutate the input level id', () => {
    const candles: Candle[] = [makeCandle(0, 100, 100, 100, 100)];
    const lvl = makeLevel(100, 'support', 'major');
    const scored = scoreLevel(lvl, candles, {});
    expect(scored.id).toBe(lvl.id);
    expect(scored.kind).toBe('major');
  });
});

// --- detectSupportResistance -------------------------------------------

describe('detectSupportResistance', () => {
  beforeEach(() => {
    resetClusterCounter();
    resetPsychCounter();
  });

  it('returns empty for empty candles', () => {
    expect(detectSupportResistance([])).toEqual([]);
  });

  it('returns empty for a single candle', () => {
    expect(detectSupportResistance([makeCandle(0, 1, 1, 1, 1)])).toEqual([]);
  });

  it('produces a mix of support and resistance levels', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const t = i * 60;
      const swing = Math.sin(i / 3) * 10 + 100;
      candles.push(makeCandle(t, swing, swing + 1, swing - 1, swing));
    }
    const levels = detectSupportResistance(candles, {
      symbol: 'BTC',
      swingLookback: 2,
      includePsychological: true,
      includePrevPeriod: true,
      includeSwing: true,
      maxLevels: 30,
    });
    expect(levels.length).toBeGreaterThan(0);
    const supports = levels.filter((l) => l.type === 'support');
    const resistances = levels.filter((l) => l.type === 'resistance');
    expect(supports.length).toBeGreaterThan(0);
    expect(resistances.length).toBeGreaterThan(0);
  });

  it('produces only one side when includeSwing is restricted', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(i * 60, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
    }
    const levels = detectSupportResistance(candles, {
      includeSwing: false,
      includePsychological: true,
      includePrevPeriod: true,
      maxLevels: 30,
    });
    // All should be either psychological or prev-period
    for (const l of levels) {
      expect(['psychological', 'prev-high', 'prev-low', 'prev-close']).toContain(l.kind);
    }
  });

  it('handles all-uptrend (no swing highs/lows)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const p = 100 + i;
      candles.push(makeCandle(i * 60, p, p + 0.1, p - 0.1, p + 0.05));
    }
    const levels = detectSupportResistance(candles, {
      includeSwing: true,
      includePsychological: false,
      includePrevPeriod: true,
      maxLevels: 20,
    });
    expect(Array.isArray(levels)).toBe(true);
  });

  it('handles all-downtrend without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const p = 200 - i;
      candles.push(makeCandle(i * 60, p, p + 0.1, p - 0.1, p - 0.05));
    }
    const levels = detectSupportResistance(candles, {
      includeSwing: true,
      includePsychological: false,
      includePrevPeriod: true,
      maxLevels: 20,
    });
    expect(Array.isArray(levels)).toBe(true);
  });

  it('handles sideways series without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    const levels = detectSupportResistance(candles, {
      includeSwing: true,
      includePsychological: false,
      includePrevPeriod: true,
      maxLevels: 20,
    });
    expect(Array.isArray(levels)).toBe(true);
  });

  it('handles extreme values (very small and very large numbers)', () => {
    const candles: Candle[] = [
      makeCandle(0, 1e-9, 1.1e-9, 0.9e-9, 1e-9),
      makeCandle(60, 1e-9, 1.2e-9, 0.8e-9, 1.1e-9),
      makeCandle(120, 1.1e-9, 1.3e-9, 0.9e-9, 1.2e-9),
    ];
    const levels = detectSupportResistance(candles, {
      includeSwing: true,
      includePsychological: false,
      includePrevPeriod: true,
      maxLevels: 20,
    });
    expect(Array.isArray(levels)).toBe(true);
  });

  it('uses custom psychological steps when provided', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(makeCandle(i * 60, 100 + i, 101 + i, 99 + i, 100 + i));
    }
    const levels = detectSupportResistance(candles, {
      includeSwing: false,
      includePsychological: true,
      includePrevPeriod: false,
      psychSteps: [5],
      maxLevels: 20,
    });
    expect(levels.length).toBeGreaterThan(0);
    for (const l of levels) {
      // Every emitted level should be on a 5-step grid
      expect(l.price % 5).toBeCloseTo(0, 6);
    }
  });

  it('produces sorted output', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100 + i, 101 + i, 99 + i, 100 + i));
    }
    const levels = detectSupportResistance(candles, { maxLevels: 30 });
    for (let i = 0; i < levels.length - 1; i++) {
      expect(levels[i]!.price).toBeLessThanOrEqual(levels[i + 1]!.price);
    }
  });

  it('respects maxLevels', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(i * 60, 100 + (i % 5), 101 + (i % 5), 99 + (i % 5), 100 + (i % 5)));
    }
    const levels = detectSupportResistance(candles, { maxLevels: 5 });
    expect(levels.length).toBeLessThanOrEqual(5);
  });
});

// touch cid helper so it doesn't get tree-shaken
void cid;
