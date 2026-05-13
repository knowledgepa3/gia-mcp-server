/**
 * @module    governance-scorer
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       A — scoring is ADVISORY (flags outputs, doesn't halt by default)
 * @audit     true — every score is recorded
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  type IGovernanceScore, type IScoreWeights,
} from '../../shared/types.js';
import {
  DEFAULT_SCORE_WEIGHTS, MIN_COMPOSITE_SCORE, SCORE_HALT_THRESHOLD,
} from '../../shared/constants.js';
import { ScoreFailureError } from '../../shared/errors.js';
import { utcNow } from '../../shared/utils.js';

export interface IScoringCriteria {
  /** Does the output maintain data integrity? (0.0-1.0) */
  integrity: number;
  /** Is the output factually accurate/consistent? (0.0-1.0) */
  accuracy: number;
  /** Does the output comply with regulatory requirements? (0.0-1.0) */
  compliance: number;
}

/**
 * GovernanceScorer — scores every output before release.
 *
 * Every agent output receives Integrity, Accuracy, and Compliance scoring.
 * Unscored output does not ship.
 */
export class GovernanceScorer {
  private weights: IScoreWeights;

  constructor(weights?: Partial<IScoreWeights>) {
    this.weights = {
      integrity: weights?.integrity ?? DEFAULT_SCORE_WEIGHTS.integrity,
      accuracy: weights?.accuracy ?? DEFAULT_SCORE_WEIGHTS.accuracy,
      compliance: weights?.compliance ?? DEFAULT_SCORE_WEIGHTS.compliance,
    };
  }

  /**
   * Score an output against governance criteria.
   *
   * @governance  All outputs are governance-scored before release.
   * @ledger      Score recorded to forensic ledger by caller.
   * @mai         Scoring is ADVISORY — caller decides halt behavior.
   * @failure     Throws ScoreFailureError if below halt threshold.
   */
  score(criteria: IScoringCriteria, operation: string, auditId: string): IGovernanceScore {
    const composite = this.calculateComposite(criteria);

    const score: IGovernanceScore = {
      integrity: criteria.integrity,
      accuracy: criteria.accuracy,
      compliance: criteria.compliance,
      composite,
      weights: { ...this.weights },
      timestamp: utcNow(),
      scoredBy: 'governance-scorer',
    };

    // Score below halt threshold is a MANDATORY error — pipeline stops
    if (composite < SCORE_HALT_THRESHOLD) {
      throw new ScoreFailureError(operation, composite, SCORE_HALT_THRESHOLD, auditId);
    }

    return score;
  }

  /**
   * Score with default criteria (for operations that don't have specific scoring).
   * Applies a baseline score that passes threshold.
   */
  scoreDefault(operation: string): IGovernanceScore {
    return {
      integrity: 0.85,
      accuracy: 0.85,
      compliance: 0.85,
      composite: 0.85,
      weights: { ...this.weights },
      timestamp: utcNow(),
      scoredBy: 'governance-scorer-default',
    };
  }

  /**
   * Check if a score meets minimum release threshold.
   */
  meetsThreshold(score: IGovernanceScore): boolean {
    return score.composite >= MIN_COMPOSITE_SCORE;
  }

  private calculateComposite(criteria: IScoringCriteria): number {
    return (
      criteria.integrity * this.weights.integrity +
      criteria.accuracy * this.weights.accuracy +
      criteria.compliance * this.weights.compliance
    );
  }
}
