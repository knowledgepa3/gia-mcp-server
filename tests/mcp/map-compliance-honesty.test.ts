/**
 * @module    test-map-compliance-honesty
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * M12 closure — truth-in-labeling for map_compliance.
 *
 * Before M12, map_compliance declared 63 controls all hardcoded status:'IMPLEMENTED',
 * so its `coverage` computed to "100%" by construction and read as measured/certified
 * compliance with zero runtime evidence behind any control. The fix reframes the output
 * as an explicit DESIGN MAPPING: mappingType + a disclaimer that it is NOT certification
 * or measured enforcement, and evidenceBoundControls:0 (the ControlBinding layer is
 * post-QA-B). These tests pin that honest contract.
 *
 * Run: cd gia-mcp-server && npx vitest run tests/mcp/map-compliance-honesty.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildComplianceMappingResponse,
  MAPPING_DISCLAIMER,
  getComplianceMappings,
} from '../../src/mcp/tools/map-compliance.js';

describe('map_compliance honesty (M12)', () => {
  it('frames the result as a design mapping, not certification or measured enforcement', () => {
    const r = buildComplianceMappingResponse('EU_AI_ACT');
    expect(r.mappingType).toBe('design-mapping');
    expect(r.disclaimer.toLowerCase()).toContain('not');
    expect(r.disclaimer.toLowerCase()).toMatch(/certification|measured/);
  });

  it('reports ZERO evidence-bound controls (no ControlBinding layer yet)', () => {
    const r = buildComplianceMappingResponse('EU_AI_ACT');
    expect(r.evidenceBoundControls).toBe(0);
  });

  it('does not emit a top-level "coverage"/"implemented" enforcement claim — only mappingCoverage', () => {
    const r = buildComplianceMappingResponse('ALL') as Record<string, unknown>;
    expect(r).not.toHaveProperty('coverage');
    expect(r).not.toHaveProperty('implemented');
    expect(r).toHaveProperty('mappingCoverage');     // honest: coverage OF THE MAPPING
    expect(r).toHaveProperty('componentsMapped');
  });

  it('still returns the underlying mappings (data preserved, only labeling changed)', () => {
    const all = buildComplianceMappingResponse('ALL');
    expect(all.mappings.length).toBe(getComplianceMappings('ALL').length);
    expect(all.mappings.length).toBeGreaterThan(0);
  });

  it('the exported disclaimer names the ControlBinding path and 0 evidence-bound', () => {
    expect(MAPPING_DISCLAIMER.toLowerCase()).toContain('controlbinding');
    expect(MAPPING_DISCLAIMER).toContain('0');
  });
});
