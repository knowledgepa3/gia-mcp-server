/**
 * @module    test-mai-classifier
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MaiClassifier } from '../../src/core/mai/classifier.js';
import { MaiClassification } from '../../src/shared/types.js';
import { type IClassificationContext } from '../../src/core/mai/types.js';

function makeContext(overrides: Partial<IClassificationContext> = {}): IClassificationContext {
  return {
    operation: 'test-operation',
    inputSensitivity: 'CONTROLLED',
    outputAudience: 'INTERNAL',
    hasFinancialImpact: false,
    hasLegalImpact: false,
    piiDetected: false,
    ...overrides,
  };
}

describe('MaiClassifier', () => {
  let classifier: MaiClassifier;

  beforeEach(() => {
    classifier = new MaiClassifier();
  });

  describe('base classification', () => {
    it('should return INFORMATIONAL when no elevation triggers', () => {
      const result = classifier.classify('simple-log', MaiClassification.INFORMATIONAL, makeContext());
      expect(result.classification).toBe(MaiClassification.INFORMATIONAL);
      expect(result.requiresGate).toBe(false);
    });

    it('should return ADVISORY when base is ADVISORY and no further elevation', () => {
      const result = classifier.classify('draft-review', MaiClassification.ADVISORY, makeContext());
      expect(result.classification).toBe(MaiClassification.ADVISORY);
      expect(result.requiresGate).toBe(true);
    });

    it('should return MANDATORY when base is MANDATORY', () => {
      const result = classifier.classify('critical-op', MaiClassification.MANDATORY, makeContext());
      expect(result.classification).toBe(MaiClassification.MANDATORY);
      expect(result.requiresGate).toBe(true);
    });
  });

  describe('elevation rules — context elevates, NEVER reduces (Rule 2)', () => {
    it('should elevate to MANDATORY on PII detection', () => {
      const result = classifier.classify(
        'data-process', MaiClassification.INFORMATIONAL,
        makeContext({ piiDetected: true })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
      expect(result.elevatedFrom).toBe(MaiClassification.INFORMATIONAL);
      expect(result.elevationReason).toContain('PII');
    });

    it('should elevate to MANDATORY on client-facing output', () => {
      const result = classifier.classify(
        'generate-report', MaiClassification.INFORMATIONAL,
        makeContext({ outputAudience: 'CLIENT' })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
      expect(result.elevatedFrom).toBe(MaiClassification.INFORMATIONAL);
    });

    it('should elevate to MANDATORY on financial impact', () => {
      const result = classifier.classify(
        'calculate-fee', MaiClassification.ADVISORY,
        makeContext({ hasFinancialImpact: true })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
    });

    // Legal assertions are context-aware (2026-05-08): external → MANDATORY, internal → ADVISORY
    it('should elevate to MANDATORY on legal assertions to external audiences', () => {
      const result = classifier.classify(
        'legal-claim', MaiClassification.INFORMATIONAL,
        makeContext({ hasLegalImpact: true, outputAudience: 'CLIENT' })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
    });

    it('should elevate to ADVISORY on internal legal analysis (not MANDATORY)', () => {
      const result = classifier.classify(
        'legal-claim', MaiClassification.INFORMATIONAL,
        makeContext({ hasLegalImpact: true })
      );
      expect(result.classification).toBe(MaiClassification.ADVISORY);
    });

    it('should NEVER reduce classification — MANDATORY stays MANDATORY', () => {
      // Even if context has no elevation triggers, MANDATORY input stays MANDATORY
      const result = classifier.classify(
        'already-mandatory', MaiClassification.MANDATORY,
        makeContext()
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
      expect(result.elevatedFrom).toBeUndefined(); // no elevation needed
    });

    it('should apply highest applicable elevation', () => {
      // Multiple triggers: PII + client-facing + legal — all → MANDATORY
      const result = classifier.classify(
        'multi-trigger', MaiClassification.INFORMATIONAL,
        makeContext({ piiDetected: true, outputAudience: 'CLIENT', hasLegalImpact: true })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
    });
  });

  describe('vertical configuration', () => {
    it('should use vertical agent base classification', () => {
      classifier.registerVertical({
        vertical: 'ace',
        agentClassifications: { 'ecv-final-review': MaiClassification.MANDATORY },
        elevationRules: [],
      });

      const result = classifier.classify(
        'review-output', MaiClassification.INFORMATIONAL,
        makeContext({ vertical: 'ace', agentName: 'ecv-final-review' })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
    });

    it('should not reduce classification below vertical base', () => {
      classifier.registerVertical({
        vertical: 'ace',
        agentClassifications: { 'ecv-intake': MaiClassification.ADVISORY },
        elevationRules: [],
      });

      // Base MANDATORY should not be reduced to ADVISORY
      const result = classifier.classify(
        'intake-op', MaiClassification.MANDATORY,
        makeContext({ vertical: 'ace', agentName: 'ecv-intake' })
      );
      expect(result.classification).toBe(MaiClassification.MANDATORY);
    });
  });

  describe('confidence scoring', () => {
    it('should have base confidence >= 0.85', () => {
      const result = classifier.classify('op', MaiClassification.INFORMATIONAL, makeContext());
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('should increase confidence on PII + MANDATORY', () => {
      const result = classifier.classify(
        'pii-op', MaiClassification.INFORMATIONAL,
        makeContext({ piiDetected: true })
      );
      expect(result.confidence).toBeGreaterThan(0.85);
    });

    it('should never exceed 1.0', () => {
      const result = classifier.classify(
        'max-confidence', MaiClassification.MANDATORY,
        makeContext({ piiDetected: true, outputAudience: 'CLIENT' })
      );
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });
});
