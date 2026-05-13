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
];
