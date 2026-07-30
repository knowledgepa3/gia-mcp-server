/**
 * @module    mai-types
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A — type definitions
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { MaiClassification, type IMaiElevationRule } from '../../shared/types.js';

export interface IClassificationRequest {
  operation: string;
  baseLevel: MaiClassification;
  context: Record<string, unknown>;
  domain: string;
  piiDetected: boolean;
}

/** Claim status carried by an external evidence provider (e.g. MIR). */
export type ExternalEvidenceClaimStatus = 'clean' | 'flagged' | 'contested';
/** Recommendation carried by an external evidence provider. GIA decides; this never does. */
export type ExternalEvidenceRecommendation = 'ALLOW' | 'STEP_UP' | 'LIMIT' | 'DENY';

/**
 * External participation-history evidence attached to a classification context
 * (MIR seam, authorized 2026-07-02). EVIDENCE, NOT AUTHORITY: this is one input
 * to the deterministic elevation rules below — the classifier/gate decides.
 * Absence of this field is fail-safe: no evidence, no elevation change.
 * Must be stamped by core/evidence/applyExternalEvidence from a provider fetch —
 * NEVER accepted as caller/tool input (caller-asserted evidence would be a
 * self-attestation hole).
 */
export interface IExternalEvidenceContext {
  provider: string;
  claimStatus: ExternalEvidenceClaimStatus;
  recommendation: ExternalEvidenceRecommendation;
  tier?: number;
}

export interface IClassificationContext {
  operation: string;
  agentName?: string;
  vertical?: string;
  inputSensitivity: 'PUBLIC' | 'CONTROLLED' | 'SOVEREIGN';
  outputAudience: 'INTERNAL' | 'CLIENT' | 'PUBLIC';
  hasFinancialImpact: boolean;
  hasLegalImpact: boolean;
  piiDetected: boolean;
  /** Cross-ledger correlation ID — links MCP governance decisions to server-side HTTP request chains. */
  correlationId?: string;
  /** External participation-history evidence (MIR seam). Optional; absence = no effect. */
  externalEvidence?: IExternalEvidenceContext;
}

export const MAI_PRIORITY: Record<MaiClassification, number> = {
  [MaiClassification.MANDATORY]: 3,
  [MaiClassification.ADVISORY]: 2,
  [MaiClassification.INFORMATIONAL]: 1,
};

export const DEFAULT_ELEVATION_RULES: IMaiElevationRule[] = [
  { condition: 'pii_detected',             elevateTo: MaiClassification.MANDATORY, description: 'PII detected — elevate to MANDATORY' },
  { condition: 'client_facing_output',      elevateTo: MaiClassification.MANDATORY, description: 'Client-facing output requires MANDATORY gate' },
  { condition: 'financial_impact',          elevateTo: MaiClassification.MANDATORY, description: 'Financial impact requires MANDATORY oversight' },
  // legal_assertion is context-aware: MANDATORY only when output is external (client/public).
  // Internal governance analysis with legal terminology is ADVISORY — prevents classifier
  // from over-escalating read-only audit/analysis queries (ChatGPT smoke test finding, 2026-05-08).
  { condition: 'legal_assertion_external',  elevateTo: MaiClassification.MANDATORY, description: 'Legal assertion to external party requires MANDATORY review' },
  { condition: 'legal_assertion_internal',  elevateTo: MaiClassification.ADVISORY,  description: 'Legal analysis (internal) elevates to ADVISORY minimum' },
  { condition: 'medical_language',          elevateTo: MaiClassification.ADVISORY,  description: 'Medical language elevates to ADVISORY minimum' },
  // External-evidence rules (MIR seam, 2026-07-02). Deterministic mapping agreed at the
  // GIA+MIR boundary: the provider recommends, GIA's gate decides. Elevate-only (Rule 2):
  // ALLOW/clean never reduces a classification.
  { condition: 'external_evidence_deny',      elevateTo: MaiClassification.MANDATORY, description: 'External evidence DENY — block until human decision' },
  { condition: 'external_evidence_contested', elevateTo: MaiClassification.MANDATORY, description: 'External evidence claim CONTESTED — human review required' },
  { condition: 'external_evidence_step_up',   elevateTo: MaiClassification.MANDATORY, description: 'External evidence STEP_UP — human approval required' },
  { condition: 'external_evidence_limit',     elevateTo: MaiClassification.ADVISORY,  description: 'External evidence LIMIT — flagged for oversight, proceeds' },
  { condition: 'external_evidence_flagged',   elevateTo: MaiClassification.ADVISORY,  description: 'External evidence claim FLAGGED — flagged for oversight, proceeds' },
];
