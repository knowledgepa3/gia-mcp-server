/**
 * @module    composite-scorer
 * @layer     GOVERNANCE
 * @inherits  governance-scorer
 * @mai       A
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */

import { type IGovernanceScore, type IScoreWeights } from '../../shared/types.js';
import { DEFAULT_SCORE_WEIGHTS } from '../../shared/constants.js';

/**
 * Calculate weighted composite score from individual dimensions.
 */
export function calculateComposite(
  integrity: number,
  accuracy: number,
  compliance: number,
  weights: IScoreWeights = DEFAULT_SCORE_WEIGHTS
): number {
  return (
    integrity * weights.integrity +
    accuracy * weights.accuracy +
    compliance * weights.compliance
  );
}

/**
 * Aggregate multiple governance scores into a pipeline-level score.
 */
export function aggregateScores(scores: IGovernanceScore[]): IGovernanceScore | null {
  if (scores.length === 0) return null;

  const avg = (fn: (s: IGovernanceScore) => number) =>
    scores.reduce((sum, s) => sum + fn(s), 0) / scores.length;

  const integrity = avg(s => s.integrity);
  const accuracy = avg(s => s.accuracy);
  const compliance = avg(s => s.compliance);

  return {
    integrity, accuracy, compliance,
    composite: calculateComposite(integrity, accuracy, compliance),
    weights: { ...DEFAULT_SCORE_WEIGHTS },
    timestamp: new Date(),
    scoredBy: 'composite-aggregator',
  };
}
