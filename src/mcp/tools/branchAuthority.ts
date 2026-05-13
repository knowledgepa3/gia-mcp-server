/**
 * @module    mcp-tool-branchAuthority
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       I — branch authority queries are INFORMATIONAL
 * @audit     true — queries logged via telemetry
 * @owner     William J. Storey III / ACE / GIA
 * @colony    Layer 4 — Separation of Powers
 *
 * MCP tool for querying constitutional branch authority, roster, and violations.
 * Three branches: legislative (charter creation), executive (session convene),
 * judicial (gate review + appeal adjudication).
 *
 * AD Analogy: "whoami /groups" for constitutional governance — shows which
 * branches a user holds authority in and any separation-of-powers violations.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerBranchAuthorityTools(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'branch_authority_status',
    'Colony Layer 4 — Separation of Powers. Query constitutional branch authority for users, view the full roster of authority holders, or inspect branch violations. Three branches: legislative (creates law), executive (executes law), judicial (interprets law).',
    {
      action: z.enum(['status', 'roster', 'violations']).describe(
        'Action: status = user\'s branches; roster = all holders; violations = violation log'
      ),
      user_id: z.string().optional().describe('User ID (required for status action)'),
      limit: z.number().min(1).max(200).optional().describe('Max results (default 50)'),
    },
    {
      title: 'Branch Authority (Separation of Powers)',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      const authHeaders = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      let result: Record<string, unknown>;

      try {
        if (input.action === 'status') {
          if (!input.user_id) {
            result = { error: 'user_id required for status action' };
          } else {
            const resp = await fetch(`${apiBase}/api/branch/user/${encodeURIComponent(input.user_id)}`, { headers: authHeaders });
            if (!resp.ok) {
              const body = await resp.json() as Record<string, unknown>;
              result = { error: body.error || `HTTP ${resp.status}` };
            } else {
              result = await resp.json() as Record<string, unknown>;
            }
          }
        } else if (input.action === 'roster') {
          const resp = await fetch(`${apiBase}/api/branch/roster`, { headers: authHeaders });
          if (!resp.ok) {
            const body = await resp.json() as Record<string, unknown>;
            result = { error: body.error || `HTTP ${resp.status}` };
          } else {
            result = await resp.json() as Record<string, unknown>;
          }
        } else if (input.action === 'violations') {
          const limit = input.limit ?? 50;
          const resp = await fetch(`${apiBase}/api/branch/violations?limit=${limit}`, { headers: authHeaders });
          if (!resp.ok) {
            const body = await resp.json() as Record<string, unknown>;
            result = { error: body.error || `HTTP ${resp.status}` };
          } else {
            result = await resp.json() as Record<string, unknown>;
          }
        } else {
          result = { error: `Unknown action: ${input.action}` };
        }
      } catch (err: unknown) {
        result = {
          error: 'Failed to query branch authority — GIA Express API may be unreachable',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // Telemetry
      engine.telemetryService.emitToolCall('branch_authority_status', `branch-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
