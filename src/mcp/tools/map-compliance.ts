/**
 * @module    mcp-tool-map-compliance
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — records a design-mapping, non-blocking (no gate)
 * @audit     true — appends a 'map-compliance' entry to the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import {
  MAPPING_DISCLAIMER,
  getComplianceMappings,
} from '../../compliance/complianceMappings.js';

/**
 * HONESTY NOTE (2026-06-18, audit finding M12):
 * This is a DESIGN MAPPING — each row asserts that a GIA component is *intended to
 * address* a control. `status: 'IMPLEMENTED'` means the component EXISTS and is mapped;
 * it does NOT mean the control is third-party certified, nor that runtime enforcement
 * of it has been MEASURED from evidence. Do not read the aggregate as "% of controls
 * proven." Runtime-evidenced coverage requires a ControlBinding with a live evidence
 * query (see docs/superpowers/specs/2026-06-18-control-binding-runtime-compliance-design.md).
 * Evidence-bound controls today: 0 (the ControlBinding layer is post-QA-B).
 *
 * DATA SOURCE (2026-07-02): the mapping table + disclaimer live in the VENDORED
 * SINGLE SOURCE `src/compliance/complianceMappings.ts` (byte-identical twin at
 * server/src/compliance/complianceMappings.ts, CI-enforced by the vendor-parity
 * test) so the Express dashboard can no longer fork and drift. This module
 * re-exports them for existing consumers (server-http.ts, context-authority.ts,
 * honesty tests).
 */
export { MAPPING_DISCLAIMER, getComplianceMappings };

/**
 * Build the honest map_compliance response payload (pure — M12).
 * `mappingCoverage` is the % of controls a GIA component is mapped to (a DESIGN
 * mapping), explicitly NOT measured runtime enforcement; `evidenceBoundControls`
 * is 0 until the ControlBinding layer lands. Unit-testable without registering the tool.
 */
export function buildComplianceMappingResponse(framework: string) {
  const filtered = getComplianceMappings(framework);
  const componentsMapped = filtered.filter(m => m.status === 'IMPLEMENTED').length;
  return {
    framework,
    mappingType: 'design-mapping' as const,
    totalControls: filtered.length,
    componentsMapped,                          // GIA component exists + mapped (design), NOT evidence-bound
    mappingCoverage: filtered.length ? `${((componentsMapped / filtered.length) * 100).toFixed(0)}%` : '0%',
    evidenceBoundControls: 0,                  // runtime-evidence-bound via a ControlBinding — none yet (post-QA-B)
    disclaimer: MAPPING_DISCLAIMER,
    mappings: filtered,
  };
}

/**
 * Anchor a compliance design-mapping in the immutable forensic ledger as a
 * 'map-compliance' entry. Carries the honest caveat INTO the permanent record:
 * `mappingType: 'design-mapping'` and `evidenceBoundControls` travel with the
 * proof so a ledger reader can never mistake a design mapping for measured
 * runtime enforcement. No PII — framework enum + aggregate counts only.
 * Mirrors the begin → complete → record pattern used by assess-risk-tier.
 */
export function recordComplianceMapping(
  engine: GovernanceEngine,
  framework: string,
  response: ReturnType<typeof buildComplianceMappingResponse>,
): string {
  const entry = engine.ledger.begin('map-compliance', MaiClassification.INFORMATIONAL, GiaLayer.COMPLIANCE, 'SYSTEM');
  entry.addMetadata('framework', framework);
  entry.addMetadata('mappingType', response.mappingType);
  entry.addMetadata('totalControls', response.totalControls);
  entry.addMetadata('componentsMapped', response.componentsMapped);
  entry.addMetadata('mappingCoverage', response.mappingCoverage);
  entry.addMetadata('evidenceBoundControls', response.evidenceBoundControls);

  const score = engine.scorer.scoreDefault('map-compliance');
  const completedEntry = entry.complete(score, {
    classification: MaiClassification.INFORMATIONAL,
    confidence: 0.85,
    rationale: `Compliance design-mapping generated: ${framework} (${response.componentsMapped}/${response.totalControls} components mapped, ${response.evidenceBoundControls} evidence-bound)`,
    requiresGate: false,
  });
  engine.ledger.record(completedEntry);
  return entry.id;
}

export function registerMapComplianceTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'map_compliance',
    'Map GIA governance components to regulatory compliance frameworks (NIST AI RMF, EU AI Act, ISO 42001, NIST 800-53, FedRAMP, LINDDUN, MITRE ATLAS, OMB M-25-22, HIPAA, VHA Trustworthy AI). Returns a DESIGN MAPPING (which GIA component is mapped to each control) across 10 frameworks and 72 controls — NOT third-party certification and NOT measured runtime enforcement. Rows whose control text implies enforcement that is config-gated off by default carry status PARTIAL. Runtime-evidenced coverage requires a ControlBinding (0 controls evidence-bound today).',
    {
      framework: z.enum(['NIST_AI_RMF', 'EU_AI_ACT', 'ISO_42001', 'NIST_800_53', 'FEDRAMP', 'LINDDUN', 'MITRE_ATLAS', 'OMB_M_25_22', 'HIPAA', 'VHA_TRUSTWORTHY_AI', 'ALL']).describe('Compliance framework to map'),
    },
    { title: 'Map Compliance Framework', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const response = buildComplianceMappingResponse(input.framework);

      // Anchor the design-mapping in the immutable forensic ledger (durable, tamper-evident).
      const auditId = recordComplianceMapping(engine, input.framework, response);

      // Tool accountability tracking — correlated to the ledger entry via auditId.
      engine.telemetryService.emitToolCall('map_compliance', auditId, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
