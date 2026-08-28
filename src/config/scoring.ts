import type { ScoreBreakdown } from '@/types';

// Default scoring weights; can be overridden by user in settings.
export const DEFAULT_SCORING_WEIGHTS: ScoreBreakdown = {
  trend: 2,
  momentum: 1,
  volume: 2,
  structure: 2,
  snr: 1,
  snd: 1,
  volatility: 1,
  mtf: 2,
};

export const SCORING_LABELS: Record<keyof ScoreBreakdown, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  structure: 'Market Structure',
  snr: 'SNR',
  snd: 'SND',
  volatility: 'Volatility',
  mtf: 'MTF Confirmation',
};
