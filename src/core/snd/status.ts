// Mark a supply / demand zone as fresh / tested / broken based on
// future price action.
//
// Definitions:
//
//   tested:  price has entered the zone (i.e. a candle wick crossed
//            into the zone) but the CLOSE of that candle stayed
//            inside the zone on the "origin side" (i.e. the zone held
//            and price bounced). The zone did not break.
//
//   broken:  a candle CLOSED on the opposite side of the zone from
//            where the zone originated. For a demand zone (which
//            originated below), a close below the zone's `low` is a
//            breakdown. For a supply zone, a close above the zone's
//            `high` is a breakout.
//
//   fresh:   neither tested nor broken.

import type { Candle, SupplyDemandZone } from '@/types';
import { isFiniteNum } from '@/core/utils/series';

export interface StatusOptions {
  /**
   * If true, a single broken candle flips the zone to "broken".
   * If false, require N consecutive closes on the other side.
   * Default true.
   */
  singleBreak: boolean;
  /** Number of consecutive closes required when singleBreak is false. */
  consecutiveCloses: number;
}

export const DEFAULT_STATUS_OPTIONS: StatusOptions = {
  singleBreak: true,
  consecutiveCloses: 1,
};

function candleInZone(c: Candle, zone: SupplyDemandZone): boolean {
  if (!isFiniteNum(c.high) || !isFiniteNum(c.low)) return false;
  return c.high >= zone.low && c.low <= zone.high;
}

/**
 * Classify the status of a single zone against the candle series
 * AFTER the zone's originTime.
 */
export function classifyZone(
  zone: SupplyDemandZone,
  candles: Candle[],
  options: Partial<StatusOptions> = {},
): SupplyDemandZone['status'] {
  const singleBreak = options.singleBreak ?? DEFAULT_STATUS_OPTIONS.singleBreak;
  const consecutiveCloses = options.consecutiveCloses ?? DEFAULT_STATUS_OPTIONS.consecutiveCloses;

  let status: SupplyDemandZone['status'] = 'fresh';
  let consecutiveOnOtherSide = 0;

  for (const c of candles) {
    if (!isFiniteNum(c.time) || c.time <= zone.originTime) continue;
    if (!isFiniteNum(c.close) || !isFiniteNum(c.high) || !isFiniteNum(c.low)) continue;

    if (zone.type === 'demand') {
      // Demand originated below: a close BELOW the zone low breaks it
      if (c.close < zone.low) {
        if (singleBreak) return 'broken';
        consecutiveOnOtherSide += 1;
        if (consecutiveOnOtherSide >= consecutiveCloses) return 'broken';
      } else {
        consecutiveOnOtherSide = 0;
      }
      // A test: candle entered the zone but closed back above the zone
      if (candleInZone(c, zone) && c.close >= zone.low) {
        if (status === 'fresh') status = 'tested';
      }
    } else {
      // Supply originated above: a close ABOVE the zone high breaks it
      if (c.close > zone.high) {
        if (singleBreak) return 'broken';
        consecutiveOnOtherSide += 1;
        if (consecutiveOnOtherSide >= consecutiveCloses) return 'broken';
      } else {
        consecutiveOnOtherSide = 0;
      }
      if (candleInZone(c, zone) && c.close <= zone.high) {
        if (status === 'fresh') status = 'tested';
      }
    }
  }
  return status;
}

/**
 * Classify many zones in one call.
 */
export function classifyZones(
  zones: SupplyDemandZone[],
  candles: Candle[],
  options: Partial<StatusOptions> = {},
): SupplyDemandZone[] {
  return zones.map((z) => ({ ...z, status: classifyZone(z, candles, options) }));
}
