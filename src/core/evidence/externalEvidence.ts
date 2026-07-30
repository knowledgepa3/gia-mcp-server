/**
 * @module    external-evidence
 * @layer     GOVERNANCE
 * @inherits  governance-root
 * @mai       N/A — pure evidence-to-context stamping; classification happens in MaiClassifier
 * @audit     false — callers audit the classification this feeds
 * @owner     William J. Storey III / ACE / GIA
 *
 * EXTERNAL EVIDENCE SEAM (MIR composition point, authorized by William 2026-07-02).
 *
 * Boundary contract (GIA+MIR one-pager, agreed both sides):
 *   - The provider supplies EVIDENCE: a tier, a claim status, a recommendation.
 *   - GIA DECIDES: the evidence is stamped onto the classification context, the
 *     deterministic elevation rules in core/mai map it to a MAI level, and the
 *     gate enforces. The provider never makes the final call.
 *   - FAIL-SAFE: a null signal (provider disabled, unreachable, timed out, or
 *     entity unknown) leaves the context untouched. Absence of history is not
 *     treated as risk — mirrors the provider's own stated principle.
 *   - Elevate-only (MAI Rule 2): ALLOW/clean never reduces a classification.
 *
 * SECURITY: evidence must be stamped from a provider fetch by trusted code.
 * It is deliberately NOT accepted as tool/caller input — caller-asserted
 * evidence would be a self-attestation hole (same class as trusting a
 * caller-supplied signature-verified flag).
 *
 * Scope guardrail: agents + service accounts first. Human entities are deferred
 * pending legal review (participation history influencing employment-context
 * decisions is EU AI Act Annex III high-risk territory for the deployer).
 */

import type {
  IClassificationContext,
  IExternalEvidenceContext,
  ExternalEvidenceClaimStatus,
  ExternalEvidenceRecommendation,
} from '../mai/types.js';

export type { ExternalEvidenceClaimStatus, ExternalEvidenceRecommendation };

/** A point-in-time evidence signal returned by an external provider. */
export interface IExternalEvidenceSignal extends IExternalEvidenceContext {
  /** Opaque/hashed entity reference the signal describes (never a plaintext identifier). */
  entityRef: string;
  /** ISO timestamp the signal was retrieved from the provider. */
  retrievedAt: string;
}

/**
 * A pluggable external evidence provider (MIR is the first implementation).
 * fetchSignal MUST be fail-safe: resolve null on disabled/unconfigured/timeout/
 * unknown-entity — never throw into a governance path, never fabricate a signal.
 */
export interface IExternalEvidenceProvider {
  readonly name: string;
  readonly enabled: boolean;
  fetchSignal(entityRef: string, timeoutMs?: number): Promise<IExternalEvidenceSignal | null>;
}

/**
 * Stamp an evidence signal onto a classification context.
 * Pure: returns a NEW context; the input is never mutated.
 * Null signal → the original context is returned unchanged (fail-safe).
 */
export function applyExternalEvidence(
  context: IClassificationContext,
  signal: IExternalEvidenceSignal | null,
): IClassificationContext {
  if (!signal) return context;
  return {
    ...context,
    externalEvidence: {
      provider: signal.provider,
      claimStatus: signal.claimStatus,
      recommendation: signal.recommendation,
      tier: signal.tier,
    },
  };
}
