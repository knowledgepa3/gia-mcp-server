/**
 * @module    mcp-tool-approve-gate
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — transport only, CORE handles gate logic
 * @audit     true — writes to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { getGateDbRecord } from '../../core/persistence/gate-persistence.js';

/**
 * Enhance "not found" messages with DB lookup — when in-memory gate is gone
 * (e.g. after MCP server restart marked it TIMED_OUT), surface the actual
 * historical state instead of a bare "not found in pending approvals".
 */
async function enhanceNotFoundMessage(gateId: string): Promise<string> {
  try {
    const dbRecord = await getGateDbRecord(gateId);
    if (!dbRecord) {
      return `Gate ${gateId} not found in pending approvals or DB. Check the gate_id is correct.`;
    }
    if (dbRecord.status === 'TIMED_OUT') {
      const at = dbRecord.resolvedAt?.toISOString() || 'unknown';
      return `Gate ${gateId} timed out at ${at} (DB status: TIMED_OUT). The in-memory gate was cleared, likely by MCP server restart. Re-issue the original request to create a fresh gate.`;
    }
    if (dbRecord.status === 'APPROVED' || dbRecord.status === 'REJECTED') {
      const at = dbRecord.resolvedAt?.toISOString() || 'unknown';
      const by = dbRecord.approvedBy || 'unknown';
      return `Gate ${gateId} already ${dbRecord.status.toLowerCase()} by ${by} at ${at} (DB status: ${dbRecord.status}). Cannot ${dbRecord.status === 'APPROVED' ? 'approve' : 'reject'} again.`;
    }
    return `Gate ${gateId} not in pending approvals; DB status: ${dbRecord.status}.`;
  } catch {
    return `Gate ${gateId} not found in pending approvals.`;
  }
}

export function registerApproveGateTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'approve_gate',
    'Approve or reject a pending MANDATORY gate decision. Lists pending gates if no gate_id provided. This is the human-in-the-loop mechanism for MANDATORY classifications.',
    {
      action: z.enum(['list', 'approve', 'reject', 'break_glass']).describe('Action to perform'),
      gate_id: z.string().optional().describe('Gate ID to approve/reject (required for approve/reject)'),
      approved_by: z.string().default('HUMAN').describe('Identity of the approver'),
      rationale: z.string().optional().describe('Reason for approval/rejection'),
      webauthn_proof: z.object({
        credentialId: z.string(),
        userId: z.string(),
        verifiedAt: z.string(),
        signatureVerified: z.boolean(),
      }).optional().describe('Optional WebAuthn passkey proof for cryptographic identity verification'),
    },
    { title: 'Approve or Reject Mandatory Gate', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, _meta: { ui: { resourceUri: 'ui://gate-approval' } } } as any,
    async (input) => {
      if (input.action === 'list') {
        const pending = engine.gate.getPendingApprovals();

        // Tool accountability tracking
        engine.telemetryService.emitToolCall('approve_gate', `gate-list-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            pendingCount: pending.length,
            pending: pending.map(p => ({
              gateId: p.gateId,
              operation: p.operation,
              classification: p.classification,
              requestedAt: p.requestedAt,
              ownerRole: p.ownerRole,
              sla: p.sla,
            })),
          }, null, 2) }],
        };
      }

      if (!input.gate_id) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'MISSING_GATE_ID',
            message: 'gate_id is required for approve/reject actions.',
          }) }],
          isError: true,
        };
      }

      if (input.action === 'break_glass') {
        const entry = engine.ledger.begin(
          'gate-break_glass',
          MaiClassification.MANDATORY,
          GiaLayer.MCP,
          input.approved_by
        );
        entry.addMetadata('gateId', input.gate_id!);
        entry.addMetadata('action', input.action);
        if (input.rationale) entry.addMetadata('rationale', input.rationale);

        try {
          const success = engine.gate.breakGlassApprove(
            input.gate_id!, input.approved_by,
            'mcp-break-glass-' + Date.now().toString(36),
            input.rationale ?? 'Break-glass via MCP tool'
          );

          const score = engine.scorer.scoreDefault('gate-break_glass');
          const completedEntry = entry.complete(score, {
            classification: MaiClassification.MANDATORY,
            confidence: 1.0,
            rationale: `Gate break_glass: ${input.rationale || 'No rationale provided'}`,
            requiresGate: false,
          });
          engine.ledger.record(completedEntry);

          // Auto-emit governance telemetry
          engine.telemetryService.emitGateAction(entry.id, 'break_glass', input.gate_id!, input.approved_by);
          engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', true);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              action: 'BREAK_GLASS_OVERRIDE',
              gateId: input.gate_id,
              approvedBy: input.approved_by,
              success,
              message: success
                ? `Gate ${input.gate_id} approved via break-glass emergency override. Mandatory post-review required.`
                : await enhanceNotFoundMessage(input.gate_id!),
            }, null, 2) }],
            isError: !success,
          };
        } catch (error) {
          engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', false);
          const failedEntry = entry.fail(error instanceof Error ? error : new Error('Gate break_glass failed'), MaiClassification.MANDATORY);
          engine.ledger.record(failedEntry);
          throw error;
        }
      }

      if (input.action === 'approve') {
        // Pre-check: is this gate actually pending? Needed to distinguish
        // "not found" from "passkey required" when approve() returns false.
        const pendingBefore = engine.gate.getPendingApprovals().some(p => p.gateId === input.gate_id);

        const entry = engine.ledger.begin(
          'gate-approve',
          MaiClassification.MANDATORY,
          GiaLayer.MCP,
          input.approved_by
        );
        entry.addMetadata('gateId', input.gate_id);
        entry.addMetadata('action', input.action);
        if (input.rationale) entry.addMetadata('rationale', input.rationale);

        try {
          const success = engine.gate.approve(input.gate_id, input.approved_by, input.rationale, input.webauthn_proof);

          const score = engine.scorer.scoreDefault('gate-approve');
          const completedEntry = entry.complete(score, {
            classification: MaiClassification.MANDATORY,
            confidence: 1.0,
            rationale: `Gate approve: ${input.rationale || 'No rationale provided'}`,
            requiresGate: false,
          });
          engine.ledger.record(completedEntry);

          // Auto-emit governance telemetry
          engine.telemetryService.emitGateAction(entry.id, 'approve', input.gate_id, input.approved_by);
          engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', true);

          // Distinguish failure reasons: gate not found vs passkey required
          let message: string;
          if (success) {
            message = `Gate ${input.gate_id} approved by ${input.approved_by}${input.webauthn_proof ? ' with WebAuthn passkey verification' : ''}.`;
          } else if (pendingBefore) {
            // Gate exists but approve() returned false → passkey enforcement rejected it
            message = `Gate ${input.gate_id} requires WebAuthn passkey proof for approval. Retry with webauthn_proof parameter.`;
          } else {
            message = await enhanceNotFoundMessage(input.gate_id!);
          }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              action: success ? 'APPROVED' : (pendingBefore ? 'PASSKEY_REQUIRED' : 'NOT_FOUND'),
              gateId: input.gate_id,
              approvedBy: input.webauthn_proof ? input.webauthn_proof.userId : input.approved_by,
              passkeyVerified: !!input.webauthn_proof,
              success,
              message,
            }, null, 2) }],
            isError: !success,
          };
        } catch (error) {
          engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', false);
          const failedEntry = entry.fail(error instanceof Error ? error : new Error('Gate approve failed'), MaiClassification.MANDATORY);
          engine.ledger.record(failedEntry);
          throw error;
        }
      }

      // reject — also pass webauthnProof for identity verification on rejections
      const rejectedBy = input.webauthn_proof ? input.webauthn_proof.userId : input.approved_by;

      const entry = engine.ledger.begin(
        'gate-reject',
        MaiClassification.MANDATORY,
        GiaLayer.MCP,
        rejectedBy
      );
      entry.addMetadata('gateId', input.gate_id);
      entry.addMetadata('action', input.action);
      if (input.rationale) entry.addMetadata('rationale', input.rationale);

      try {
        const success = engine.gate.reject(input.gate_id, rejectedBy, input.rationale, input.webauthn_proof);

        const score = engine.scorer.scoreDefault('gate-reject');
        const completedEntry = entry.complete(score, {
          classification: MaiClassification.MANDATORY,
          confidence: 1.0,
          rationale: `Gate reject: ${input.rationale || 'No rationale provided'}`,
          requiresGate: false,
        });
        engine.ledger.record(completedEntry);

        // Auto-emit governance telemetry
        engine.telemetryService.emitGateAction(entry.id, 'reject', input.gate_id, rejectedBy);
        engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', true);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            action: 'REJECTED',
            gateId: input.gate_id,
            rejectedBy,
            passkeyVerified: !!input.webauthn_proof,
            success,
            message: success
              ? `Gate ${input.gate_id} rejected by ${rejectedBy}${input.webauthn_proof ? ' with WebAuthn passkey verification' : ''}.`
              : await enhanceNotFoundMessage(input.gate_id!),
          }, null, 2) }],
          isError: !success,
        };
      } catch (error) {
        engine.telemetryService.emitToolCall('approve_gate', entry.id, 'MANDATORY', false);
        const failedEntry = entry.fail(error instanceof Error ? error : new Error('Gate reject failed'), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);
        throw error;
      }
    }
  );
}
