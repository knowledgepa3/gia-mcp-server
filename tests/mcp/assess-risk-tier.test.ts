/**
 * @module    test-assess-risk-tier
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Locks two things:
 *   1. The deterministic risk-tier verdict logic (regression — the verdicts
 *      already shown to a client must not drift).
 *   2. The NEW behavior: a risk assessment is APPENDED to the forensic ledger
 *      as an 'assess-risk-tier' entry — verdict + flags + a SHA-256 fingerprint
 *      of the description, NEVER the raw description text (PII must not enter
 *      the immutable chain).
 */

import { describe, it, expect } from 'vitest';
import { assessRiskTier, recordRiskAssessment } from '../../src/mcp/tools/assess-risk-tier.js';
import { GovernanceEngine } from '../../src/core/governance.js';
import { computeEntryHashV2 } from '../../src/core/audit/canonicalV2.js';
import { projectAuditEntryToV2 } from '../../src/core/audit/projectToV2.js';
import { EntryStatus, MaiClassification } from '../../src/shared/types.js';

describe('assessRiskTier — deterministic verdict (regression lock)', () => {
  it('HIGH when it affects individuals AND is autonomous', () => {
    const r = assessRiskTier({ system_description: 'screens candidates', domain: 'human resources', affects_individuals: true, autonomous_decisions: true });
    expect(r.riskTier).toBe('HIGH');
    expect(r.governanceRequirements.gateRequired).toBe(true);
    expect(r.governanceRequirements.humanOversight).toBe('MANDATORY');
  });

  it('HIGH when it affects individuals (advisory only)', () => {
    const r = assessRiskTier({ system_description: 'lead scoring', domain: 'sales', affects_individuals: true, autonomous_decisions: false });
    expect(r.riskTier).toBe('HIGH');
  });

  it('LIMITED when autonomous in a low-stakes domain and no PII', () => {
    const r = assessRiskTier({ system_description: 'drafts purchase orders in ERP', domain: 'enterprise resource planning', affects_individuals: false, autonomous_decisions: true });
    expect(r.riskTier).toBe('LIMITED');
    expect(r.governanceRequirements.gateRequired).toBe(false);
  });

  it('MINIMAL when it neither affects individuals nor is autonomous', () => {
    const r = assessRiskTier({ system_description: 'summarizes meetings', domain: 'productivity', affects_individuals: false, autonomous_decisions: false });
    expect(r.riskTier).toBe('MINIMAL');
  });

  it('elevates a high-stakes domain (healthcare) with autonomy even when affects_individuals=false', () => {
    const r = assessRiskTier({ system_description: 'triage assistant', domain: 'healthcare', affects_individuals: false, autonomous_decisions: true });
    expect(r.effectiveAffectsIndividuals).toBe(true);
    expect(r.domainElevated).toBe(true);
    expect(r.riskTier).toBe('HIGH');
  });

  it('elevates to HIGH when PII is present in the description', () => {
    const r = assessRiskTier({ system_description: 'ops helper for SSN 123-45-6789', domain: 'operations', affects_individuals: false, autonomous_decisions: false });
    expect(r.piiDetected).toBe(true);
    expect(r.riskTier).toBe('HIGH');
  });
});

describe('recordRiskAssessment — appends to the forensic ledger', () => {
  it('appends exactly one COMPLETED assess-risk-tier entry, chain-consistent, no raw description', () => {
    const engine = new GovernanceEngine();
    const secret = 'ops helper for SSN 123-45-6789 patient Jane Doe';
    const input = { system_description: secret, domain: 'operations', affects_individuals: false, autonomous_decisions: false };
    const result = assessRiskTier(input);

    const auditId = recordRiskAssessment(engine, input, result);

    const completed = engine.ledger
      .queryByOperation('assess-risk-tier')
      .filter(e => e.status === EntryStatus.COMPLETED);
    expect(completed.length).toBe(1);

    const entry = completed[0];

    // The returned audit id must correlate the ledger entry with telemetry.
    expect(typeof auditId).toBe('string');
    expect(auditId).toBe(entry.id);
    expect(entry.maiLevel).toBe(MaiClassification.INFORMATIONAL);
    expect(entry.metadata.riskTier).toBe(result.riskTier);
    expect(typeof entry.metadata.descriptionSha256).toBe('string');
    expect((entry.metadata.descriptionSha256 as string).length).toBe(64);

    // The raw description (and its PII) must NOT appear anywhere in the entry.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('Jane Doe');

    // The recorded entry must be correctly hash-chained (epoch-2 / Ledger Canonical v2).
    expect(entry.entryHash).toBe(computeEntryHashV2(entry.previousHash!, projectAuditEntryToV2(entry)));
  });
});
