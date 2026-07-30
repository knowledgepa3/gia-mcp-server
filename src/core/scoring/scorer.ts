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
  DEFAULT_SCORE_WEIGHTS, MIN_COMPOSITE_SCORE, SCORE_HALT_THRESHOLD, NOT_SCORED_SENTINEL,
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
      scored: true,
    };

    // Score below halt threshold is a MANDATORY error — pipeline stops
    if (composite < SCORE_HALT_THRESHOLD) {
      throw new ScoreFailureError(operation, composite, SCORE_HALT_THRESHOLD, auditId);
    }

    return score;
  }

  /**
   * Record a NOT-SCORED result for control-plane operations that have no
   * integrity/accuracy/compliance to measure (server start, gate approve/reject,
   * snapshot, etc.).
   *
   * This intentionally does NOT fabricate a passing score. A prior version wrote a
   * hardcoded 0.85 composite that masqueraded as a real measurement in the forensic
   * ledger and always cleared the 0.70 release gate by construction (H1, simulation
   * audit 2026-06-16). Instead it emits an explicit out-of-band sentinel with
   * `scored: false`; consumers must treat it as "not measured", never as a pass.
   *
   * @param operation  the operation name (kept for caller API compatibility / audit context)
   */
  scoreDefault(operation: string): IGovernanceScore {
    void operation;
    return {
      integrity: NOT_SCORED_SENTINEL,
      accuracy: NOT_SCORED_SENTINEL,
      compliance: NOT_SCORED_SENTINEL,
      composite: NOT_SCORED_SENTINEL,
      weights: { ...this.weights },
      timestamp: utcNow(),
      scoredBy: 'governance-scorer-not-scored',
      scored: false,
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
