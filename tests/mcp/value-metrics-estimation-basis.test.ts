/**
 * @module    test-value-metrics-estimation-basis
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * M8 closure — truth-in-labeling for impact-report ROI figures.
 *
 * Before M8, generate_impact_report / /api/gia/report framed costAvoidedUSD, netROI, and
 * failureCostAvoided as "real" / "pilot ROI" / "enterprise-ready proof" — but those figures
 * are ESTIMATES: caller-supplied counts times HARDCODED baselines (rate=85, incident=$50,000,
 * run=$0.50) over an in-memory window that resets on restart. These tests pin the honest
 * contract: an estimation-basis annotation that marks the output as an estimate and states the
 * assumptions + provenance. The numbers/formulas themselves are unchanged.
 *
 * Run: cd gia-mcp-server && npx vitest run tests/mcp/value-metrics-estimation-basis.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildEstimationBasis, getBaselines } from '../../src/mcp/tools/value-metrics.js';

describe('buildEstimationBasis (M8 truth-in-labeling)', () => {
  it('marks the output as an estimate, not measured proof', () => {
    const basis = buildEstimationBasis(getBaselines());
    expect(basis.estimated).toBe(true);
    expect(basis.method).toBe('illustrative-estimate');
    expect(basis.disclaimer.toLowerCase()).toContain('estimate');
    expect(basis.disclaimer.toLowerCase()).toContain('not measured');
  });

  it('surfaces the hardcoded baseline constants the estimate multiplies by', () => {
    const bl = getBaselines();
    const basis = buildEstimationBasis(bl);
    // The exact constants from the finding must be stated to the buyer.
    expect(basis.baselineConstants.humanHourlyRateUSD).toBe(bl.humanHourlyRate);
    expect(basis.baselineConstants.estimatedIncidentCostUSD).toBe(bl.estimatedIncidentCost);
    expect(basis.baselineConstants.modelCostPerRunUSD).toBe(bl.modelCostPerRun);
    // Default-baseline values per the finding.
    expect(basis.baselineConstants.humanHourlyRateUSD).toBe(85);
    expect(basis.baselineConstants.estimatedIncidentCostUSD).toBe(50000);
    expect(basis.baselineConstants.modelCostPerRunUSD).toBe(0.5);
  });

  it('discloses the ephemeral, caller-supplied, non-persisted provenance', () => {
    const basis = buildEstimationBasis(getBaselines());
    expect(basis.dataProvenance.source).toBe('caller-supplied');
    expect(basis.dataProvenance.storage).toBe('in-memory');
    expect(basis.dataProvenance.persisted).toBe(false);
    expect(basis.dataProvenance.resetsOnRestart).toBe(true);
  });

  it('is pure — same baselines in produce an equal basis out', () => {
    const a = buildEstimationBasis(getBaselines());
    const b = buildEstimationBasis(getBaselines());
    expect(a).toEqual(b);
  });

  it('reflects overridden baselines (basis tracks the constants actually used)', () => {
    const custom = { ...getBaselines(), humanHourlyRate: 120, estimatedIncidentCost: 75000 };
    const basis = buildEstimationBasis(custom);
    expect(basis.baselineConstants.humanHourlyRateUSD).toBe(120);
    expect(basis.baselineConstants.estimatedIncidentCostUSD).toBe(75000);
  });
});
