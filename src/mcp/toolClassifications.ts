// gia-mcp-server/src/mcp/toolClassifications.ts
/**
 * @module    tool-classifications
 * @layer     GOVERNANCE
 * @inherits  governance-root
 * @mai       N/A — this module IS the classification source, not a governed action
 * @audit     false — consulted by the enforcement wrapper, which audits
 * @owner     William J. Storey III / ACE / GIA
 *
 * Single source of truth for every gia-mcp-server MCP tool's MAI classification.
 * Ratified 2026-07-14 — see docs/superpowers/specs/2026-07-14-mcp-tool-mai-classification-design.md
 *
 * A tool NOT in this map is a structural bug — the drift test
 * (tests/mcp/tool-classification-drift.test.ts) fails CI if the set of tools
 * actually registered by server.ts's TOOL_REGISTRY doesn't exactly match the
 * key set here.
 */

import { MaiClassification } from '../shared/types.js';

// GIA_TOOL_COUNT is exported at the foot of this file, once TOOL_CLASSIFICATIONS
// is defined — see the note there on why this map is the authoritative count.

export interface ToolClassificationEntry {
  mai: MaiClassification | 'CONDITIONAL';
  /** Only present when mai === 'CONDITIONAL'. Inspects the tool's raw input
   *  (before Zod parsing has necessarily completed — read defensively) and
   *  returns the effective classification for this specific call. */
  resolve?: (input: Record<string, unknown>) => MaiClassification;
  /** True for tools that already call engine.gate.enforce() internally.
   *  The wrapper records the classification for the drift test's sake but
   *  does NOT re-gate — prevents a double-approval prompt for one action. */
  selfEnforces?: true;
  /** True for tools that ARE the human-approval action itself
   *  (approve_gate, board_approve_gate). Never wrapper-gated — gating a
   *  gate-approval endpoint is a deadlock. srt_approve_repair used to be
   *  here too, until it was found to have no real gate.enforce() behind it
   *  (2026-07-14 audit) — it's now selfEnforces instead. */
  isGateResolver?: true;
}

export const TOOL_CLASSIFICATIONS: Record<string, ToolClassificationEntry> = {
  // ── MANDATORY — already selfEnforces (fixed 2026-07-14) ──
  promote_memory_pack: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  transfer_memory_pack: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  gia_apply_pack: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  // Conditional logic (trust-level, environment scope, etc.) lives inside
  // gia_run_patrol's own gate.enforce() call, not here, because it selfEnforces.
  gia_run_patrol: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  // Conditional logic lives inside context_revive's own gate.enforce() call,
  // not here, because it selfEnforces.
  context_revive: { mai: MaiClassification.MANDATORY, selfEnforces: true },

  // ── MANDATORY — NEW, wrapper-enforced (the one genuinely new gate) ──
  seal_memory_pack: {
    mai: 'CONDITIONAL',
    resolve: (input) => {
      const trust = input['trust_level'];
      return trust === 'SYSTEM' || trust === 'ORG' ? MaiClassification.MANDATORY : MaiClassification.ADVISORY;
    },
  },

  // ── MANDATORY-resolver — the approval action itself, never wrapper-gated ──
  approve_gate: { mai: MaiClassification.MANDATORY, isGateResolver: true },
  board_approve_gate: { mai: MaiClassification.MANDATORY, isGateResolver: true },

  // ── MANDATORY — selfEnforces (reclassified 2026-07-14): srt_approve_repair
  // used to be listed as isGateResolver (trusted like approve_gate/
  // board_approve_gate, which call the real GateManager machinery), but its
  // own "gate" was only a 4-string denylist check on the caller-supplied
  // approved_by field — any other name bypassed it. It now calls a real
  // engine.gate.enforce() internally before marking the repair APPROVED, so
  // it genuinely gates rather than merely resolving a pre-existing gate.
  srt_approve_repair: { mai: MaiClassification.MANDATORY, selfEnforces: true },

  // ── ADVISORY ──
  score_governance: { mai: MaiClassification.ADVISORY },
  generate_report: { mai: MaiClassification.ADVISORY },
  record_value_metric: { mai: MaiClassification.ADVISORY },
  record_governance_event: { mai: MaiClassification.ADVISORY },
  generate_impact_report: { mai: MaiClassification.ADVISORY },
  generate_value_report: { mai: MaiClassification.ADVISORY },
  compose_memory_packs: { mai: MaiClassification.ADVISORY },
  distill_memory_pack: { mai: MaiClassification.ADVISORY },
  phoenix_snapshot: { mai: MaiClassification.ADVISORY },
  // Conditional logic (SYSTEM-trust elevation) lives inside request_context's
  // own gate.enforce() call, not here, because it selfEnforces. Fleet
  // verification finding (2026-07-14): the MANDATORY label used to be
  // cosmetic — content flowed unconditionally with no real gate call.
  request_context: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  board_convene_session: { mai: MaiClassification.ADVISORY },
  board_install_kit: { mai: MaiClassification.ADVISORY },
  agent_rights: { mai: MaiClassification.ADVISORY },
  colony_convene_request: { mai: MaiClassification.ADVISORY },
  colony_suggestion: { mai: MaiClassification.ADVISORY },
  // Conditional logic lives inside governed_sample's own gate.enforce() call
  // (purpose: 'gate_review_assist'), not here, because it selfEnforces.
  governed_sample: { mai: MaiClassification.MANDATORY, selfEnforces: true },
  chain_of_reasoning: { mai: MaiClassification.ADVISORY },
  srt_run_watchdog: { mai: MaiClassification.ADVISORY },
  srt_diagnose: { mai: MaiClassification.ADVISORY },
  srt_generate_postmortem: { mai: MaiClassification.ADVISORY },
  gia_scan_environment: { mai: MaiClassification.ADVISORY },
  gia_ingest_document: { mai: MaiClassification.ADVISORY },

  // ── INFORMATIONAL ──
  classify_decision: { mai: MaiClassification.INFORMATIONAL },
  get_gate_status: { mai: MaiClassification.INFORMATIONAL },
  evaluate_threshold: { mai: MaiClassification.INFORMATIONAL },
  evaluate_routing_threshold: { mai: MaiClassification.INFORMATIONAL },
  assess_risk_tier: { mai: MaiClassification.INFORMATIONAL },
  map_compliance: { mai: MaiClassification.INFORMATIONAL },
  verify_ledger: { mai: MaiClassification.INFORMATIONAL },
  verify_ledger_v2: { mai: MaiClassification.INFORMATIONAL },
  audit_pipeline: { mai: MaiClassification.INFORMATIONAL },
  monitor_agents: { mai: MaiClassification.INFORMATIONAL },
  system_status: { mai: MaiClassification.INFORMATIONAL },
  export_ledger: { mai: MaiClassification.INFORMATIONAL },
  load_memory_pack: { mai: MaiClassification.INFORMATIONAL },
  phoenix_verify_integrity: { mai: MaiClassification.INFORMATIONAL },
  phoenix_recovery_health: { mai: MaiClassification.INFORMATIONAL },
  board_list_institutions: { mai: MaiClassification.INFORMATIONAL },
  board_list_charters: { mai: MaiClassification.INFORMATIONAL },
  board_get_session: { mai: MaiClassification.INFORMATIONAL },
  board_search_precedent: { mai: MaiClassification.INFORMATIONAL },
  agent_citizenship_status: { mai: MaiClassification.INFORMATIONAL },
  branch_authority_status: { mai: MaiClassification.INFORMATIONAL },
  colony_health: { mai: MaiClassification.INFORMATIONAL },
  gia_list_packs: { mai: MaiClassification.INFORMATIONAL },
  gia_dry_run_pack: { mai: MaiClassification.INFORMATIONAL },
  // Enforces charter contextAccess policy, trust floors, and classification-floor
  // denial logic — active policy enforcement, not a passive read.
  gia_retrieve: { mai: MaiClassification.ADVISORY },
  list_available_tools: { mai: MaiClassification.INFORMATIONAL },
};

/**
 * The number of MCP tools this build serves — the one authoritative count.
 *
 * This map's key set is proven equal to the set of tools the server actually
 * registers by tests/mcp/tool-classification-drift.test.ts (exact match, not
 * subset), so its size is the real tool count and cannot drift from the code.
 *
 * Anything that publishes a tool count — the startup banner, the HTTP server
 * card, `/health`, the README — reads it from here. Hand-maintained counts are
 * what let the README advertise 33 tools while the server served 57.
 */
export const GIA_TOOL_COUNT = Object.keys(TOOL_CLASSIFICATIONS).length;

/** Resolve a classification entry to its effective MAI level for a given call. */
export function resolveClassification(
  entry: ToolClassificationEntry,
  input: Record<string, unknown>
): MaiClassification {
  if (entry.mai === 'CONDITIONAL') {
    if (!entry.resolve) throw new Error('CONDITIONAL classification entry missing resolve()');
    return entry.resolve(input);
  }
  return entry.mai;
}
