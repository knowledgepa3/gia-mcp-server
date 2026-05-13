/**
 * @module    mcp-tool-colony
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       A — convene requests are ADVISORY; M — convene approval is MANDATORY
 * @audit     true — all colony actions audited via forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 * @colony    Colony Autonomy — Agent Self-Governance
 *
 * MCP tools for Colony Autonomy — agent-initiated governance actions.
 *
 * Two tools:
 *   colony_convene_request — Request/list/review convene requests
 *   colony_health          — View colony health, trend, trigger snapshot
 *   colony_suggestion      — Suggest/list/review/upvote amendment suggestions
 *
 * "The constitution is alive. Agents can now self-govern within constitutional bounds."
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerColonyTools(server: McpServer, engine: GovernanceEngine): void {

  // ═══════════════════════════════════════════════════════════════
  // colony_convene_request — Session request lifecycle
  // ═══════════════════════════════════════════════════════════════

  server.tool(
    'colony_convene_request',
    'Colony Autonomy: Request, list, or review agent-initiated session convene requests. Actions: request (citizen+ can request a governed session), list (view pending/all requests for a charter), review (elder+ approve/reject a request). Tier-gated: agents earn the right to request and approve sessions through demonstrated merit.',
    {
      action: z.enum(['request', 'list', 'review']).describe(
        'Action: request = submit a convene request; list = view requests; review = approve/reject a request'
      ),
      charter_id: z.string().describe('Charter ID for the request'),
      institution_id: z.string().optional().describe('Institution ID (required for request action)'),
      topic: z.string().optional().describe('Topic for the requested session (required for request action)'),
      rationale: z.string().optional().describe('Why this session is needed'),
      urgency: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('Urgency level (default: normal)'),
      request_id: z.string().optional().describe('Convene request ID (required for review action)'),
      decision: z.enum(['approved', 'rejected']).optional().describe('Review decision (required for review action)'),
      notes: z.string().optional().describe('Review notes'),
      status_filter: z.enum(['pending', 'approved', 'rejected', 'convened', 'expired']).optional().describe('Filter for list action'),
    },
    {
      title: 'Colony Convene Request',
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      let result: Record<string, unknown>;

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        };

        if (input.action === 'request') {
          if (!input.topic || !input.institution_id) {
            result = { error: 'topic and institution_id required for request action' };
          } else {
            const resp = await fetch(
              `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/convene-request`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  topic: input.topic,
                  rationale: input.rationale,
                  urgency: input.urgency || 'normal',
                  institutionId: input.institution_id,
                }),
              },
            );
            result = await resp.json() as Record<string, unknown>;
          }
        } else if (input.action === 'list') {
          const params = new URLSearchParams();
          if (input.status_filter) params.set('status', input.status_filter);
          const resp = await fetch(
            `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/convene-requests?${params}`,
            { headers },
          );
          result = await resp.json() as Record<string, unknown>;
        } else if (input.action === 'review') {
          if (!input.request_id || !input.decision) {
            result = { error: 'request_id and decision required for review action' };
          } else {
            const resp = await fetch(
              `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/convene-request/${encodeURIComponent(input.request_id)}/review`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ decision: input.decision, notes: input.notes }),
              },
            );
            result = await resp.json() as Record<string, unknown>;
          }
        } else {
          result = { error: 'Unknown action' };
        }
      } catch (err: unknown) {
        result = { error: `Colony convene request failed: ${(err as Error).message}` };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // colony_suggestion — Amendment suggestion lifecycle
  // ═══════════════════════════════════════════════════════════════

  server.tool(
    'colony_suggestion',
    'Colony Autonomy: Suggest, list, review, or upvote charter amendment suggestions. Actions: suggest (citizen+ can propose changes), list (view suggestions for a charter), review (elder+ can promote to formal amendment or decline), upvote (citizen+ can signal support). The petition mechanism for governed agents.',
    {
      action: z.enum(['suggest', 'list', 'review', 'upvote']).describe(
        'Action: suggest = propose change; list = view suggestions; review = elder+ review; upvote = signal support'
      ),
      charter_id: z.string().describe('Charter ID'),
      institution_id: z.string().optional().describe('Institution ID (required for suggest action)'),
      summary: z.string().optional().describe('What you want changed (required for suggest action)'),
      detailed_rationale: z.string().optional().describe('Why this change is needed'),
      affected_sections: z.array(z.string()).optional().describe('Charter sections impacted'),
      suggestion_id: z.string().optional().describe('Suggestion ID (required for review/upvote)'),
      decision: z.enum(['under_review', 'promoted', 'declined']).optional().describe('Review decision'),
      feedback: z.string().optional().describe('Review feedback'),
      status_filter: z.enum(['open', 'under_review', 'promoted', 'declined', 'withdrawn']).optional(),
    },
    {
      title: 'Colony Amendment Suggestion',
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      let result: Record<string, unknown>;

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        headers['Authorization'] = `Bearer ${apiKey}`;

        if (input.action === 'suggest') {
          if (!input.summary || !input.institution_id) {
            result = { error: 'summary and institution_id required for suggest action' };
          } else {
            const resp = await fetch(
              `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/suggestion`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  summary: input.summary,
                  detailedRationale: input.detailed_rationale,
                  affectedSections: input.affected_sections,
                  institutionId: input.institution_id,
                }),
              },
            );
            result = await resp.json() as Record<string, unknown>;
          }
        } else if (input.action === 'list') {
          const params = new URLSearchParams();
          if (input.status_filter) params.set('status', input.status_filter);
          const resp = await fetch(
            `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/suggestions?${params}`,
            { headers },
          );
          result = await resp.json() as Record<string, unknown>;
        } else if (input.action === 'review') {
          if (!input.suggestion_id || !input.decision) {
            result = { error: 'suggestion_id and decision required for review action' };
          } else {
            const resp = await fetch(
              `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/suggestion/${encodeURIComponent(input.suggestion_id)}/review`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ decision: input.decision, feedback: input.feedback }),
              },
            );
            result = await resp.json() as Record<string, unknown>;
          }
        } else if (input.action === 'upvote') {
          if (!input.suggestion_id) {
            result = { error: 'suggestion_id required for upvote action' };
          } else {
            const resp = await fetch(
              `${apiBase}/api/colony/${encodeURIComponent(input.charter_id)}/suggestion/${encodeURIComponent(input.suggestion_id)}/upvote`,
              {
                method: 'POST',
                headers,
              },
            );
            result = await resp.json() as Record<string, unknown>;
          }
        } else {
          result = { error: 'Unknown action' };
        }
      } catch (err: unknown) {
        result = { error: `Colony suggestion failed: ${(err as Error).message}` };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // colony_health — Colony-wide health monitoring
  // ═══════════════════════════════════════════════════════════════

  server.tool(
    'colony_health',
    'Colony Autonomy: View colony health score, trend over time, or trigger an on-demand health snapshot. Actions: snapshot (latest health), trend (30-day history), pulse (trigger fresh snapshot). Health score computed from agent distribution, merit averages, deliberation quality, gate efficiency, and constitutional compliance.',
    {
      action: z.enum(['snapshot', 'trend', 'pulse']).describe(
        'Action: snapshot = latest health; trend = 30-day history; pulse = trigger fresh assessment'
      ),
      institution_id: z.string().optional().describe('Institution ID for scoped health (omit for colony-wide)'),
      days: z.number().min(1).max(365).optional().describe('Days of trend history (default: 30)'),
    },
    {
      title: 'Colony Health Monitor',
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      let result: Record<string, unknown>;

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        headers['Authorization'] = `Bearer ${apiKey}`;

        if (input.action === 'snapshot') {
          const params = new URLSearchParams();
          if (input.institution_id) params.set('institutionId', input.institution_id);
          const resp = await fetch(`${apiBase}/api/colony/health?${params}`, { headers });
          result = await resp.json() as Record<string, unknown>;
        } else if (input.action === 'trend') {
          const params = new URLSearchParams();
          if (input.days) params.set('days', String(input.days));
          if (input.institution_id) params.set('institutionId', input.institution_id);
          const resp = await fetch(`${apiBase}/api/colony/health/trend?${params}`, { headers });
          result = await resp.json() as Record<string, unknown>;
        } else if (input.action === 'pulse') {
          const resp = await fetch(`${apiBase}/api/colony/health/snapshot`, {
            method: 'POST',
            headers,
          });
          result = await resp.json() as Record<string, unknown>;
        } else {
          result = { error: 'Unknown action' };
        }
      } catch (err: unknown) {
        result = { error: `Colony health check failed: ${(err as Error).message}` };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
