/**
 * @module    mcp-tool-get-gate-status
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — monitoring call, no governance decision made here
 * @audit     true — gate poll events recorded to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Agent-side gate status check. After classify_decision returns
 * gateStatus: PENDING, agents MUST call this tool and wait for
 * APPROVED before proceeding with MANDATORY-classified actions.
 *
 * Polls the gate_approvals_persistent DB row every 5 seconds for up
 * to 60 seconds. Re-call if still PENDING after the poll window.
 *
 * This tool exists because classify_decision cannot block its own
 * connection for 5 minutes without causing MCP timeouts (P-003 fix).
 * The blocking wait is a separate, re-callable step.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { getGateDbRecord } from '../../core/persistence/gate-persistence.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 60_000;

const GATE_STATUS_MAI_RESULT = {
  classification: MaiClassification.INFORMATIONAL,
  confidence: 1.0,
  rationale: 'Gate status poll — no governance decision',
  requiresGate: false,
} as const;

export function registerGetGateStatusTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'get_gate_status',
    'Check resolution of a MANDATORY gate. Call this after classify_decision returns gateStatus: PENDING. Polls for up to 60 seconds — re-call if still PENDING. Do not proceed with the classified action until this returns APPROVED.',
    {
      gate_id: z.string().describe('The gateId returned by classify_decision'),
      agent_name: z.string().optional().describe('Name of the calling agent'),
    },
    { title: 'Get Gate Status', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const entry = engine.ledger.begin(
        'get-gate-status',
        MaiClassification.INFORMATIONAL,
        GiaLayer.MCP,
        input.agent_name || 'SYSTEM'
      );
      entry.addMetadata('gateId', input.gate_id);

      try {
        // Fast path: check in-memory pending approvals (synchronous)
        const inMemPending = engine.gate.getPendingApprovals();
        const stillInMemory = inMemPending.some(g => g.gateId === input.gate_id);

        if (!stillInMemory) {
          // Not in memory — check DB (may have been resolved or MCP server restarted)
          const dbRecord = await getGateDbRecord(input.gate_id);
          if (!dbRecord) {
            engine.ledger.record(entry.complete(
              engine.scorer.scoreDefault('get-gate-status'),
              GATE_STATUS_MAI_RESULT
            ));
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                gateId: input.gate_id,
                status: 'NOT_FOUND',
                gateInstruction: 'Gate not found. It may have already been resolved or the gateId is invalid. Check the Sanity Check tab in GIA Console.',
              }, null, 2) }],
            };
          }
          if (dbRecord.status && dbRecord.status !== 'PENDING') {
            engine.ledger.record(entry.complete(
              engine.scorer.scoreDefault('get-gate-status'),
              GATE_STATUS_MAI_RESULT
            ));
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                gateId: input.gate_id,
                status: dbRecord.status,
                approvedBy: dbRecord.approvedBy,
                rationale: dbRecord.rationale,
                resolvedAt: dbRecord.resolvedAt,
                gateInstruction: dbRecord.status === 'APPROVED'
                  ? 'Gate APPROVED. You may proceed with the classified action.'
                  : 'Gate REJECTED. Action is blocked. Do not proceed.',
              }, null, 2) }],
              isError: dbRecord.status === 'REJECTED',
            };
          }
        }

        // Gate is PENDING — poll DB for resolution
        const deadline = Date.now() + POLL_MAX_MS;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          const record = await getGateDbRecord(input.gate_id);
          if (record?.status && record.status !== 'PENDING') {
            engine.ledger.record(entry.complete(
              engine.scorer.scoreDefault('get-gate-status'),
              GATE_STATUS_MAI_RESULT
            ));
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                gateId: input.gate_id,
                status: record.status,
                approvedBy: record.approvedBy,
                rationale: record.rationale,
                resolvedAt: record.resolvedAt,
                gateInstruction: record.status === 'APPROVED'
                  ? 'Gate APPROVED. You may proceed with the classified action.'
                  : 'Gate REJECTED. Action is blocked. Do not proceed.',
              }, null, 2) }],
              isError: record.status === 'REJECTED',
            };
          }
        }

        // Poll window expired — still PENDING
        engine.ledger.record(entry.complete(
          engine.scorer.scoreDefault('get-gate-status'),
          GATE_STATUS_MAI_RESULT
        ));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            gateId: input.gate_id,
            status: 'PENDING',
            gateInstruction: `Gate ${input.gate_id} still awaits ISSO approval. Re-call get_gate_status to continue waiting. Do NOT proceed until APPROVED.`,
          }, null, 2) }],
        };
      } catch (error) {
        engine.ledger.record(entry.fail(
          error instanceof Error ? error : new Error('Gate status check failed'),
          MaiClassification.MANDATORY
        ));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Gate status check failed.' }) }],
          isError: true,
        };
      }
    }
  );
}
