/**
 * @module    mcp-tool-assess-risk-tier
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MAX_INPUT_LENGTH } from '../../shared/constants.js';
import { sanitize, detectPii } from '../../shared/utils.js';

export function registerAssessRiskTierTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'assess_risk_tier',
    'Assess the risk tier of an AI system using rule-based mapping to EU AI Act categories (Unacceptable, High, Limited, Minimal). Returns tier and MAI governance recommendations. Classification is heuristic, not a legal determination.',
    {
      system_description: z.string().max(MAX_INPUT_LENGTH).describe('Description of the AI system or operation'),
      domain: z.string().describe('Industry domain'),
      affects_individuals: z.boolean().describe('Whether the system makes decisions affecting individuals'),
      autonomous_decisions: z.boolean().describe('Whether the system makes autonomous decisions'),
    },
    { title: 'Assess Risk Tier', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const desc = sanitize(input.system_description);
      const hasPii = detectPii(desc);

      // EU AI Act Annex III — domains classified HIGH risk regardless of caller flags.
      // "Administration of social benefits" and similar individual-outcome domains are
      // HIGH risk even when the caller omits affects_individuals: true.
      const HIGH_STAKES_DOMAINS = ['va-claims', 'va_claims', 'veterans', 'healthcare', 'legal', 'financial', 'justice', 'employment', 'education', 'social-benefits', 'immigration'];
      const domainStr = input.domain.toLowerCase();
      const descStr = desc.toLowerCase();
      const domainIsHighStakes = HIGH_STAKES_DOMAINS.some(d =>
        domainStr.includes(d) || descStr.includes(d.replace('-', ' '))
      );

      // Treat autonomous decisions in high-stakes domains as affecting individuals —
      // the caller flag is advisory; domain context is authoritative.
      const effectiveAffectsIndividuals = input.affects_individuals || (input.autonomous_decisions && domainIsHighStakes);

      // Risk tier assessment logic (delegatable to CORE in future)
      let tier: string;
      let maiRecommendation: string;

      if (effectiveAffectsIndividuals && input.autonomous_decisions) {
        tier = 'HIGH';
        maiRecommendation = 'All agent actions should be MANDATORY classification. Human-in-the-loop required.';
      } else if (effectiveAffectsIndividuals) {
        tier = 'HIGH';
        maiRecommendation = 'Decision points should be MANDATORY. Processing can be ADVISORY.';
      } else if (input.autonomous_decisions) {
        tier = 'LIMITED';
        maiRecommendation = 'Outputs should be ADVISORY. Internal processing can be INFORMATIONAL.';
      } else {
        tier = 'MINIMAL';
        maiRecommendation = 'Standard governance applies. INFORMATIONAL for processing, ADVISORY for outputs.';
      }

      if (hasPii) {
        tier = 'HIGH';
        maiRecommendation = 'PII detected. Elevate all operations to MANDATORY minimum. Apply SOVEREIGN data handling.';
      }

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('assess_risk_tier', `risk-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          riskTier: tier,
          domain: input.domain,
          piiDetected: hasPii,
          affectsIndividuals: input.affects_individuals,
          effectiveAffectsIndividuals,
          domainElevated: domainIsHighStakes && !input.affects_individuals && input.autonomous_decisions,
          autonomousDecisions: input.autonomous_decisions,
          maiRecommendation,
          governanceRequirements: {
            auditRequired: true,
            gateRequired: tier === 'HIGH',
            scoringRequired: true,
            thresholdMonitoring: true,
            humanOversight: tier === 'HIGH' ? 'MANDATORY' : 'ADVISORY',
          },
        }, null, 2) }],
      };
    }
  );
}
