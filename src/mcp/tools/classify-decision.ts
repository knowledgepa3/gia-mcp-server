/**
 * @module    mcp-tool-classify-decision
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — transport only, CORE handles classification
 * @audit     true — writes to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { MAX_INPUT_LENGTH } from '../../shared/constants.js';
import { sanitize } from '../../shared/utils.js';
import { GovernedError, GateRejectionError } from '../../shared/errors.js';
import { type IClassificationContext } from '../../core/mai/types.js';
import { GateStatus } from '../../shared/types.js';

// ─── PII Detection ────────────────────────────────────────────────────────────
// Lightweight regex scan — not exhaustive, covers common VA/healthcare patterns.
// Detects SSN, VA file numbers, DOB patterns, named references, and phone/email.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,                          // SSN
  /\bva\s*file\s*#?\s*\d{5,9}\b/i,                  // VA file number
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,                  // DOB / date
  /\b(?:patient|veteran|claimant|ssn|dob|name)[:=]\s*\S+/i, // labeled PII
  /\b[A-Z][a-z]+\s[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/, // Full name pattern
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,              // Phone
  /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/, // Email
];

function detectPii(text: string): boolean {
  return PII_PATTERNS.some(re => re.test(text));
}

export function registerClassifyDecisionTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'classify_decision',
    'Classify an AI agent decision using the MAI Framework (Mandatory/Advisory/Informational). Returns classification level, confidence score, gate requirements, and rationale.',
    {
      decision: z.string().max(MAX_INPUT_LENGTH).describe('Description of the decision to classify'),
      domain: z.enum(['va-claims', 'legal', 'healthcare', 'finance', 'federal', 'general']).describe('Domain context'),
      agent_name: z.string().optional().describe('Name of the agent making the decision'),
      is_client_facing: z.boolean().default(false).describe('Whether output is client-facing'),
      has_financial_impact: z.boolean().default(false).describe('Whether action has financial impact'),
      has_legal_impact: z.boolean().default(false).describe('Whether action involves legal assertions'),
    },
    { title: 'Classify AI Decision', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      // Begin forensic ledger entry
      const entry = engine.ledger.begin(
        'classify-decision',
        MaiClassification.INFORMATIONAL,
        GiaLayer.MCP,
        input.agent_name || 'SYSTEM'
      );
      entry.addMetadata('domain', input.domain);
      entry.addMetadata('decision', sanitize(input.decision).slice(0, 200));

      try {
        const sanitizedDecision = sanitize(input.decision);
        const context: IClassificationContext = {
          operation: sanitizedDecision,
          agentName: input.agent_name,
          vertical: input.domain === 'va-claims' ? 'ace' : input.domain,
          inputSensitivity: 'CONTROLLED',
          outputAudience: input.is_client_facing ? 'CLIENT' : 'INTERNAL',
          hasFinancialImpact: input.has_financial_impact,
          hasLegalImpact: input.has_legal_impact,
          piiDetected: detectPii(sanitizedDecision),
        };

        const result = engine.classifier.classify(
          sanitizedDecision,
          MaiClassification.INFORMATIONAL, // Start at lowest, let elevation rules work
          context
        );

        // Record to threshold monitor
        engine.thresholdMonitor.record(result);

        // ── Gate Enforcement ─────────────────────────────────────────────────
        // ARCHITECTURE NOTE: Do NOT await engine.gate.enforce() for MANDATORY gates.
        // enforce() blocks for up to 5 minutes waiting for human approval, which
        // causes MCP connection timeouts (the "MCP connection lost x2" failure
        // seen in Round 4 smoke test).
        //
        // The gate.enforce() Promise constructor runs SYNCHRONOUSLY — pendingApprovals
        // .set() and persistGateRequest() both fire before any microtask yield.
        // We fire-and-forget the Promise, read back the gateId immediately from
        // getPendingApprovals(), and return a PENDING response to the MCP caller.
        // The human approves in the Sanity Check tab; the background Promise
        // resolves at that point and DB state is updated.
        let gateDecision: import('../../shared/types.js').IGateDecision | undefined;
        if (result.requiresGate) {
          entry.addMetadata('hasGate', true);
          entry.addMetadata('piiDetected', context.piiDetected);

          // Fire-and-forget: gate IS registered synchronously inside enforce()
          // before we reach the next line. Background handler is for audit only.
          void engine.gate.enforce(
            result.classification,
            sanitizedDecision.slice(0, 200),
            entry.id,
            'isso'
          ).catch(() => {
            // Gate timed out or was rejected — governance event, already logged in DB.
            // Not surfaced as MCP error; caller received PENDING response already.
          });

          // Read back the newly registered gate (synchronous — no await needed)
          const pending = engine.gate.getPendingApprovals();
          const newest = pending[pending.length - 1];
          const gateId = newest?.gateId ?? 'gate-pending';

          gateDecision = {
            gateId,
            classification: result.classification,
            status: GateStatus.PENDING,
            approvedBy: 'PENDING' as import('../../shared/types.js').GateApprover,
            timestamp: new Date(),
            rationale: 'MANDATORY gate registered. Awaiting ISSO approval in GIA Console → Sanity Check tab.',
            autoRunMode: false,
          };

          entry.addMetadata('gateId', gateId);
          entry.addMetadata('gateStatus', GateStatus.PENDING);
          entry.addMetadata('gateApprovedBy', undefined);
        } else {
          entry.addMetadata('hasGate', false);
          entry.addMetadata('piiDetected', context.piiDetected);
        }

        // Record to forensic ledger
        entry.addMetadata('maiClassification', result.classification);
        entry.addMetadata('maiConfidence', result.confidence);
        entry.addMetadata('requiresGate', result.requiresGate);
        const score = engine.scorer.scoreDefault('classify-decision');
        const completedEntry = entry.complete(score, result, gateDecision);
        engine.ledger.record(completedEntry);

        // Auto-emit governance telemetry
        engine.telemetryService.emitClassification(entry.id, result.classification, sanitizedDecision, input.agent_name);
        engine.telemetryService.emitToolCall('classify_decision', entry.id, result.classification, true, undefined, input.agent_name);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            classification: result.classification,
            confidence: result.confidence,
            rationale: result.rationale,
            requiresGate: result.requiresGate,
            piiDetected: context.piiDetected,
            hasGate: !!gateDecision,
            gateId: gateDecision?.gateId,
            gateStatus: gateDecision?.status,
            gateApprovedBy: gateDecision?.approvedBy,
            gateInstruction: result.requiresGate && gateDecision
              ? gateDecision.status === GateStatus.PENDING
                ? `MANDATORY gate registered (${gateDecision.gateId}). Approve in GIA Console → Sanity Check tab to authorize this operation.`
                : `Gate ${gateDecision.status}: ${gateDecision.rationale}`
              : undefined,
            elevatedFrom: result.elevatedFrom,
            elevationReason: result.elevationReason,
            auditId: entry.id,
          }, null, 2) }],
        };
      } catch (error) {
        // Gate rejection is a governance outcome, not an internal error — return structured response
        if (error instanceof GateRejectionError) {
          const failedEntry = entry.fail(error, MaiClassification.MANDATORY);
          engine.ledger.record(failedEntry);
          engine.telemetryService.emitToolCall('classify_decision', entry.id, 'MANDATORY', false, undefined, input.agent_name);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              classification: 'MANDATORY',
              requiresGate: true,
              gateStatus: 'REJECTED',
              gateInstruction: `MANDATORY gate REJECTED: ${error.publicMessage}. Action is blocked. Do not proceed.`,
              auditId: entry.id,
            }, null, 2) }],
            isError: true,
          };
        }

        // Record failure to forensic ledger
        const failedEntry = entry.fail(error instanceof Error ? error : new Error('Classification failed'), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);

        engine.telemetryService.emitToolCall('classify_decision', entry.id, 'MANDATORY', false, undefined, input.agent_name);
        if (error instanceof GovernedError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(error.toPublicResponse()) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Classification failed.' }) }], isError: true };
      }
    }
  );
}
