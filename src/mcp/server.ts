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

// Tool registration function references + visibility tiers live in
// toolRegistry.ts (moved 2026-07-14 — see file header there for why: import
// side effects). server.ts only needs the array and the type here.
import { TOOL_REGISTRY, type ToolVisibility } from './toolRegistry.js';
// Authoritative tool count — proven equal to the registered tool set by
// tests/mcp/tool-classification-drift.test.ts. Never hand-count.
import { GIA_TOOL_COUNT } from './toolClassifications.js';
// Re-export the type (not the array/value) for existing consumers (e.g.
// server-http.ts) that import ToolVisibility from server.js. TOOL_REGISTRY
// itself is intentionally NOT re-exported here — it flows through
// src/index.ts's `export *`, the published npm package's public entry point,
// and would expose operator-tier-only registration functions to consumers.
export type { ToolVisibility } from './toolRegistry.js';
import { registerGovernedRetrievalTools } from './tools/governed-retrieval.js';
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
//
// TOOL_REGISTRY itself (the array + its tier metadata) lives in
// toolRegistry.ts — imported above — so it can be introspected (e.g. by the
// tool-classification drift test) without triggering this module's
// import-time main() boot sequence.
// ============================================================================

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
export async function createGIAServer(
  maxVisibility: ToolVisibility = 'operator',
  existingEngine?: GovernanceEngine,
): Promise<{
  server: McpServer;
  engine: GovernanceEngine;
}> {
  // Step 1: Load configuration
  const config = GOVERNANCE_CONFIG;

  // Step 2-3: Governance engine.
  // When an existingEngine is supplied (e.g. multiple concurrent worker sessions
  // for the same tenant), reuse it — its ledger is already recovered and its
  // GovernedSampling already wired. This avoids triggering a full ForensicLedger
  // recovery (16k+ entries) per session. Otherwise build + initialize a fresh one.
  const reuseEngine = existingEngine !== undefined;
  const engine = existingEngine ?? new GovernanceEngine();
  if (!reuseEngine) {
    engine.classifier.registerVertical(ACE_MAI_CONFIG);
    if (config.autoRunMode) {
      engine.enableAutoRun();
    }
    // Validate CORE initialization (async — recovers ledger from PostgreSQL)
    await engine.initialize();
    if (!engine.isHealthy()) {
      throw new Error('Governance engine failed initialization.');
    }
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
  // Skipped on engine reuse — the shared engine already has its sampling wired,
  // and the public (worker) tier does not expose the governed_sample tool anyway.
  if (!reuseEngine) {
    const sampling = new GovernedSampling(engine, server.server);
    engine.setSampling(sampling);
  }

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
      // The two groups registered outside TOOL_REGISTRY. Omitting them made this
      // tool report 31 groups while the startup banner reported 33 — two
      // different counts of the same thing from the same process.
      if (allowedTiers.has(GOVERNED_RETRIEVAL_TIER)) {
        available.push({ tier: GOVERNED_RETRIEVAL_TIER, tools: 'gia_retrieve, gia_ingest_document (governed retrieval)' });
      }
      available.push({ tier: 'public' as ToolVisibility, tools: 'list_available_tools (this tool)' });
      const blocked = TOOL_REGISTRY
        .filter(entry => !allowedTiers.has(entry.tier))
        .map(entry => ({ tier: entry.tier, tools: entry.description, reason: `Requires ${entry.tier} tier access. Current: ${maxVisibility}.` }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          currentTier: maxVisibility,
          // Total tools in the catalogue, from the ratified classification map.
          // Group counts below describe registration units, not tool counts —
          // one group can register several tools.
          totalToolsInCatalogue: GIA_TOOL_COUNT,
          availableToolGroups: available.length,
          blockedToolGroups: blocked.length,
          available,
          blocked,
        }, null, 2) }],
      };
    },
  );
  registeredCount++;

  // Denominator counts the two registrations that live outside TOOL_REGISTRY:
  // governed retrieval and the inline list_available_tools. Getting this wrong
  // printed "registered 33/32 tool groups" — a numerator above its own
  // denominator, which reads as a bug in the thing doing the reporting.
  const totalToolGroups = TOOL_REGISTRY.length + 2;
  console.error(
    `[GIA] Tool visibility: ${maxVisibility} — registered ${registeredCount}/${totalToolGroups} tool groups ` +
    `(${GIA_TOOL_COUNT} tools in catalogue)`,
  );

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

  // Graceful shutdown — drain in-flight forensic-ledger writes before exit so a
  // short-lived session (e.g. a scripted client that disconnects immediately)
  // does not lose queued STARTED/COMPLETED rows (F-5). closePersistence() calls
  // drainPendingWrites() first, then closes the pool.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[GIA] Shutting down (${reason}) — draining forensic-ledger writes...`);
    try {
      await engine.ledger.closePersistence();
    } catch (err) {
      console.error('[GIA] Shutdown drain error:', (err as Error).message);
    }
    process.exit(0);
  };
  transport.onclose = () => { void shutdown('transport-closed'); };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  console.error('[GIA] FATAL: Server startup failed:', error);
  process.exit(1);
});
