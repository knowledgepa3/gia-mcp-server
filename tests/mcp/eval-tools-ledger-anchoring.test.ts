/**
 * @module    test-eval-tools-ledger-anchoring
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Locks the ledger-anchoring for the three eval/report tools that were
 * telemetry-only (map_compliance, evaluate_threshold, generate_report),
 * extending the assess_risk_tier pattern. Each records exactly one COMPLETED
 * INFORMATIONAL entry, chain-consistent (epoch-2 / Ledger Canonical v2),
 * carrying the honest summary — never overclaiming (e.g. map-compliance must
 * carry evidenceBoundControls into the permanent record so the design-mapping
 * caveat travels with the proof).
 */

import { describe, it, expect } from 'vitest';
import { buildComplianceMappingResponse, recordComplianceMapping } from '../../src/mcp/tools/map-compliance.js';
import { recordThresholdEvaluation } from '../../src/mcp/tools/evaluate-threshold.js';
import { recordGovernanceReport } from '../../src/mcp/tools/generate-report.js';
import { GovernanceEngine } from '../../src/core/governance.js';
import { computeEntryHashV2 } from '../../src/core/audit/canonicalV2.js';
import { projectAuditEntryToV2 } from '../../src/core/audit/projectToV2.js';
import { EntryStatus, MaiClassification } from '../../src/shared/types.js';

describe('recordComplianceMapping — appends an honest design-mapping entry', () => {
  it('appends exactly one COMPLETED map-compliance entry, chain-consistent, carrying evidenceBoundControls', () => {
    const engine = new GovernanceEngine();
    const response = buildComplianceMappingResponse('EU_AI_ACT');

    const auditId = recordComplianceMapping(engine, 'EU_AI_ACT', response);

    const completed = engine.ledger
      .queryByOperation('map-compliance')
      .filter(e => e.status === EntryStatus.COMPLETED);
    expect(completed.length).toBe(1);

    const entry = completed[0];
    expect(auditId).toBe(entry.id);
    expect(entry.maiLevel).toBe(MaiClassification.INFORMATIONAL);
    expect(entry.metadata.framework).toBe('EU_AI_ACT');
    expect(entry.metadata.mappingType).toBe('design-mapping');
    // The honest caveat must travel into the immutable record — not just the UI.
    expect(entry.metadata.evidenceBoundControls).toBe(0);
    expect(entry.metadata.totalControls).toBe(response.totalControls);

    expect(entry.entryHash).toBe(computeEntryHashV2(entry.previousHash!, projectAuditEntryToV2(entry)));
  });
});

describe('recordThresholdEvaluation — appends a Storey Threshold reading', () => {
  it('appends exactly one COMPLETED evaluate-threshold entry, chain-consistent', () => {
    const engine = new GovernanceEngine();
    const reading = engine.thresholdMonitor.getReading();

    const auditId = recordThresholdEvaluation(engine, reading);

    const completed = engine.ledger
      .queryByOperation('evaluate-threshold')
      .filter(e => e.status === EntryStatus.COMPLETED);
    expect(completed.length).toBe(1);

    const entry = completed[0];
    expect(auditId).toBe(entry.id);
    expect(entry.maiLevel).toBe(MaiClassification.INFORMATIONAL);
    expect(entry.metadata.status).toBe(reading.status);
    expect(typeof entry.metadata.escalationRate).toBe('string');

    expect(entry.entryHash).toBe(computeEntryHashV2(entry.previousHash!, projectAuditEntryToV2(entry)));
  });

  it('does NOT touch the live threshold reading (no observer effect at anchor time)', () => {
    const engine = new GovernanceEngine();
    const before = engine.thresholdMonitor.getReading();
    recordThresholdEvaluation(engine, before);
    const after = engine.thresholdMonitor.getReading();
    // Anchoring records to the ledger; it must not feed the threshold monitor,
    // otherwise reading the threshold would perturb the metric it reports.
    expect(after.escalationRate).toBe(before.escalationRate);
    expect(after.windowSize).toBe(before.windowSize);
  });
});

describe('recordGovernanceReport — appends a report summary', () => {
  it('appends exactly one COMPLETED generate-report entry, chain-consistent', () => {
    const engine = new GovernanceEngine();

    const auditId = recordGovernanceReport(engine, 'summary', {
      systemHealthStatus: 'HEALTHY',
      thresholdRate: '0.0%',
      thresholdStatus: 'OPTIMAL',
      auditChainIntegrity: 'INTACT',
      totalOperations: 5,
    });

    const completed = engine.ledger
      .queryByOperation('generate-report')
      .filter(e => e.status === EntryStatus.COMPLETED);
    expect(completed.length).toBe(1);

    const entry = completed[0];
    expect(auditId).toBe(entry.id);
    expect(entry.maiLevel).toBe(MaiClassification.INFORMATIONAL);
    expect(entry.metadata.format).toBe('summary');
    expect(entry.metadata.auditChainIntegrity).toBe('INTACT');

    expect(entry.entryHash).toBe(computeEntryHashV2(entry.previousHash!, projectAuditEntryToV2(entry)));
  });
});
