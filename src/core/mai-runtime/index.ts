// ============================================================================
// MAI Runtime — Slice 1 public surface (Budget + Delegation + Completion gates).
// Standalone, pure, deterministic. NOT wired into the live server — enforcement
// wiring (a pre-tool-use hook over the runtime-accountability wrapper) is a
// post-QA-B step. Spec: docs/superpowers/specs/2026-07-03-mai-runtime-agent-control.md
// ============================================================================

export * from './types.js';
export { delegationGate } from './delegationGate.js';
export { budgetGate } from './budgetGate.js';
export { completionGate } from './completionGate.js';
export { evaluateAction } from './evaluator.js';
export { summarizeWaste, type WasteSummary } from './wasteMetrics.js';
export { runThisSessionProof, LANE_E_POLICY, LANE_E_EVENTS } from './proof/thisSessionWaste.js';
