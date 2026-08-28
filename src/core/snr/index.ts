// Barrel export for the SNR engine.

export {
  clusterLevels,
  resetClusterCounter,
  sanitizeLevels,
  DEFAULT_CLUSTER_OPTIONS,
  type ClusterInput,
  type ClusterOptions,
} from './clustering';

export {
  generatePsychologicalLevels,
  resetPsychCounter,
  DEFAULT_PSYCHOLOGICAL_OPTIONS,
  PSYCH_STEPS,
  type PsychologicalOptions,
} from './psychological';

export {
  computeStrength,
  reactionMagnitude,
  recencyFactor,
  scoreLevel,
  DEFAULT_STRENGTH_OPTIONS,
  type TouchEvent,
  type StrengthOptions,
} from './strength';

export {
  detectSupportResistance,
  DEFAULT_SNR_OPTIONS,
  type DetectSnROptions,
} from './detector';
