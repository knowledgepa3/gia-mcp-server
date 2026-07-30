/**
 * @module    mcp-tool-registry
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — static tool registration metadata, not a governed operation
 * @owner     William J. Storey III / ACE / GIA
 *
 * TOOL_REGISTRY — the single source of truth for which tool registration
 * functions exist and which visibility tier each belongs to.
 *
 * Split out of server.ts (2026-07-14, quality review — critical): server.ts's
 * module-level `main().catch(...)` boots a real GovernanceEngine, connects a
 * real stdio transport, and calls `process.exit(1)` on init failure — all as a
 * side effect of import. Anything that needs TOOL_REGISTRY for introspection
 * (e.g. the tool-classification drift test) must be able to import it WITHOUT
 * pulling in that boot behavior. This file has zero side effects on import.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../core/governance.js';

// Import tool handlers (thin wrappers)
import { registerClassifyDecisionTool } from './tools/classify-decision.js';
import { registerGetGateStatusTool } from './tools/get-gate-status.js';
import { registerEvaluateThresholdTool } from './tools/evaluate-threshold.js';
import { registerEvaluateRoutingThresholdTool } from './tools/evaluate-routing-threshold.js';
import { registerScoreGovernanceTool } from './tools/score-governance.js';
import { registerAuditPipelineTool } from './tools/audit-pipeline.js';
import { registerMonitorAgentsTool } from './tools/monitor-agents.js';
import { registerMapComplianceTool } from './tools/map-compliance.js';
import { registerAssessRiskTierTool } from './tools/assess-risk-tier.js';
import { registerGenerateReportTool } from './tools/generate-report.js';
import { registerSystemStatusTool } from './tools/system-status.js';
import { registerApproveGateTool } from './tools/approve-gate.js';
import { registerAgentRightsTool } from './tools/agent-rights.js';
import { registerPrecedentTools } from './tools/precedent.js';
import { registerCitizenshipTools } from './tools/citizenship.js';
import { registerBranchAuthorityTools } from './tools/branchAuthority.js';
import { registerColonyTools } from './tools/colony.js';
import { registerMemoryPackTools } from './tools/memory-packs.js';
import { registerValueMetricsTools } from './tools/value-metrics.js';
import { registerValueReportTools } from './tools/value-report.js';
import { registerSRTTools } from './tools/srt.js';
import { registerVerifyLedgerTool } from './tools/verify-ledger.js';
import { registerVerifyLedgerV2Tool } from './tools/verify-ledger-v2.js';
import { registerExportLedgerTool } from './tools/export-ledger.js';
import { registerRemediationPackTools } from './tools/remediation-packs.js';
import { registerPhoenixRecoveryTools } from './tools/phoenix-recovery.js';
import { registerContextAuthorityTool } from './tools/context-authority.js';
import { registerInstitutionTools } from './tools/institution.js';
import { registerContextReviveTool } from './tools/context-revive.js';
import { registerGovernedSamplingTool } from './tools/governed-sampling.js';
import { registerChainOfReasoningTools } from './tools/chain-of-reasoning.js';

// ============================================================================
// Tool Visibility Tiers — Tenant Isolation for External MCP Clients
// ============================================================================
//
// Three tiers control which tools are registered per session:
//   PUBLIC   — stateless scoring/classification tools, safe for any external client
//   TENANT   — tools that access data, filtered by tenant ID (professional+ tier)
//   OPERATOR — internal infrastructure tools (local stdio only, never exposed externally)
//
// The Smithery gateway and all HTTP clients get PUBLIC by default.
// Paying customers (professional/enterprise DB keys) get PUBLIC + TENANT.
// Local stdio (Claude Code / Claude Desktop) gets all tiers (OPERATOR).
// ============================================================================

export type ToolVisibility = 'public' | 'tenant' | 'operator';

/**
 * Maps each tool registration function to its visibility tier.
 * Grouped by the tier each set of tools belongs to.
 */
export const TOOL_REGISTRY: Array<{
  tier: ToolVisibility;
  register: (server: McpServer, engine: GovernanceEngine) => void;
  description: string;
}> = [
  // --- PUBLIC: Stateless governance scoring — no data exposure ---
  { tier: 'public', register: registerClassifyDecisionTool, description: 'classify_decision' },
  { tier: 'tenant', register: registerGetGateStatusTool, description: 'get_gate_status (agent-side gate wait after MANDATORY classification)' },
  { tier: 'public', register: registerEvaluateThresholdTool, description: 'evaluate_threshold' },
  { tier: 'public', register: registerScoreGovernanceTool, description: 'score_governance' },
  { tier: 'public', register: registerAssessRiskTierTool, description: 'assess_risk_tier' },
  { tier: 'public', register: registerMapComplianceTool, description: 'map_compliance' },
  { tier: 'public', register: registerVerifyLedgerTool, description: 'verify_ledger (in-memory self-consistency)' },
  { tier: 'tenant', register: registerVerifyLedgerV2Tool, description: 'verify_ledger_v2 (persisted-row, epoch-aware content verification)' },

  // --- TENANT: Data-bearing tools, scoped to authenticated tenant ---
  { tier: 'tenant', register: registerAuditPipelineTool, description: 'audit_pipeline' },
  { tier: 'tenant', register: registerMonitorAgentsTool, description: 'monitor_agents' },
  { tier: 'tenant', register: registerEvaluateRoutingThresholdTool, description: 'evaluate_routing_threshold (MRT — routing health: fallback, cache, batch, leakage)' },
  { tier: 'tenant', register: registerSystemStatusTool, description: 'system_status' },
  { tier: 'tenant', register: registerGenerateReportTool, description: 'generate_report' },
  { tier: 'tenant', register: registerExportLedgerTool, description: 'export_ledger' },
  { tier: 'tenant', register: registerValueMetricsTools, description: 'value_metrics (record_value_metric, record_governance_event, generate_impact_report)' },
  // OPERATOR tier (review 2026-07-10): the wrapper authenticates upstream with the
  // INTERNAL key and takes a caller-chosen tenant_id — at tenant tier an external
  // MCP client could generate (and ledger-anchor) reports over ANY tenant's sessions.
  { tier: 'operator', register: registerValueReportTools, description: 'value_report (generate_value_report — draft ledger-anchored economic value report; release is human-ISSO-only)' },
  { tier: 'tenant', register: registerMemoryPackTools, description: 'memory_packs (seal, load, transfer, compose, distill, promote)' },
  { tier: 'tenant', register: registerPhoenixRecoveryTools, description: 'phoenix (snapshot, verify_integrity, recovery_health)' },
  { tier: 'public', register: registerContextAuthorityTool, description: 'request_context (governed context authority)' },
  { tier: 'tenant', register: (server, _engine) => registerInstitutionTools(server), description: 'board (list_institutions, list_charters, convene_session, get_session, install_kit)' },

  // --- OPERATOR: Internal infrastructure — never exposed to external clients ---
  { tier: 'operator', register: registerApproveGateTool, description: 'approve_gate' },
  { tier: 'tenant', register: registerAgentRightsTool, description: 'agent_rights (Colony Phase 3 — constitutional rights)' },
  { tier: 'tenant', register: registerPrecedentTools, description: 'board_search_precedent (Colony Layer 1 — precedent case law)' },
  { tier: 'tenant', register: registerCitizenshipTools, description: 'agent_citizenship_status (Colony Layer 5 — merit-based trust)' },
  { tier: 'tenant', register: registerBranchAuthorityTools, description: 'branch_authority_status (Colony Layer 4 — separation of powers)' },
  { tier: 'tenant', register: registerColonyTools, description: 'colony (convene_request, suggestion, health — Colony Autonomy)' },
  { tier: 'tenant', register: registerContextReviveTool, description: 'context_revive (status, compact, verify, history)' },
  { tier: 'tenant', register: registerGovernedSamplingTool, description: 'governed_sample (client-mediated governed cognition via MCP Sampling)' },
  { tier: 'tenant', register: registerChainOfReasoningTools, description: 'chain_of_reasoning (Governed Cognition provenance trail)' },
  { tier: 'operator', register: registerSRTTools, description: 'srt (run_watchdog, diagnose, approve_repair, generate_postmortem)' },
  { tier: 'operator', register: registerRemediationPackTools, description: 'remediation (scan_environment, list_packs, dry_run_pack, apply_pack, run_patrol)' },
];
