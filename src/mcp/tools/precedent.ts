/**
 * @module    mcp-tool-precedent
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       I — precedent queries are INFORMATIONAL
 * @audit     true — searches logged via telemetry
 * @owner     William J. Storey III / ACE / GIA
 * @colony    Layer 1 v2 — Precedent System (case law search)
 *
 * MCP tool for searching and citing deliberation precedent.
 * AD Analogy: This is the "Precedent Lookup" command — query institutional
 * case law to find prior rulings relevant to the current deliberation.
 *
 * "Session 50 is smarter than session 1 because it has 49 prior rulings."
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerPrecedentTools(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'board_search_precedent',
    'Search deliberation precedent (Colony Layer 1). Find prior board rulings on a topic. Returns ranked cases with quality scores, gate approval status, and citation counts. Use this to ground new deliberations in institutional case law. Cite cases by ID: "In Case board-abc123, this board ruled..."',
    {
      topic: z.string().min(3).max(500).describe(
        'The topic or question to search precedent for. Full-text search matches against prior deliberation agendas.'
      ),
      charter_id: z.string().optional().describe(
        'Charter ID to scope search. When provided, searches this charter and its parent hierarchy (subcommittee sees parent board precedent).'
      ),
      limit: z.number().min(1).max(20).optional().describe(
        'Maximum number of cases to return (default: 5, max: 20)'
      ),
    },
    {
      title: 'Search Deliberation Precedent',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      const limit = input.limit ?? 5;

      let result: Record<string, unknown>;

      try {
        const params = new URLSearchParams({
          q: input.topic,
          limit: String(limit),
        });
        if (input.charter_id) {
          params.set('charter_id', input.charter_id);
        }

        const resp = await fetch(`${apiBase}/api/precedent/search?${params.toString()}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (!resp.ok) {
          const body = await resp.text();
          result = {
            error: `Precedent search failed (HTTP ${resp.status})`,
            detail: body,
          };
        } else {
          const data = await resp.json() as Record<string, unknown>;
          const cases = data.cases as Array<Record<string, unknown>> | undefined;

          if (!cases || cases.length === 0) {
            result = {
              query: input.topic,
              charterId: input.charter_id ?? null,
              cases: [],
              count: 0,
              message: 'No relevant precedent found. This may be a novel topic for this board.',
              guidance: 'When no precedent exists, the board establishes new case law through this deliberation.',
              colony: 'Layer 1 — Precedent System v2',
            };
          } else {
            // Format cases for readability
            const formattedCases = cases.map((c, i) => ({
              rank: i + 1,
              caseId: c.board_id,
              shortId: typeof c.board_id === 'string' ? c.board_id.slice(0, 12) : '',
              topic: c.question_text,
              mode: c.mode,
              qualityScore: c.quality_score,
              gateApproved: c.gate_approved,
              precedentWeight: c.precedent_weight,
              status: c.precedent_status ?? 'active',
              charterId: c.charter_id ?? null,
              ruling: c.recommendation,
              citationCount: c.citation_count ?? 0,
              analyzedAt: c.analyzed_at,
            }));

            result = {
              query: input.topic,
              charterId: input.charter_id ?? null,
              count: formattedCases.length,
              cases: formattedCases,
              citation_guidance: 'Cite cases using: "In Case [shortId], this board ruled [ruling summary]..."',
              weight_formula: 'quality(40%) + gate_approved(20%) + genuine(15%) + mode(15%) + recency(10%)',
              overturn_note: 'To overturn a precedent, convene a session with supermajority approval (quorum + 1).',
              colony: 'Layer 1 — Precedent System v2 (institutional case law)',
            };
          }
        }
      } catch (err: unknown) {
        result = {
          error: 'Failed to search precedent — GIA Express API may be unreachable',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // Telemetry
      engine.telemetryService.emitToolCall('board_search_precedent', `prec-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
