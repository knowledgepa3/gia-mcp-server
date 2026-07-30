// ============================================================================
// MAI Runtime — shared types for the deterministic agent-control gates.
// Spec: docs/superpowers/specs/2026-07-03-mai-runtime-agent-control.md
//
// Standalone proof module (Slice 1). NOT wired into the live server — the
// gates are pure functions so they can be unit-tested and run against a
// recorded event log to produce a before/after waste report.
//
// MaiClass mirrors the shared MaiClassification enum values by string, kept
// local so this module has no coupling to the runtime engine.
// ============================================================================

export type MaiClass = 'MANDATORY' | 'ADVISORY' | 'INFORMATIONAL';

export type GovernedActionType =
  | 'spawn_subagent'
  | 'delegate'
  | 'tool_call'
  | 'model_invoke'
  | 'retrieve'
  | 'handoff'
  | 'complete';

export interface GovernedAction {
  type: GovernedActionType;
  /** estimated tokens this action would consume (for the budget gate) */
  tokensEstimated?: number;
  /** for `complete` actions: the artifact the agent is returning */
  artifact?: unknown;
  /** raw text the agent returned (advisory delegation-claim scan) */
  text?: string;
}

export interface DelegationPolicy {
  allowed: boolean;
  maxSubagents: number;
}

export interface BudgetPolicy {
  maxTokens?: number;
  maxToolCalls?: number;
  maxSubagents?: number;
  /** fraction of a cap at which to emit an ADVISORY warning (default 0.8) */
  advisoryThresholdPct?: number;
}

export interface CompletionPolicy {
  /** artifact must be an object carrying every one of these keys, non-empty */
  requiredArtifactFields: string[];
}

export interface LanePolicy {
  agentId: string;
  mission: string;
  delegation: DelegationPolicy;
  budget?: BudgetPolicy;
  completion?: CompletionPolicy;
}

export interface LaneBudgetState {
  subagentsSpawned: number;
  tokensSpent?: number;
  toolCallsMade?: number;
}

export type GateVerdictType = 'ALLOW' | 'DENY';

export interface GateVerdict {
  gate: 'delegation' | 'budget' | 'completion';
  verdict: GateVerdictType;
  mai: MaiClass;
  /** machine rule code when DENY/blocked (e.g. NO_DELEGATION_WITHOUT_AUTHORITY) */
  rule?: string;
  reason?: string;
}

/**
 * The shape written to the forensic ledger for each evaluated action.
 * PII-safe by construction — carries the decision, not the payload. (A real
 * ledger write adds timestamp + hash-chain; kept out of the pure core so the
 * gates stay deterministic and testable.)
 */
export interface EvidenceRecord {
  actor: string;
  actionType: GovernedActionType;
  gate: GateVerdict['gate'];
  verdict: GateVerdictType;
  mai: MaiClass;
  rule?: string;
  reason?: string;
  tokensEstimated?: number;
}

export interface EvaluationResult extends GateVerdict {
  evidence: EvidenceRecord;
}
