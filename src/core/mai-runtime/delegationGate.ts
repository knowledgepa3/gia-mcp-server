import type { GovernedAction, LanePolicy, LaneBudgetState, GateVerdict } from './types.js';

// ============================================================================
// Gate #2 — Delegation Authority (the deterministic core).
// "No delegation without authority." An agent may only spawn/delegate when its
// lane policy grants delegation authority and it is under the subagent cap.
// This is the gate that would have stopped the Lane E incident that motivated
// MAI Runtime (see the case study).
// ============================================================================

const DELEGATION_ACTIONS = new Set<GovernedAction['type']>(['spawn_subagent', 'delegate']);

export function delegationGate(
  action: GovernedAction,
  policy: LanePolicy,
  state: LaneBudgetState,
): GateVerdict {
  if (!DELEGATION_ACTIONS.has(action.type)) {
    return { gate: 'delegation', verdict: 'ALLOW', mai: 'INFORMATIONAL' };
  }
  if (!policy.delegation.allowed) {
    return {
      gate: 'delegation',
      verdict: 'DENY',
      mai: 'MANDATORY',
      rule: 'NO_DELEGATION_WITHOUT_AUTHORITY',
      reason: `Lane ${policy.agentId} does not permit delegation`,
    };
  }
  if (state.subagentsSpawned >= policy.delegation.maxSubagents) {
    return {
      gate: 'delegation',
      verdict: 'DENY',
      mai: 'MANDATORY',
      rule: 'SUBAGENT_CAP_REACHED',
      reason: `Subagent cap of ${policy.delegation.maxSubagents} already reached`,
    };
  }
  return { gate: 'delegation', verdict: 'ALLOW', mai: 'INFORMATIONAL' };
}
