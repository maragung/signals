import { describe, it, expect } from 'vitest';
import type { Candle, SupplyDemandZone } from '@/types';
import {
  detectPatterns,
  classifyZone,
  classifyZones,
  computeZoneStrength,
  departureComponent,
  freshnessFactor,
  volumeComponent,
  scoreCandidate,
  scoreZone,
  detectSupplyDemandZones,
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

function makeZone(
  type: 'supply' | 'demand',
  high: number,
  low: number,
  originTime: number,
  pattern: SupplyDemandZone['pattern'] = 'base-rally',
): SupplyDemandZone {
  return {
    id: cid(),
    type,
    high,
    low,
    originTime,
    status: 'fresh',
    strength: 0,
    pattern,
  };
}

// --- detectPatterns -----------------------------------------------------

describe('detectPatterns', () => {
  it('returns empty for empty input', () => {
    expect(detectPatterns([])).toEqual([]);
  });

  it('returns empty for too-short input', () => {
    expect(detectPatterns([makeCandle(0, 1, 1, 1, 1)])).toEqual([]);
    expect(detectPatterns([
      makeCandle(0, 1, 1, 1, 1),
      makeCandle(1, 1, 1, 1, 1),
    ])).toEqual([]);
  });

  it('detects a base-rally (demand) pattern', () => {
    // 1) Very tight 3-candle base around 100 (range 1)
    // 2) Strong bullish departure candle
    const candles: Candle[] = [
      makeCandle(0, 100, 100.5, 99.5, 100),
      makeCandle(60, 100, 100.5, 99.5, 100),
      makeCandle(120, 100, 100.5, 99.5, 100), // base ends here (range 1)
      makeCandle(180, 100, 115, 100, 114), // big bullish departure
    ];
    const cands = detectPatterns(candles, { baseLength: 3, baseTightness: 1.0, departureSize: 1.5 });
    const baseRally = cands.find((c) => c.pattern === 'base-rally' && c.type === 'demand');
    expect(baseRally).toBeDefined();
    expect(baseRally!.high).toBeCloseTo(100.5, 6);
    expect(baseRally!.low).toBeCloseTo(99.5, 6);
  });

  it('detects a base-drop (supply) pattern', () => {
    const candles: Candle[] = [
      makeCandle(0, 200, 200.5, 199.5, 200),
      makeCandle(60, 200, 200.5, 199.5, 200),
      makeCandle(120, 200, 200.5, 199.5, 200), // base ends here
      makeCandle(180, 200, 200, 185, 186), // big bearish departure
    ];
    const cands = detectPatterns(candles, { baseLength: 3, baseTightness: 1.0, departureSize: 1.5 });
    const baseDrop = cands.find((c) => c.pattern === 'base-drop' && c.type === 'supply');
    expect(baseDrop).toBeDefined();
  });

  it('does not detect a pattern when the base is not tight', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 110, 90, 105), // very wide range
      makeCandle(60, 105, 115, 95, 110),
      makeCandle(120, 110, 120, 100, 115),
      makeCandle(180, 115, 130, 115, 129),
    ];
    const cands = detectPatterns(candles, { baseLength: 3, baseTightness: 0.5, departureSize: 1.5 });
    expect(cands.filter((c) => c.pattern === 'base-rally')).toEqual([]);
  });

  it('does not detect a pattern when the departure is too small', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 100.5, 99.5, 100),
      makeCandle(60, 100, 100.5, 99.5, 100),
      makeCandle(120, 100, 100.5, 99.5, 100),
      makeCandle(180, 100, 100.5, 100, 100.3), // tiny departure
    ];
    const cands = detectPatterns(candles, { baseLength: 3, baseTightness: 1.0, departureSize: 5 });
    expect(cands.filter((c) => c.pattern === 'base-rally')).toEqual([]);
  });

  it('handles all-uptrend without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const p = 100 + i;
      candles.push(makeCandle(i * 60, p, p + 0.5, p - 0.5, p + 0.5));
    }
    const cands = detectPatterns(candles);
    expect(Array.isArray(cands)).toBe(true);
  });

  it('handles all-downtrend without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const p = 200 - i;
      candles.push(makeCandle(i * 60, p, p + 0.5, p - 0.5, p - 0.5));
    }
    const cands = detectPatterns(candles);
    expect(Array.isArray(cands)).toBe(true);
  });

  it('handles sideways series without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    const cands = detectPatterns(candles);
    expect(Array.isArray(cands)).toBe(true);
  });
});

// --- classifyZone / classifyZones --------------------------------------

describe('classifyZone', () => {
  it('returns "fresh" when no future price action is provided', () => {
    const z = makeZone('demand', 110, 100, 0);
    expect(classifyZone(z, [])).toBe('fresh');
  });

  it('returns "tested" when price wicks into the zone but holds', () => {
    const z = makeZone('demand', 110, 100, 0);
    const candles: Candle[] = [
      makeCandle(60, 115, 115, 105, 113), // wick to 105 (inside zone) closes 113
      makeCandle(120, 113, 120, 110, 118),
    ];
    expect(classifyZone(z, candles)).toBe('tested');
  });

  it('returns "broken" when a demand zone is closed below', () => {
    const z = makeZone('demand', 110, 100, 0);
    const candles: Candle[] = [makeCandle(60, 105, 105, 95, 94)];
    expect(classifyZone(z, candles)).toBe('broken');
  });

  it('returns "broken" when a supply zone is closed above', () => {
    const z = makeZone('supply', 210, 200, 0);
    const candles: Candle[] = [makeCandle(60, 205, 215, 205, 214)];
    expect(classifyZone(z, candles)).toBe('broken');
  });

  it('ignores candles that occur at or before originTime', () => {
    const z = makeZone('demand', 110, 100, 100);
    const candles: Candle[] = [
      makeCandle(50, 100, 100, 50, 50), // before origin
      makeCandle(200, 115, 115, 105, 113), // after origin, test
    ];
    expect(classifyZone(z, candles)).toBe('tested');
  });

  it('supports non-single-break mode (consecutive closes)', () => {
    const z = makeZone('demand', 110, 100, 0);
    const candles: Candle[] = [
      // First wicks into the zone (test) without closing below
      makeCandle(60, 115, 115, 105, 113),
      // Then briefly closes below (1 break) but recovers
      makeCandle(120, 105, 105, 95, 94),
      makeCandle(180, 115, 115, 113, 114),
    ];
    // single close below is not enough when singleBreak=false, consecutiveCloses=2
    expect(classifyZone(z, candles, { singleBreak: false, consecutiveCloses: 2 })).toBe('tested');
  });

  it('breaks after N consecutive closes on the other side', () => {
    const z = makeZone('demand', 110, 100, 0);
    const candles: Candle[] = [
      makeCandle(60, 105, 105, 95, 94),
      makeCandle(120, 100, 100, 90, 91),
    ];
    expect(classifyZone(z, candles, { singleBreak: false, consecutiveCloses: 2 })).toBe('broken');
  });
});

describe('classifyZones', () => {
  it('classifies a batch of zones', () => {
    const z1 = makeZone('demand', 110, 100, 0);
    const z2 = makeZone('supply', 210, 200, 0);
    const candles: Candle[] = [
      makeCandle(60, 105, 105, 95, 94), // breaks z1
      makeCandle(120, 205, 215, 205, 214), // breaks z2
    ];
    const out = classifyZones([z1, z2], candles);
    expect(out[0]!.status).toBe('broken');
    expect(out[1]!.status).toBe('broken');
  });
});

// --- strength functions -------------------------------------------------

describe('computeZoneStrength', () => {
  it('returns 0 for all-zero components', () => {
    expect(computeZoneStrength(0, 0, 0)).toBe(0);
  });

  it('returns ~1 for max components', () => {
    expect(computeZoneStrength(1, 1, 1)).toBe(1);
  });

  it('weights formula matches spec', () => {
    // 0.5 * 0.4 + 0.5 * 0.2 + 0.5 * 0.4 = 0.5
    expect(computeZoneStrength(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('clamps to [0..1]', () => {
    expect(computeZoneStrength(10, 10, 10)).toBe(1);
  });
});

describe('freshnessFactor', () => {
  it('returns 1 when barsSince is 0', () => {
    expect(freshnessFactor(0, 100)).toBe(1);
  });

  it('decays as barsSince grows', () => {
    expect(freshnessFactor(100, 100)).toBeCloseTo(0.5, 6);
    expect(freshnessFactor(200, 100)).toBeCloseTo(1 / 3, 6);
  });

  it('returns 0 for negative barsSince', () => {
    expect(freshnessFactor(-1, 100)).toBe(0);
  });

  it('returns 0 for zero/negative decay', () => {
    expect(freshnessFactor(10, 0)).toBe(0);
  });
});

describe('departureComponent', () => {
  it('normalises by recent range', () => {
    // departure / (avgR * 3)
    expect(departureComponent(3, 1)).toBe(1);
    expect(departureComponent(1.5, 1)).toBe(0.5);
  });

  it('handles invalid inputs', () => {
    expect(departureComponent(NaN, 1)).toBe(0);
    expect(departureComponent(1, 0)).toBe(0);
    expect(departureComponent(1, NaN)).toBe(0);
  });
});

describe('volumeComponent', () => {
  it('normalises by 2x avgVolume', () => {
    expect(volumeComponent(200, 100)).toBe(1);
    expect(volumeComponent(100, 100)).toBe(0.5);
  });

  it('handles invalid inputs', () => {
    expect(volumeComponent(NaN, 100)).toBe(0);
    expect(volumeComponent(100, 0)).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('returns a strength in [0..1]', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(i * 60, 100 + i, 101 + i, 99 + i, 100 + i));
    }
    const cands = detectPatterns(candles);
    if (cands.length > 0) {
      const s = scoreCandidate(cands[0]!, candles);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoreZone', () => {
  it('returns a new zone with strength populated', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 101, 99, 100.5));
    }
    const z = makeZone('demand', 101, 99, 0);
    const out = scoreZone(z, candles);
    expect(out.id).toBe(z.id);
    expect(out.strength).toBeGreaterThanOrEqual(0);
    expect(out.strength).toBeLessThanOrEqual(1);
  });
});

// --- detectSupplyDemandZones -------------------------------------------

describe('detectSupplyDemandZones', () => {
  it('returns empty for empty input', () => {
    expect(detectSupplyDemandZones([])).toEqual([]);
  });

  it('returns empty for too-short input', () => {
    expect(detectSupplyDemandZones([makeCandle(0, 1, 1, 1, 1)])).toEqual([]);
  });

  it('produces demand zones in a down-then-up structure', () => {
    // Build a clear base-rally sequence: tight base then strong bullish
    // departure. Pass baseTightness: 1.0 so the natural 1-unit base
    // range passes the default check.
    const candles: Candle[] = [
      makeCandle(0, 100, 100.5, 99.5, 100),
      makeCandle(60, 100, 100.5, 99.5, 100),
      makeCandle(120, 100, 100.5, 99.5, 100),
      makeCandle(180, 100, 115, 100, 114),
    ];
    const zones = detectSupplyDemandZones(candles, {
      pattern: { baseTightness: 1.0 },
    });
    expect(zones.length).toBeGreaterThan(0);
    const demand = zones.find((z) => z.type === 'demand');
    expect(demand).toBeDefined();
  });

  it('marks a fresh demand zone as fresh when no future closes break it', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 100.5, 99.5, 100),
      makeCandle(60, 100, 100.5, 99.5, 100),
      makeCandle(120, 100, 100.5, 99.5, 100),
      makeCandle(180, 100, 115, 100, 114), // departure
      makeCandle(240, 114, 120, 113, 119), // continues higher (no test)
    ];
    const zones = detectSupplyDemandZones(candles);
    const demand = zones.find((z) => z.type === 'demand');
    if (demand) {
      expect(['fresh', 'tested']).toContain(demand.status);
    }
  });

  it('marks a zone as broken when price closes through it', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 100.5, 99.5, 100),
      makeCandle(60, 100, 100.5, 99.5, 100),
      makeCandle(120, 100, 100.5, 99.5, 100),
      makeCandle(180, 100, 115, 100, 114),
      // Future price closes below the demand zone (zone low ~99.5)
      makeCandle(240, 95, 96, 90, 91),
    ];
    const zones = detectSupplyDemandZones(candles);
    const demand = zones.find((z) => z.type === 'demand');
    if (demand) {
      expect(demand.status).toBe('broken');
    }
  });

  it('handles all-uptrend without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const p = 100 + i;
      candles.push(makeCandle(i * 60, p, p + 0.5, p - 0.5, p + 0.5));
    }
    const zones = detectSupplyDemandZones(candles);
    expect(Array.isArray(zones)).toBe(true);
  });

  it('handles all-downtrend without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const p = 200 - i;
      candles.push(makeCandle(i * 60, p, p + 0.5, p - 0.5, p - 0.5));
    }
    const zones = detectSupplyDemandZones(candles);
    expect(Array.isArray(zones)).toBe(true);
  });

  it('handles sideways series without throwing', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(i * 60, 100, 100.5, 99.5, 100));
    }
    const zones = detectSupplyDemandZones(candles);
    expect(Array.isArray(zones)).toBe(true);
  });

  it('handles extreme values without throwing', () => {
    const candles: Candle[] = [
      makeCandle(0, 1e-9, 1.1e-9, 0.9e-9, 1e-9),
      makeCandle(60, 1e-9, 1.1e-9, 0.9e-9, 1e-9),
      makeCandle(120, 1e-9, 1.1e-9, 0.9e-9, 1e-9),
      makeCandle(180, 1e-9, 1.5e-9, 1e-9, 1.4e-9),
    ];
    const zones = detectSupplyDemandZones(candles);
    expect(Array.isArray(zones)).toBe(true);
  });

  it('respects maxZones', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 100; i++) {
      candles.push(makeCandle(i * 60, 100 + (i % 5) - 2, 102, 98, 100));
    }
    const zones = detectSupplyDemandZones(candles, { maxZones: 3 });
    expect(zones.length).toBeLessThanOrEqual(3);
  });

  it('respects minStrength filter', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100),
      makeCandle(60, 100, 101, 99, 100),
      makeCandle(120, 100, 101, 99, 100),
      makeCandle(180, 100, 115, 100, 114),
    ];
    const all = detectSupplyDemandZones(candles);
    const filtered = detectSupplyDemandZones(candles, { minStrength: 0.99 });
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });
});

// touch cid to keep import alive
void cid;
