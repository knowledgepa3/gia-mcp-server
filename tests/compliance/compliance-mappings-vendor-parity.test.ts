/**
 * @module    compliance-mappings-vendor-parity.test
 * @layer     COMPLIANCE
 * @inherits  compliance-mappings
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * VENDOR PARITY GATE (canonicalV2 pattern): the compliance design-mapping table
 * is vendored into BOTH deployables (they cannot import each other). This test
 * asserts the two copies are BYTE-IDENTICAL, so "single source" is CI-enforced,
 * not aspirational. The 2026-07 audit found the Express copy had silently forked
 * to a different control set (45 vs 63) with none of the M12 honesty framing —
 * this gate makes that divergence impossible to ship quietly.
 *
 * It also pins DATA HONESTY rules on the rows themselves: no unverifiable
 * cadence/benchmark claims, and enforcement-implying rows that are config-gated
 * off by default stay PARTIAL with the gating named in the text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPLIANCE_MAPPINGS,
  FRAMEWORK_META,
  MAPPING_DISCLAIMER,
  getComplianceMappings,
} from '../../src/compliance/complianceMappings.js';

const MCP_COPY = join(__dirname, '..', '..', 'src', 'compliance', 'complianceMappings.ts');
const SERVER_COPY = join(__dirname, '..', '..', '..', 'server', 'src', 'compliance', 'complianceMappings.ts');

describe('compliance mappings — vendored single source', () => {
  it('gia-mcp-server and server copies are byte-identical', () => {
    const mcp = readFileSync(MCP_COPY, 'utf8');
    const server = readFileSync(SERVER_COPY, 'utf8');
    expect(server).toBe(mcp);
  });

  it('every framework in the table has display metadata, and vice versa', () => {
    const inTable = new Set(COMPLIANCE_MAPPINGS.map(m => m.framework));
    const inMeta = new Set(Object.keys(FRAMEWORK_META));
    expect([...inTable].sort()).toEqual([...inMeta].sort());
  });

  it('covers all 10 frameworks (the pre-fork Express surface silently served only 6)', () => {
    const frameworks = new Set(COMPLIANCE_MAPPINGS.map(m => m.framework));
    expect(frameworks.size).toBe(10);
    for (const fw of ['FEDRAMP', 'OMB_M_25_22', 'HIPAA', 'VHA_TRUSTWORTHY_AI', 'EU_AI_ACT', 'NIST_800_53']) {
      expect(frameworks.has(fw as never)).toBe(true);
    }
  });

  it('getComplianceMappings filters by framework and returns a defensive copy for ALL', () => {
    const eu = getComplianceMappings('EU_AI_ACT');
    expect(eu.length).toBeGreaterThan(0);
    expect(eu.every(m => m.framework === 'EU_AI_ACT')).toBe(true);
    const all = getComplianceMappings('ALL');
    expect(all.length).toBe(COMPLIANCE_MAPPINGS.length);
    expect(all).not.toBe(COMPLIANCE_MAPPINGS);
  });
});

describe('compliance mappings — data honesty pins (2026-07-02 rewording)', () => {
  const rowText = (m: { control: string; description: string; giaComponent: string }) =>
    `${m.control} ${m.description} ${m.giaComponent}`.toLowerCase();

  it('carries no unverifiable cadence or benchmark claims', () => {
    for (const m of COMPLIANCE_MAPPINGS) {
      expect(rowText(m)).not.toMatch(/every 30 minutes|chaos test|~\d+s recovery/);
    }
  });

  it('WebAuthn enforcement rows are PARTIAL and name the config gate (default off)', () => {
    const webauthnEnforcementRows = COMPLIANCE_MAPPINGS.filter(
      m => (m.control === 'IA-5(2)' || m.control === 'IA-2(1)') && rowText(m).includes('webauthn')
    );
    expect(webauthnEnforcementRows.length).toBe(2);
    for (const m of webauthnEnforcementRows) {
      expect(m.status).toBe('PARTIAL');
      expect(rowText(m)).toContain('config-gated');
      expect(rowText(m)).toContain('default off');
    }
  });

  it('EU Art. 14 does not claim WebAuthn enforcement — it names it config-gated', () => {
    const art14 = COMPLIANCE_MAPPINGS.find(m => m.framework === 'EU_AI_ACT' && m.control === 'Art. 14');
    expect(art14).toBeDefined();
    expect(rowText(art14!)).toContain('config-gated');
  });

  it('InternalPenTester rows call the probes what they are: control-presence checks, not breach simulation', () => {
    const penRows = COMPLIANCE_MAPPINGS.filter(m => m.giaComponent.includes('InternalPenTester'));
    expect(penRows.length).toBeGreaterThan(0);
    for (const m of penRows) {
      expect(rowText(m)).toContain('presence');
    }
    const verifyAttack = COMPLIANCE_MAPPINGS.find(m => m.control === 'AML.T0042');
    expect(verifyAttack?.status).toBe('PARTIAL');
  });

  it('the disclaimer still names the ControlBinding path and 0 evidence-bound controls', () => {
    expect(MAPPING_DISCLAIMER.toLowerCase()).toContain('controlbinding');
    expect(MAPPING_DISCLAIMER).toContain('0');
    expect(MAPPING_DISCLAIMER.toLowerCase()).toContain('not third-party certification');
  });
});
