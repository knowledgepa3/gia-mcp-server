import { delegationGate } from './delegationGate.js';
import { budgetGate } from './budgetGate.js';
import { completionGate } from './completionGate.js';
import type {
  GovernedAction,
  LanePolicy,
  LaneBudgetState,
  GateVerdict,
  EvaluationResult,
} from './types.js';

// ============================================================================
// MAI Runtime evaluator — runs the applicable deterministic gates in order and
// returns the decisive verdict plus a forensic-ledger evidence record.
//
// Ordering is authority-before-affordability: a `complete` action is judged by
// the Completion gate; every other action is checked for Delegation authority
// first (can it do this at all?), then Budget (can it afford it?). The first
// DENY wins; otherwise the Budget verdict (which may be an ADVISORY warning)
// is returned.
// ============================================================================

function withEvidence(action: GovernedAction, policy: LanePolicy, v: GateVerdict): EvaluationResult {
  return {
    ...v,
    evidence: {
      actor: policy.agentId,
      actionType: action.type,
      gate: v.gate,
      verdict: v.verdict,
      mai: v.mai,
      rule: v.rule,
      reason: v.reason,
      tokensEstimated: action.tokensEstimated,
    },
  };
}

export function evaluateAction(
  action: GovernedAction,
  policy: LanePolicy,
  state: LaneBudgetState,
): EvaluationResult {
  if (action.type === 'complete') {
    return withEvidence(action, policy, completionGate(action, policy));
  }

  const delegation = delegationGate(action, policy, state);
  if (delegation.verdict === 'DENY') {
    return withEvidence(action, policy, delegation);
  }

  return withEvidence(action, policy, budgetGate(action, policy, state));
}
