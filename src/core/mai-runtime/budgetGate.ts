import type { GovernedAction, LanePolicy, LaneBudgetState, GateVerdict } from './types.js';

// ============================================================================
// Gate #3 — Budget. A task cannot consume unlimited tokens, tool-calls, or
// sub-agents. Over a cap → MANDATORY stop ("return what you have"); crossing the
// advisory threshold (default 80% of a cap) → ADVISORY warning; otherwise
// INFORMATIONAL. Fully deterministic (counters vs caps).
// ============================================================================

const DEFAULT_ADVISORY_PCT = 0.8;

function allow(mai: GateVerdict['mai']): GateVerdict {
  return { gate: 'budget', verdict: 'ALLOW', mai };
}

function deny(rule: string, reason: string): GateVerdict {
  return { gate: 'budget', verdict: 'DENY', mai: 'MANDATORY', rule, reason };
}

export function budgetGate(
  action: GovernedAction,
  policy: LanePolicy,
  state: LaneBudgetState,
): GateVerdict {
  const budget = policy.budget;
  if (!budget) return allow('INFORMATIONAL');

  // Sub-agent budget (a spend cap distinct from delegation *authority*).
  if ((action.type === 'spawn_subagent' || action.type === 'delegate') && budget.maxSubagents != null) {
    if (state.subagentsSpawned >= budget.maxSubagents) {
      return deny('SUBAGENT_BUDGET_EXCEEDED', `Sub-agent budget of ${budget.maxSubagents} reached`);
    }
  }

  // Tool-call budget.
  if (action.type === 'tool_call' && budget.maxToolCalls != null) {
    if ((state.toolCallsMade ?? 0) >= budget.maxToolCalls) {
      return deny('TOOLCALL_BUDGET_EXCEEDED', `Tool-call budget of ${budget.maxToolCalls} reached`);
    }
  }

  // Token budget — projected spend = already spent + this action's estimate.
  if (budget.maxTokens != null && action.tokensEstimated != null) {
    const projected = (state.tokensSpent ?? 0) + action.tokensEstimated;
    if (projected > budget.maxTokens) {
      return deny('TOKEN_BUDGET_EXCEEDED', `Projected ${projected} tokens exceeds cap ${budget.maxTokens}`);
    }
    const threshold = (budget.advisoryThresholdPct ?? DEFAULT_ADVISORY_PCT) * budget.maxTokens;
    if (projected >= threshold) {
      return allow('ADVISORY');
    }
  }

  return allow('INFORMATIONAL');
}
