/**
 * @module    mcp-server
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — server initialization, not a governed operation
 * @audit     true — server start/stop recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA MCP Server — the transport layer.
 * Translates MCP protocol to/from CORE governance engine.
 * Zero business logic. Zero governance logic. Translate, validate, delegate.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { GovernanceEngine } from '../core/governance.js';
import { MaiClassification, GiaLayer } from '../shared/types.js';
import { GIA_VERSION, GIA_SERVER_NAME, GIA_DESCRIPTION, MAX_INPUT_LENGTH } from '../shared/constants.js';
import { GovernedError } from '../shared/errors.js';
import { generateAuditId, sanitize } from '../shared/utils.js';
import { ACE_MAI_CONFIG, GOVERNANCE_CONFIG } from '../config/governance.config.js';

// Import tool handlers (thin wrappers)
import { registerClassifyDecisionTool } from './tools/classify-decision.js';
import { registerEvaluateThresholdTool } from './tools/evaluate-threshold.js';
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
import { registerSRTTools } from './tools/srt.js';
import { registerVerifyLedgerTool } from './tools/verify-ledger.js';
import { registerExportLedgerTool } from './tools/export-ledger.js';
import { registerRemediationPackTools } from './tools/remediation-packs.js';
import { registerPhoenixRecoveryTools } from './tools/phoenix-recovery.js';
import { registerGovernedRetrievalTools } from './tools/governed-retrieval.js';
import { registerContextAuthorityTool } from './tools/context-authority.js';
import { registerInstitutionTools } from './tools/institution.js';
import { registerContextReviveTool } from './tools/context-revive.js';
import { registerGovernedSamplingTool } from './tools/governed-sampling.js';
import { registerChainOfReasoningTools } from './tools/chain-of-reasoning.js';
import { GovernedSampling } from '../core/sampling/index.js';

// Runtime accountability instrumentation — wraps server.tool() registrations
// so every invocation is bookended with startSession()/endSession().
import { wrapServerWithRuntimeAccountability } from './runtime-accountability-wrapper.js';

// Import resource handlers
import { registerResources } from './resources/index.js';

// Import prompt handlers
import { registerPrompts } from './prompts/index.js';

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
const TOOL_REGISTRY: Array<{
  tier: ToolVisibility;
  register: (server: McpServer, engine: GovernanceEngine) => void;
  description: string;
}> = [
  // --- PUBLIC: Stateless governance scoring — no data exposure ---
  { tier: 'public', register: registerClassifyDecisionTool, description: 'classify_decision' },
  { tier: 'public', register: registerEvaluateThresholdTool, description: 'evaluate_threshold' },
  { tier: 'public', register: registerScoreGovernanceTool, description: 'score_governance' },
  { tier: 'public', register: registerAssessRiskTierTool, description: 'assess_risk_tier' },
  { tier: 'public', register: registerMapComplianceTool, description: 'map_compliance' },
  { tier: 'public', register: registerVerifyLedgerTool, description: 'verify_ledger' },

  // --- TENANT: Data-bearing tools, scoped to authenticated tenant ---
  { tier: 'tenant', register: registerAuditPipelineTool, description: 'audit_pipeline' },
  { tier: 'tenant', register: registerMonitorAgentsTool, description: 'monitor_agents' },
  { tier: 'tenant', register: registerSystemStatusTool, description: 'system_status' },
  { tier: 'tenant', register: registerGenerateReportTool, description: 'generate_report' },
  { tier: 'tenant', register: registerExportLedgerTool, description: 'export_ledger' },
  { tier: 'tenant', register: registerValueMetricsTools, description: 'value_metrics (record_value_metric, record_governance_event, generate_impact_report)' },
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

/** Governed retrieval tools need special handling (no engine param) */
const GOVERNED_RETRIEVAL_TIER: ToolVisibility = 'tenant';

/**
 * Determine which tier ceiling applies based on visibility level.
 * A level includes all tiers at or below it:
 *   operator → public + tenant + operator (all)
 *   tenant   → public + tenant
 *   public   → public only
 */
const TIER_CEILING: Record<ToolVisibility, Set<ToolVisibility>> = {
  public:   new Set(['public']),
  tenant:   new Set(['public', 'tenant']),
  operator: new Set(['public', 'tenant', 'operator']),
};

/**
 * Create and configure a GIA MCP Server instance.
 *
 * Factory function shared by all transport entry points (stdio, HTTP, SSE).
 * Returns the configured server + engine without connecting any transport.
 *
 * @param maxVisibility — controls which tools are registered:
 *   'operator' (default, stdio) — all 32 tools
 *   'tenant'  — public + tenant tools (paying HTTP clients)
 *   'public'  — public tools only (Smithery gateway, free/legacy keys)
 *
 * Startup sequence (per mcp-standards.md):
 * 1. Load configuration
 * 2. Initialize CORE governance engine
 * 3. Validate CORE initialization
 * 4. Register MCP tools (filtered by visibility)
 * 5. Register MCP resources
 * 6. Register MCP prompts
 * 7. Log server start to forensic ledger
 *
 * If ANY step fails, throws — caller decides how to handle.
 */
export async function createGIAServer(maxVisibility: ToolVisibility = 'operator'): Promise<{
  server: McpServer;
  engine: GovernanceEngine;
}> {
  // Step 1: Load configuration
  const config = GOVERNANCE_CONFIG;

  // Step 2: Initialize CORE governance engine
  const engine = new GovernanceEngine();
  engine.classifier.registerVertical(ACE_MAI_CONFIG);
  if (config.autoRunMode) {
    engine.enableAutoRun();
  }

  // Step 3: Validate CORE initialization (now async — recovers ledger from PostgreSQL)
  await engine.initialize();
  if (!engine.isHealthy()) {
    throw new Error('Governance engine failed initialization.');
  }

  // Step 4: Create MCP server
  const server = new McpServer({
    name: GIA_SERVER_NAME,
    version: GIA_VERSION,
  });

  // Step 4a: Wrap the server with the runtime-accountability Proxy so every
  // tool registration is transparently instrumented. All `.tool()` calls below
  // — whether from TOOL_REGISTRY entries, governed retrieval, or the inline
  // list_available_tools — go through this Proxy and are bracketed with
  // runtimeService.startSession()/endSession() at invocation time.
  const instrumentedServer = wrapServerWithRuntimeAccountability(server, engine);

  // Step 4b: Initialize Governed Sampling (needs Server ref from McpServer).
  // Sampling uses the underlying server.server; instrumentation is at the tool
  // surface, not the sampling surface (sampling has its own governance path).
  const sampling = new GovernedSampling(engine, server.server);
  engine.setSampling(sampling);

  // Step 5: Register MCP tools — filtered by visibility tier.
  // All registrations route through `instrumentedServer` so handlers are wrapped.
  const allowedTiers = TIER_CEILING[maxVisibility];
  let registeredCount = 0;

  for (const entry of TOOL_REGISTRY) {
    if (allowedTiers.has(entry.tier)) {
      entry.register(instrumentedServer, engine);
      registeredCount++;
    }
  }

  // Governed retrieval (special: no engine param)
  if (allowedTiers.has(GOVERNED_RETRIEVAL_TIER)) {
    registerGovernedRetrievalTools(instrumentedServer);
    registeredCount++;
  }

  // Register a public introspection tool so external clients can see what's available at their tier
  instrumentedServer.tool(
    'list_available_tools',
    'List which GIA tools are available at your current access tier. Returns tool names grouped by tier with descriptions.',
    {},
    { title: 'List Available Tools', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const available = TOOL_REGISTRY
        .filter(entry => allowedTiers.has(entry.tier))
        .map(entry => ({ tier: entry.tier, tools: entry.description }));
      const blocked = TOOL_REGISTRY
        .filter(entry => !allowedTiers.has(entry.tier))
        .map(entry => ({ tier: entry.tier, tools: entry.description, reason: `Requires ${entry.tier} tier access. Current: ${maxVisibility}.` }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          currentTier: maxVisibility,
          availableToolGroups: available.length,
          blockedToolGroups: blocked.length,
          available,
          blocked,
        }, null, 2) }],
      };
    },
  );
  registeredCount++;

  console.error(`[GIA] Tool visibility: ${maxVisibility} — registered ${registeredCount}/${TOOL_REGISTRY.length + 1} tool groups`);

  // Step 6: Register MCP resources (Proxy forwards non-tool methods unchanged)
  registerResources(instrumentedServer, engine);

  // Step 7: Register MCP prompts (Proxy forwards non-tool methods unchanged)
  registerPrompts(instrumentedServer, engine);

  // Step 8: Log server start to forensic ledger
  const startEntry = engine.ledger.begin('mcp-server-start', MaiClassification.MANDATORY, GiaLayer.MCP);
  startEntry.addMetadata('version', GIA_VERSION);
  startEntry.addMetadata('autoRunMode', config.autoRunMode);
  startEntry.addMetadata('toolVisibility', maxVisibility);
  const startScore = engine.scorer.scoreDefault('mcp-server-start');
  const completedStart = startEntry.complete(startScore, {
    classification: MaiClassification.MANDATORY,
    confidence: 1.0,
    rationale: `MCP server started successfully. Tool visibility: ${maxVisibility}.`,
    requiresGate: false,
  });
  engine.ledger.record(completedStart);

  // Return the instrumented Proxy so callers (stdio/HTTP entry points) connect
  // through the wrapper. Non-tool method calls (e.g. server.connect(transport))
  // are forwarded to the underlying McpServer with `this` correctly bound.
  return { server: instrumentedServer, engine };
}

/**
 * Stdio entry point — used by Claude Code and Claude Desktop.
 * This is the default `main` export when running `node dist/mcp/server.js`.
 */
async function main(): Promise<void> {
  const { server, engine } = await createGIAServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Lifecycle: Stdio Session Init (Reference Transport) ---
  const sessionEntry = engine.ledger.begin('mcp-session-init', MaiClassification.ADVISORY, GiaLayer.MCP, 'LOCAL');
  sessionEntry.addMetadata('transport', 'stdio');
  sessionEntry.addMetadata('tier', 'operator');
  sessionEntry.addMetadata('toolVisibility', 'operator');
  sessionEntry.addMetadata('version', GIA_VERSION);
  sessionEntry.addMetadata('referenceTransport', true);
  const sessionScore = engine.scorer.scoreDefault('mcp-session-init');
  const completedSession = sessionEntry.complete(sessionScore, {
    classification: MaiClassification.ADVISORY,
    confidence: 1.0,
    rationale: 'MCP stdio session created. Reference transport: operator tier, full tool visibility.',
    requiresGate: false,
  });
  engine.ledger.record(completedSession);

  console.error(`[GIA] Governed Intelligence Architecture MCP Server v${GIA_VERSION}`);
  console.error(`[GIA] Author: William J. Storey III`);
  console.error(`[GIA] Transport: stdio (reference)`);
  console.error(`[GIA] Accepting connections.`);
}

main().catch((error) => {
  console.error('[GIA] FATAL: Server startup failed:', error);
  process.exit(1);
});
