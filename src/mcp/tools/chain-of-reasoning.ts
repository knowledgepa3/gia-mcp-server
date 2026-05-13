/**
 * @module    mcp-tool-chain-of-reasoning
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       I — chain queries are INFORMATIONAL (read-only)
 * @audit     true — queries logged via telemetry
 * @owner     William J. Storey III / ACE / GIA
 *
 * MCP tool for querying the Chain of Reasoning — the unified provenance
 * trail linking every governed cognitive act (AI Brain assessments,
 * deliberations, precedent citations, gate decisions, knowledge pack
 * usage, merit transitions, colony events) into one hash-verified chain.
 *
 * "Governed Cognition and Institutional AI, powered by a Chain of Reasoning."
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerChainOfReasoningTools(server: McpServer, _engine: GovernanceEngine): void {
  server.tool(
    'chain_of_reasoning',
    'Reconstruct the complete Chain of Reasoning for a governed session, agent, or time range. Returns every link — AI Brain state, deliberation steps, precedent cited, gate decisions, knowledge packs, merit assessments — in causal order with hash-chain verification. Use "summary" format for a quick overview, "full" for all links, "dag" for the causal graph, or "export" for an EU AI Act compliance artifact.',
    {
      scope: z.enum(['session', 'agent', 'time_range']).describe(
        'What to query: "session" for a specific committee session, "agent" for an agent over time, "time_range" for all activity in a period.'
      ),
      session_id: z.string().optional().describe(
        'Committee session ID (required when scope = "session"). Format: cs-{uuid}'
      ),
      agent_id: z.string().optional().describe(
        'Agent ID (required when scope = "agent"). Can be a user ID or model name.'
      ),
      start: z.string().optional().describe(
        'Start of time range (ISO 8601). Default: 7 days ago.'
      ),
      end: z.string().optional().describe(
        'End of time range (ISO 8601). Default: now.'
      ),
      format: z.enum(['summary', 'full', 'dag', 'export']).default('summary').describe(
        'Response format: "summary" = stats only, "full" = all links, "dag" = causal graph with edges, "export" = EU AI Act compliance artifact.'
      ),
      limit: z.number().int().min(1).max(500).optional().describe(
        'Maximum number of links to return (default: 100, max: 500). Only applies to "full" format.'
      ),
    },
    {
      title: 'Chain of Reasoning',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';

      try {
        let url: string;
        const params = new URLSearchParams();

        if (input.scope === 'session') {
          if (!input.session_id) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'session_id required when scope = "session"' }) }] };
          }

          if (input.format === 'dag') {
            url = `${apiBase}/api/chain-of-reasoning/session/${input.session_id}/dag`;
          } else if (input.format === 'export') {
            url = `${apiBase}/api/chain-of-reasoning/session/${input.session_id}/export`;
          } else {
            url = `${apiBase}/api/chain-of-reasoning/session/${input.session_id}`;
          }
        } else if (input.scope === 'agent') {
          if (!input.agent_id) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'agent_id required when scope = "agent"' }) }] };
          }
          url = `${apiBase}/api/chain-of-reasoning/agent/${encodeURIComponent(input.agent_id)}`;
          if (input.start) params.set('start', input.start);
          if (input.end) params.set('end', input.end);
          if (input.limit) params.set('limit', String(input.limit));
        } else {
          url = `${apiBase}/api/chain-of-reasoning/time-range`;
          if (input.start) params.set('start', input.start);
          if (input.end) params.set('end', input.end);
          if (input.limit) params.set('limit', String(input.limit));
        }

        const queryString = params.toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;

        const resp = await fetch(fullUrl, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (!resp.ok) {
          const body = await resp.text();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: `Chain of Reasoning query failed (HTTP ${resp.status})`,
              detail: body,
            }) }],
          };
        }

        const data = await resp.json() as Record<string, unknown>;

        // For summary format, strip the full links array to reduce token usage
        if (input.format === 'summary' && data.links) {
          const links = data.links as Array<Record<string, unknown>>;
          data.linksPreview = links.slice(0, 5).map(l => ({
            operation: l.operation,
            timestamp: l.timestamp,
            actor: l.actor,
            maiLevel: l.maiLevel,
          }));
          delete data.links;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Chain of Reasoning query failed',
            detail: (err as Error).message,
          }) }],
        };
      }
    },
  );
}
