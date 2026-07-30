/**
 * @module    mcp-tool-assess-risk-tier
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — records an assessment, non-blocking (no gate)
 * @audit     true — appends an 'assess-risk-tier' verdict to the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MAX_INPUT_LENGTH } from '../../shared/constants.js';
import { sanitize, detectPii } from '../../shared/utils.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';

export interface RiskAssessmentInput {
  system_description: string;
  domain: string;
  affects_individuals: boolean;
  autonomous_decisions: boolean;
}

export interface RiskAssessmentResult {
  riskTier: 'HIGH' | 'LIMITED' | 'MINIMAL';
  domain: string;
  piiDetected: boolean;
  affectsIndividuals: boolean;
  effectiveAffectsIndividuals: boolean;
  domainElevated: boolean;
  autonomousDecisions: boolean;
  maiRecommendation: string;
  governanceRequirements: {
    auditRequired: boolean;
    gateRequired: boolean;
    scoringRequired: boolean;
    thresholdMonitoring: boolean;
    humanOversight: 'MANDATORY' | 'ADVISORY';
  };
}

// EU AI Act Annex III — domains classified HIGH risk regardless of caller flags.
// "Administration of social benefits" and similar individual-outcome domains are
// HIGH risk even when the caller omits affects_individuals: true.
const HIGH_STAKES_DOMAINS = ['va-claims', 'va_claims', 'veterans', 'healthcare', 'legal', 'financial', 'justice', 'employment', 'education', 'social-benefits', 'immigration'];

/**
 * Deterministic risk-tier verdict — pure, no I/O. Same inputs always yield the
 * same result (GIA north star: gate/eval decisions are deterministic, not model
 * judgment). Extracted so the verdict logic is unit-testable in isolation.
 */
export function assessRiskTier(input: RiskAssessmentInput): RiskAssessmentResult {
  const desc = sanitize(input.system_description);
  const hasPii = detectPii(desc);

  const domainStr = input.domain.toLowerCase();
  const descStr = desc.toLowerCase();
  const domainIsHighStakes = HIGH_STAKES_DOMAINS.some(d =>
    domainStr.includes(d) || descStr.includes(d.replace('-', ' '))
  );

  // Treat autonomous decisions in high-stakes domains as affecting individuals —
  // the caller flag is advisory; domain context is authoritative.
  const effectiveAffectsIndividuals = input.affects_individuals || (input.autonomous_decisions && domainIsHighStakes);

  let tier: RiskAssessmentResult['riskTier'];
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

  return {
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
  };
}

/**
 * Append the assessment to the immutable forensic ledger as an 'assess-risk-tier'
 * entry. Records the verdict + input flags + a SHA-256 FINGERPRINT of the
 * description — never the raw description text, so PII can never enter the
 * permanent, un-deletable hash chain. Mirrors the begin → complete → record
 * pattern used by score-governance / classify-decision.
 */
export function recordRiskAssessment(
  engine: GovernanceEngine,
  input: RiskAssessmentInput,
  result: RiskAssessmentResult,
): string {
  const entry = engine.ledger.begin('assess-risk-tier', MaiClassification.INFORMATIONAL, GiaLayer.MCP, 'SYSTEM');
  entry.addMetadata('domain', input.domain);
  entry.addMetadata('riskTier', result.riskTier);
  entry.addMetadata('piiDetected', result.piiDetected);
  entry.addMetadata('domainElevated', result.domainElevated);
  entry.addMetadata('affectsIndividuals', result.affectsIndividuals);
  entry.addMetadata('effectiveAffectsIndividuals', result.effectiveAffectsIndividuals);
  entry.addMetadata('autonomousDecisions', result.autonomousDecisions);
  // Fingerprint, NOT the text: keeps PII out of the immutable ledger while still
  // letting the same system be correlated across assessments.
  entry.addMetadata('descriptionSha256', createHash('sha256').update(sanitize(input.system_description)).digest('hex'));

  const score = engine.scorer.scoreDefault('assess-risk-tier');
  const completedEntry = entry.complete(score, {
    classification: MaiClassification.INFORMATIONAL,
    confidence: result.piiDetected || (result.effectiveAffectsIndividuals && result.autonomousDecisions) ? 0.95 : 0.85,
    rationale: `Risk tier assessed: ${result.riskTier}`,
    requiresGate: false,
  });
  engine.ledger.record(completedEntry);

  // Return the audit id so callers can correlate telemetry with this ledger entry.
  return entry.id;
}

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
      const result = assessRiskTier(input);

      // Anchor the verdict in the immutable forensic ledger (durable, tamper-evident).
      const auditId = recordRiskAssessment(engine, input, result);

      // Tool accountability tracking — correlated to the ledger entry via auditId.
      engine.telemetryService.emitToolCall('assess_risk_tier', auditId, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
