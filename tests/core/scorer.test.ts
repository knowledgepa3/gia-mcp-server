/**
 * @module    test-governance-scorer
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GovernanceScorer } from '../../src/core/scoring/scorer.js';
import { ScoreFailureError } from '../../src/shared/errors.js';
import { MIN_COMPOSITE_SCORE, SCORE_HALT_THRESHOLD, NOT_SCORED_SENTINEL } from '../../src/shared/constants.js';

describe('GovernanceScorer', () => {
  let scorer: GovernanceScorer;

  beforeEach(() => {
    scorer = new GovernanceScorer();
  });

  describe('composite scoring', () => {
    it('should calculate weighted composite (40% integrity, 35% accuracy, 25% compliance)', () => {
      const score = scorer.score(
        { integrity: 1.0, accuracy: 1.0, compliance: 1.0 },
        'perfect-op', 'audit-1'
      );
      expect(score.composite).toBeCloseTo(1.0);
    });

    it('should weight integrity most heavily', () => {
      const highIntegrity = scorer.score(
        { integrity: 1.0, accuracy: 0.5, compliance: 0.5 },
        'high-int', 'audit-2'
      );
      const highAccuracy = scorer.score(
        { integrity: 0.5, accuracy: 1.0, compliance: 0.5 },
        'high-acc', 'audit-3'
      );
      expect(highIntegrity.composite).toBeGreaterThan(highAccuracy.composite);
    });

    it('should return individual dimension scores unchanged', () => {
      const score = scorer.score(
        { integrity: 0.9, accuracy: 0.8, compliance: 0.7 },
        'test', 'audit-4'
      );
      expect(score.integrity).toBe(0.9);
      expect(score.accuracy).toBe(0.8);
      expect(score.compliance).toBe(0.7);
    });
  });

  describe('halt threshold boundary', () => {
    it('should throw ScoreFailureError when composite < halt threshold', () => {
      expect(() => {
        scorer.score(
          { integrity: 0.3, accuracy: 0.3, compliance: 0.3 },
          'bad-output', 'audit-halt'
        );
      }).toThrow(ScoreFailureError);
    });

    it('should NOT throw when composite equals halt threshold exactly', () => {
      // Halt threshold is 0.50. Find values that produce exactly 0.50:
      // 0.50 = i*0.40 + a*0.35 + c*0.25
      // If all equal x: 0.50 = x*(0.40+0.35+0.25) = x*1.0, so x = 0.50
      expect(() => {
        scorer.score(
          { integrity: 0.50, accuracy: 0.50, compliance: 0.50 },
          'borderline', 'audit-border'
        );
      }).not.toThrow();
    });

    it('should throw just below halt threshold', () => {
      expect(() => {
        scorer.score(
          { integrity: 0.49, accuracy: 0.49, compliance: 0.49 },
          'just-under', 'audit-under'
        );
      }).toThrow(ScoreFailureError);
    });
  });

  describe('release threshold', () => {
    it('should meet threshold for high scores', () => {
      const score = scorer.score(
        { integrity: 0.9, accuracy: 0.9, compliance: 0.9 },
        'good-output', 'audit-good'
      );
      expect(scorer.meetsThreshold(score)).toBe(true);
    });

    it('should NOT meet threshold for mediocre scores', () => {
      const score = scorer.score(
        { integrity: 0.6, accuracy: 0.6, compliance: 0.6 },
        'mediocre', 'audit-med'
      );
      // 0.6 composite < 0.70 release threshold
      expect(scorer.meetsThreshold(score)).toBe(false);
    });

    it('should meet threshold at exactly the minimum', () => {
      const score = scorer.score(
        { integrity: 0.70, accuracy: 0.70, compliance: 0.70 },
        'exact-min', 'audit-exact'
      );
      expect(scorer.meetsThreshold(score)).toBe(true);
    });
  });

  describe('default scoring (not-scored sentinel)', () => {
    // H1 RELABEL: scoreDefault() is for control-plane ops that have no
    // integrity/accuracy/compliance to measure. It must NOT write a fabricated
    // passing score (was a hardcoded 0.85) into the forensic ledger, because that
    // masquerades as a real measurement that always clears the 0.70 gate.

    it('should flag the result as not scored', () => {
      const score = scorer.scoreDefault('init-op');
      expect(score.scored).toBe(false);
      expect(score.scoredBy).toBe('governance-scorer-not-scored');
    });

    it('should emit the explicit not-scored sentinel, not a fake passing number', () => {
      const score = scorer.scoreDefault('init-op');
      expect(score.composite).toBe(NOT_SCORED_SENTINEL);
      expect(score.integrity).toBe(NOT_SCORED_SENTINEL);
      expect(score.accuracy).toBe(NOT_SCORED_SENTINEL);
      expect(score.compliance).toBe(NOT_SCORED_SENTINEL);
    });

    it('should NOT masquerade as a passing measured score', () => {
      const score = scorer.scoreDefault('init-op');
      expect(score.composite).toBeLessThan(MIN_COMPOSITE_SCORE);
      expect(scorer.meetsThreshold(score)).toBe(false);
    });
  });

  describe('measured scoring is flagged as scored', () => {
    it('should mark a real measured score as scored:true', () => {
      const score = scorer.score(
        { integrity: 0.9, accuracy: 0.9, compliance: 0.9 },
        'measured-op', 'audit-measured'
      );
      expect(score.scored).toBe(true);
    });
  });
});
