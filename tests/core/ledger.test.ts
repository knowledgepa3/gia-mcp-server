/**
 * @module    test-forensic-ledger
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ForensicLedger } from '../../src/core/audit/ledger.js';
import { MaiClassification, GiaLayer, EntryStatus } from '../../src/shared/types.js';

describe('ForensicLedger', () => {
  let ledger: ForensicLedger;

  beforeEach(() => {
    ledger = new ForensicLedger();
  });

  describe('append-only guarantees', () => {
    it('should create a STARTED entry on begin()', () => {
      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      const entry = ledger.getEntry(builder.id);

      expect(entry).toBeDefined();
      expect(entry!.status).toBe(EntryStatus.STARTED);
      expect(entry!.operation).toBe('test-op');
    });

    it('should preserve STARTED entry after recording COMPLETED', () => {
      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      const score = { composite: 0.85, integrity: 0.85, accuracy: 0.85, compliance: 0.85, weights: { integrity: 0.4, accuracy: 0.35, compliance: 0.25 } };
      const classification = { classification: MaiClassification.INFORMATIONAL, confidence: 1.0, rationale: 'test', requiresGate: false };

      const completedEntry = builder.complete(score, classification);
      ledger.record(completedEntry);

      // The latest entry should be COMPLETED
      const latest = ledger.getEntry(builder.id);
      expect(latest!.status).toBe(EntryStatus.COMPLETED);

      // The full history should have BOTH entries (append-only proof)
      const history = ledger.getEntryHistory(builder.id);
      expect(history.length).toBe(2);
      expect(history[0].status).toBe(EntryStatus.STARTED);
      expect(history[1].status).toBe(EntryStatus.COMPLETED);
    });

    it('should increment log size for every state transition', () => {
      expect(ledger.size).toBe(0);

      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      expect(ledger.size).toBe(1); // STARTED

      const score = { composite: 0.85, integrity: 0.85, accuracy: 0.85, compliance: 0.85, weights: { integrity: 0.4, accuracy: 0.35, compliance: 0.25 } };
      const classification = { classification: MaiClassification.INFORMATIONAL, confidence: 1.0, rationale: 'test', requiresGate: false };
      const completed = builder.complete(score, classification);
      ledger.record(completed);

      expect(ledger.size).toBe(2); // STARTED + COMPLETED
    });

    it('should freeze entries (immutable)', () => {
      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      const entry = ledger.getEntry(builder.id);

      expect(() => {
        (entry as any).status = 'HACKED';
      }).toThrow(); // Object.freeze prevents mutation
    });
  });

  describe('builder sealing', () => {
    it('should prevent double-complete on builder', () => {
      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      const score = { composite: 0.85, integrity: 0.85, accuracy: 0.85, compliance: 0.85, weights: { integrity: 0.4, accuracy: 0.35, compliance: 0.25 } };
      const classification = { classification: MaiClassification.INFORMATIONAL, confidence: 1.0, rationale: 'test', requiresGate: false };

      builder.complete(score, classification);

      expect(() => {
        builder.complete(score, classification);
      }).toThrow(/already sealed/);
    });

    it('should prevent metadata after sealing', () => {
      const builder = ledger.begin('test-op', MaiClassification.INFORMATIONAL);
      const score = { composite: 0.85, integrity: 0.85, accuracy: 0.85, compliance: 0.85, weights: { integrity: 0.4, accuracy: 0.35, compliance: 0.25 } };
      const classification = { classification: MaiClassification.INFORMATIONAL, confidence: 1.0, rationale: 'test', requiresGate: false };

      builder.complete(score, classification);

      expect(() => {
        builder.addMetadata('key', 'value');
      }).toThrow(/already sealed/);
    });
  });

  describe('queries', () => {
    it('should query by operation name', () => {
      const b1 = ledger.begin('op-alpha', MaiClassification.INFORMATIONAL);
      const b2 = ledger.begin('op-beta', MaiClassification.MANDATORY);
      const b3 = ledger.begin('op-alpha', MaiClassification.ADVISORY);

      const results = ledger.queryByOperation('op-alpha');
      expect(results.length).toBe(2);
      expect(results.every(e => e.operation === 'op-alpha')).toBe(true);
    });

    it('should track active operations (orphan detection)', () => {
      const b1 = ledger.begin('op-a', MaiClassification.INFORMATIONAL);
      const b2 = ledger.begin('op-b', MaiClassification.INFORMATIONAL);

      expect(ledger.getActiveOperations().length).toBe(2);

      const score = { composite: 0.85, integrity: 0.85, accuracy: 0.85, compliance: 0.85, weights: { integrity: 0.4, accuracy: 0.35, compliance: 0.25 } };
      const classification = { classification: MaiClassification.INFORMATIONAL, confidence: 1.0, rationale: 'test', requiresGate: false };
      ledger.record(b1.complete(score, classification));

      expect(ledger.getActiveOperations().length).toBe(1);
    });
  });
});
