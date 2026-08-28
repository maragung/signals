// Barrel export for the SND engine.

export {
  detectPatterns,
  DEFAULT_PATTERN_OPTIONS,
  type PatternOptions,
  type ZonePattern,
  type ZoneCandidate,
} from './patterns';

export {
  classifyZone,
  classifyZones,
  DEFAULT_STATUS_OPTIONS,
  type StatusOptions,
} from './status';

export {
  computeZoneStrength,
  departureComponent,
  freshnessFactor,
  scoreCandidate,
  scoreZone,
  volumeComponent,
  DEFAULT_STRENGTH_OPTIONS,
  type StrengthOptions,
} from './strength';

export {
  detectSupplyDemandZones,
  DEFAULT_SND_OPTIONS,
  type DetectSndOptions,
} from './detector';
