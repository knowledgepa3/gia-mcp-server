/**
 * @module    mcp-tool-audit-pipeline
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — transport only
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerAuditPipelineTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'audit_pipeline',
    'Query the audit ledger for governance entries. Search by operation name or retrieve recent entries. Returns hash-chained audit trail with MAI classification context.',
    {
      operation: z.string().optional().describe('Filter by operation name'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum entries to return'),
      suppress_noise: z.boolean().default(false).describe(
        'When true, filters out known high-volume infrastructure actors (legacy-* prefix, SYSTEM) ' +
        'and lifecycle-only operations (mcp-reinitialize, mcp-initialize) from results. ' +
        'The full forensic ledger is never mutated — this is a view-layer filter only.'
      ),
      exclude_actors: z.array(z.string()).optional().describe(
        'Additional actor IDs or prefixes (prefix matched) to exclude from results. ' +
        'Useful for silencing a specific noisy integration without suppress_noise.'
      ),
    },
    { title: 'Query Audit Ledger', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      // Known noise operations — lifecycle bookkeeping with no governance signal
      const NOISE_OPERATIONS = new Set(['mcp-reinitialize', 'mcp-initialize', 'mcp-session-end']);
      // Legacy/infrastructure actor prefixes excluded when suppress_noise is active
      const NOISE_ACTOR_PREFIXES = ['legacy-', 'SYSTEM'];

      function isNoise(actor: string, operation: string): boolean {
        if (NOISE_OPERATIONS.has(operation)) return true;
        return NOISE_ACTOR_PREFIXES.some(p => actor.startsWith(p));
      }

      function isExcluded(actor: string): boolean {
        const extras = input.exclude_actors ?? [];
        return extras.some(ex => actor === ex || actor.startsWith(ex));
      }

      let entries;
      if (input.operation) {
        entries = engine.ledger.queryByOperation(input.operation);
      } else {
        // Return the most recent completed entries (not time-windowed).
        // Previous behavior used a 1-hour window which returned empty results
        // after restart or low-activity periods. Now returns the N most recent
        // unique operations sorted by timestamp descending.
        entries = engine.ledger.queryCompleted()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      }

      // Apply view-layer filters (forensic ledger is never mutated)
      if (input.suppress_noise || (input.exclude_actors?.length ?? 0) > 0) {
        entries = entries.filter(e => {
          if (input.suppress_noise && isNoise(e.actor, e.operation)) return false;
          if (isExcluded(e.actor)) return false;
          return true;
        });
      }

      const noiseFiltered = input.suppress_noise || (input.exclude_actors?.length ?? 0) > 0;

      const limited = entries.slice(0, input.limit).map(e => ({
        id: e.id,
        operation: e.operation,
        status: e.status,
        // maiLevel = the operation's own MAI classification (e.g. classify-decision is INFORMATIONAL)
        maiLevel: e.maiLevel,
        // decisionMaiLevel = the classified result's MAI level, when the operation produces one
        // Resolves auditor concern: "why is classify-decision INFORMATIONAL if it returned MANDATORY?"
        // Answer: the act of classifying is informational; the decision it classified IS mandatory.
        decisionMaiLevel: (e.metadata?.maiClassification as string) ?? null,
        requiresGate: (e.metadata?.requiresGate as boolean) ?? (e.gateDecision ? true : null),
        layer: e.layer,
        actor: e.actor,
        timestamp: e.timestamp,
        duration: e.duration,
        hasScore: !!e.governanceScore,
        hasGate: !!e.gateDecision,
        // Hash chain fields — tamper-evident audit trail
        entryHash: e.entryHash ?? null,
        previousHash: e.previousHash ?? null,
        chainIndex: e.chainIndex ?? null,
      }));

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('audit_pipeline', `audit-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          totalLedgerEntries: engine.ledger.size,
          uniqueOperations: engine.ledger.uniqueOperations,
          returned: limited.length,
          activeOperations: engine.ledger.getActiveOperations().length,
          chainHead: engine.ledger.chainHead,
          viewFilter: noiseFiltered
            ? { active: true, suppressNoise: input.suppress_noise, excludeActors: input.exclude_actors ?? [], note: 'Forensic ledger is complete — these filters apply to this view only.' }
            : { active: false },
          entries: limited,
        }, null, 2) }],
      };
    }
  );
}
