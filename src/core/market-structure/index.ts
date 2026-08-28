// Barrel export for the market-structure engine.

export {
  detectSwings,
  detectSwingHighs,
  detectSwingLows,
  DEFAULT_SWING_OPTIONS,
  type SwingPoint,
  type SwingOptions,
} from './swings';

export {
  classifyStructure,
  detectMarketStructure,
  DEFAULT_STRUCTURE_OPTIONS,
  type StructureOptions,
} from './structure';

export {
  detectBosChocho,
  DEFAULT_BOS_CHOCH_OPTIONS,
  type BosChochOptions,
} from './bos-choch';

export {
  detectLiquiditySweeps,
  liquiditySweepsToEvents,
  sweptSwingPoints,
  DEFAULT_LIQUIDITY_OPTIONS,
  type LiquidityOptions,
  type LiquiditySweep,
  type LiquidityKind,
} from './liquidity';

export { detectStructure, defaultStructureOptions, type StructureResult } from './detector';
