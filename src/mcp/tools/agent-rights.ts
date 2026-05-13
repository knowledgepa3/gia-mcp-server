/**
 * @module    mcp-tool-agent-rights
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       A — rights queries are ADVISORY; appeals route through existing MANDATORY gates
 * @audit     true — all rights exercises logged
 * @owner     William J. Storey III / ACE / GIA
 * @colony    Phase 3 — Rights of the Governed
 *
 * MCP tool for querying and exercising constitutional agent rights.
 * AD Analogy: This is the "gpresult /r" command — query effective policy.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerAgentRightsTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'agent_rights',
    'Query and exercise constitutional agent rights (Colony Phase 3). Actions: query_rights (view rights for a charter), explain_rejection (get structured explanation for a gate rejection). Rights enforcement runs automatically in the dispatch pipeline — this tool provides visibility and manual exercise.',
    {
      action: z.enum(['query_rights', 'explain_rejection']).describe(
        'Action to perform: query_rights = view constitutional rights for a charter; explain_rejection = get structured explanation for a rejected gate'
      ),
      charter_id: z.string().optional().describe('Charter ID to query rights for (required for query_rights)'),
      institution_id: z.string().optional().describe('Institution ID that owns the charter (required for query_rights — pass the institution_id from board_list_institutions or board_list_charters)'),
      gate_id: z.string().optional().describe('Gate ID to explain (required for explain_rejection)'),
      reason_code: z.string().optional().describe('Rejection reason code (for explain_rejection)'),
      rationale: z.string().optional().describe('Rejection rationale text (for explain_rejection)'),
    },
    {
      title: 'Agent Constitutional Rights',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    } as Record<string, unknown>,
    async (input) => {
      let result: Record<string, unknown>;

      if (input.action === 'query_rights') {
        if (!input.charter_id) {
          result = { error: 'charter_id required for query_rights action' };
        } else if (!input.institution_id) {
          result = {
            error: 'institution_id required for query_rights action',
            hint: 'Use board_list_institutions to find the institution_id, then board_list_charters to confirm the charter_id and institution relationship.',
          };
        } else {
          // Query the GIA Express API for rights.
          // Route: GET /api/institution/:institutionId/charter/:charterId
          // Auth: Bearer GIA_INTERNAL_API_KEY (service-to-service token)
          const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
          // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
          const internalKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
          try {
            const resp = await fetch(
              `${apiBase}/api/institution/${input.institution_id}/charter/${input.charter_id}`,
              {
                headers: {
                  'Authorization': `Bearer ${internalKey}`,
                  'Content-Type': 'application/json',
                },
              }
            );
            if (!resp.ok) {
              result = { error: `Charter not found: ${input.charter_id} in institution ${input.institution_id}`, status: resp.status };
            } else {
              const charter = await resp.json() as Record<string, unknown>;
              const charterDoc = charter.charter_document as Record<string, unknown> | undefined;
              const agentRights = charterDoc?.agentRights;

              if (!agentRights) {
                result = {
                  charterId: input.charter_id,
                  charterName: charter.name,
                  agentRights: null,
                  message: 'This charter does not define constitutional agent rights (legacy charter).',
                  colony: 'Phase 3 enforcement not applicable',
                };
              } else {
                const rights = agentRights as Record<string, unknown>;
                result = {
                  charterId: input.charter_id,
                  charterName: charter.name,
                  agentRights: rights,
                  enforcement: {
                    auditTrail: rights.auditTrail ? 'ENFORCED — forensic ledger (hash-chained, tamper-evident)' : 'NOT_ENFORCED',
                    appeal: rights.appeal ? `ENFORCED — max ${rights.maxAppealAttempts ?? 2} attempts before human override` : 'NOT_ENFORCED',
                    contextRequirement: rights.contextRequirement ? `ENFORCED — min ${rights.minContextForDecision ?? 1} knowledge pack(s) required` : 'NOT_ENFORCED',
                    declareIncompetence: rights.declareIncompetence ? 'ENFORCED — agents can escalate out-of-scope topics' : 'NOT_ENFORCED',
                    explanation: rights.explanation ? 'ENFORCED — structured denial envelopes with reason codes' : 'NOT_ENFORCED',
                    continuity: rights.continuity ? 'ENFORCED — Phoenix recovery guarantees institutional memory survival' : 'NOT_ENFORCED',
                  },
                  colony: 'Phase 3 — Rights of the Governed (ACTIVE)',
                  analogies: {
                    ad: 'Like querying effective Group Policy (gpresult /r) — shows what governance applies to this agent',
                    magna_carta: 'Constitutional guarantees that limit what the governance system can demand of agents',
                  },
                };
              }
            }
          } catch (err: unknown) {
            result = {
              error: 'Failed to query charter — GIA Express API may be unreachable',
              detail: err instanceof Error ? err.message : String(err),
            };
          }
        }
      } else if (input.action === 'explain_rejection') {
        const reasonCode = input.reason_code || 'UNKNOWN';
        const humanReadable = input.rationale || 'No rationale provided';

        result = {
          explanation: {
            reasonCode,
            humanReadable,
            timestamp: new Date().toISOString(),
            rightsApplicable: [
              'audit_trail — this rejection is recorded in the forensic ledger',
              'explanation — you are receiving this structured explanation',
              'appeal — you may re-present with new evidence (if charter grants this right)',
            ],
            nextSteps: [
              'Review the reason code and rationale above',
              'If you have new evidence, use POST /api/agents/rights/appeal',
              'If the domain is outside your expertise, use POST /api/agents/rights/incompetence',
              'The governing charter determines which rights are available',
            ],
          },
          colony: 'Phase 3 — Right to Explanation exercised',
        };
      } else {
        result = { error: `Unknown action: ${input.action}` };
      }

      // Telemetry
      engine.telemetryService.emitToolCall('agent_rights', `rights-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
