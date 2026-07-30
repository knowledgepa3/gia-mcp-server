import type { GovernedAction, LanePolicy, GateVerdict } from './types.js';

// ============================================================================
// Gate #6 — Completion Evidence. "Status is not completion. Delegation is not
// completion. Completion requires evidence." A `complete` action is accepted
// only if its artifact satisfies the lane's required-field schema.
//
// Determinism note: the DENY is deterministic — it comes from the artifact
// failing the schema. The delegation-claim text scan is ADVISORY: it only
// refines the *reason* (PREMATURE_DELEGATION_STOP vs INCOMPLETE_ARTIFACT), it
// never manufactures the reject by itself. (Spec §4.3.)
// ============================================================================

const DELEGATION_CLAIM = /kicked off|background (research )?agent|delegated this|a subagent is (working|checking)|waiting for (the|another|more) (agent|worker|results)|subagent will|another (agent|worker) is/i;

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return Boolean(value);
}

function artifactSatisfies(artifact: unknown, requiredFields: string[]): boolean {
  if (artifact == null || typeof artifact !== 'object') return false;
  const obj = artifact as Record<string, unknown>;
  return requiredFields.every(field => field in obj && isNonEmpty(obj[field]));
}

export function completionGate(action: GovernedAction, policy: LanePolicy): GateVerdict {
  if (action.type !== 'complete') {
    return { gate: 'completion', verdict: 'ALLOW', mai: 'INFORMATIONAL' };
  }
  if (!policy.completion || policy.completion.requiredArtifactFields.length === 0) {
    return { gate: 'completion', verdict: 'ALLOW', mai: 'INFORMATIONAL' };
  }
  if (artifactSatisfies(action.artifact, policy.completion.requiredArtifactFields)) {
    return { gate: 'completion', verdict: 'ALLOW', mai: 'INFORMATIONAL' };
  }

  const claimsDelegation = typeof action.text === 'string' && DELEGATION_CLAIM.test(action.text);
  return {
    gate: 'completion',
    verdict: 'DENY',
    mai: 'MANDATORY',
    rule: claimsDelegation ? 'PREMATURE_DELEGATION_STOP' : 'INCOMPLETE_ARTIFACT',
    reason: claimsDelegation
      ? 'Returned a delegation status instead of the required artifact'
      : `Artifact does not satisfy required fields: ${policy.completion.requiredArtifactFields.join(', ')}`,
  };
}
