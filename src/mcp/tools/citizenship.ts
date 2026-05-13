/**
 * @module    mcp-tool-citizenship
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       I — citizenship queries are INFORMATIONAL; A — assessments are ADVISORY
 * @audit     true — assessments logged via telemetry
 * @owner     William J. Storey III / ACE / GIA
 * @colony    Layer 5 — Agent Citizenship & Merit
 *
 * MCP tool for querying agent citizenship status and triggering merit assessments.
 * AD Analogy: "gpresult /r" for AI agents — shows effective trust level and
 * the performance metrics that earned it.
 *
 * "Static roles don't reflect actual capability. Merit-based trust creates
 *  incentives for quality and accountability."
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerCitizenshipTools(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'agent_citizenship_status',
    'Query agent citizenship tier and merit score (Colony Layer 5). Actions: status (view citizenship and metrics), assess (trigger merit re-evaluation), leaderboard (top agents by merit). Agents earn trust through deliberation quality, behavioral health, gate approval rates, and responsible rights exercise.',
    {
      action: z.enum(['status', 'assess', 'leaderboard']).describe(
        'Action: status = view agent citizenship; assess = trigger merit assessment; leaderboard = top agents'
      ),
      agent_id: z.string().optional().describe('Agent ID (required for status and assess)'),
      limit: z.number().min(1).max(50).optional().describe('Max results for leaderboard (default: 10)'),
    },
    {
      title: 'Agent Citizenship & Merit',
      readOnlyHint: false,
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
          if (!input.agent_id) {
            result = { error: 'agent_id required for status action' };
          } else {
            const resp = await fetch(`${apiBase}/api/citizenship/${encodeURIComponent(input.agent_id)}`, { headers: authHeaders });
            if (!resp.ok) {
              const body = await resp.json() as Record<string, unknown>;
              result = { error: body.error || `HTTP ${resp.status}`, agentId: input.agent_id };
            } else {
              result = await resp.json() as Record<string, unknown>;
            }
          }
        } else if (input.action === 'assess') {
          if (!input.agent_id) {
            result = { error: 'agent_id required for assess action' };
          } else {
            const resp = await fetch(`${apiBase}/api/citizenship/${encodeURIComponent(input.agent_id)}/assess`, {
              method: 'POST',
              headers: authHeaders,
            });
            if (!resp.ok) {
              const body = await resp.json() as Record<string, unknown>;
              result = { error: body.error || `HTTP ${resp.status}`, agentId: input.agent_id };
            } else {
              result = await resp.json() as Record<string, unknown>;
            }
          }
        } else if (input.action === 'leaderboard') {
          const limit = input.limit ?? 10;
          const resp = await fetch(`${apiBase}/api/citizenship/leaderboard?limit=${limit}`, { headers: authHeaders });
          if (!resp.ok) {
            result = { error: `Leaderboard request failed (HTTP ${resp.status})` };
          } else {
            result = await resp.json() as Record<string, unknown>;
          }
        } else {
          result = { error: `Unknown action: ${input.action}` };
        }
      } catch (err: unknown) {
        result = {
          error: 'Failed to query citizenship — GIA Express API may be unreachable',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // Telemetry
      engine.telemetryService.emitToolCall('agent_citizenship_status', `cit-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
