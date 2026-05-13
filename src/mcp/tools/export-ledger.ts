/**
 * @module    mcp-tool-export-ledger
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       ADVISORY — read-only export, produces compliance evidence
 * @audit     false — export does not modify the ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Export the forensic audit ledger as a structured compliance evidence package.
 *
 * Returns all ledger entries for a given time range with chain verification,
 * MAI breakdown, gate decisions, and an integrity hash of the export itself.
 * This is the foundation for the "Download Deliverables" feature — every
 * contract export builds on this data source.
 *
 * Classification: ADVISORY — read-only, no mutations.
 */

import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, EntryStatus } from '../../shared/types.js';
import { GIA_VERSION, GIA_AUTHOR, HASH_ALGORITHM } from '../../shared/constants.js';

export function registerExportLedgerTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'export_ledger',
    'Export the forensic audit ledger as a structured compliance evidence package. Returns ledger entries for a time range with chain verification, MAI breakdown, gate approvals, and integrity hash. Foundation for deliverable exports. Classification: ADVISORY — read-only.',
    {
      period_days: z.number().min(1).max(365).default(14).describe('Export period in days (default: 14, max: 365)'),
      operation: z.string().optional().describe('Filter by operation name (e.g. "gate-approve", "classify_decision")'),
      mai_level: z.enum(['MANDATORY', 'ADVISORY', 'INFORMATIONAL']).optional().describe('Filter by MAI classification level'),
      include_metadata: z.boolean().default(false).describe('Include full entry metadata (larger output)'),
    },
    { title: 'Export Ledger Evidence Package', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const now = new Date();
      const since = new Date(now.getTime() - input.period_days * 24 * 60 * 60 * 1000);

      // Query entries in time range
      let entries = engine.ledger.queryByTimeRange(since, now);

      // Apply optional filters
      if (input.operation) {
        entries = entries.filter(e => e.operation === input.operation);
      }
      if (input.mai_level) {
        const level = MaiClassification[input.mai_level as keyof typeof MaiClassification];
        entries = entries.filter(e => e.maiLevel === level);
      }

      // Verify chain integrity
      const chainVerification = engine.ledger.verifyChain();

      // Compute MAI breakdown for the export window
      const maiBreakdown = {
        MANDATORY: entries.filter(e => e.maiLevel === MaiClassification.MANDATORY).length,
        ADVISORY: entries.filter(e => e.maiLevel === MaiClassification.ADVISORY).length,
        INFORMATIONAL: entries.filter(e => e.maiLevel === MaiClassification.INFORMATIONAL).length,
      };

      // Compute status breakdown
      const statusBreakdown = {
        completed: entries.filter(e => e.status === EntryStatus.COMPLETED).length,
        failed: entries.filter(e => e.status === EntryStatus.FAILED).length,
        escalated: entries.filter(e => e.status === EntryStatus.ESCALATED).length,
        started: entries.filter(e => e.status === EntryStatus.STARTED).length,
      };

      // Extract gate decisions from entries
      const gateDecisions = entries
        .filter(e => e.gateDecision)
        .map(e => ({
          auditId: e.id,
          operation: e.operation,
          gateId: e.gateDecision!.gateId,
          status: e.gateDecision!.status,
          approvedBy: e.gateDecision!.approvedBy,
          passkeyVerified: !!e.gateDecision!.webauthnProof,
          timestamp: e.gateDecision!.timestamp.toISOString(),
          rationale: e.gateDecision!.rationale,
        }));

      // Format entries for export
      const exportedEntries = entries.map(e => ({
        auditId: e.id,
        timestamp: e.timestamp.toISOString(),
        operation: e.operation,
        layer: e.layer,
        maiLevel: e.maiLevel,
        actor: e.actor,
        status: e.status,
        durationMs: e.duration,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
        compositeScore: e.governanceScore?.composite,
        entryHash: e.entryHash,
        ...(input.include_metadata ? { metadata: e.metadata } : {}),
      }));

      // Compute integrity hash of the entire export (tamper evidence for the export itself)
      const exportPayload = JSON.stringify({
        entries: exportedEntries,
        chainHead: chainVerification.headHash,
        exportedAt: now.toISOString(),
      });
      const exportHash = createHash('sha256').update(exportPayload).digest('hex');

      const exportPackage = {
        exportType: 'GIA Forensic Ledger Evidence Package',
        version: GIA_VERSION,
        author: GIA_AUTHOR,
        exportedAt: now.toISOString(),
        period: {
          from: since.toISOString(),
          to: now.toISOString(),
          days: input.period_days,
        },
        filters: {
          operation: input.operation ?? 'all',
          maiLevel: input.mai_level ?? 'all',
        },
        summary: {
          totalEntries: exportedEntries.length,
          maiBreakdown,
          statusBreakdown,
          gateDecisionCount: gateDecisions.length,
          hasFailures: statusBreakdown.failed > 0,
        },
        chainIntegrity: {
          status: chainVerification.valid ? 'INTACT' : 'BROKEN',
          entriesVerified: chainVerification.entriesVerified,
          chainHead: chainVerification.headHash,
          hashAlgorithm: HASH_ALGORITHM,
        },
        gateDecisions: gateDecisions.length > 0 ? gateDecisions : 'No gate decisions in export window',
        entries: exportedEntries,
        exportIntegrity: {
          hash: exportHash,
          algorithm: 'SHA-256',
          description: 'Hash of the entire export payload — verify this value to confirm the export has not been modified after generation.',
        },
        complianceNote: 'This evidence package supports EU AI Act Article 12 (Record-Keeping), NIST 800-53 AU (Audit and Accountability), and ISO 42001 governance evidence requirements.',
      };

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('export_ledger', `export-${Date.now().toString(36)}`, 'ADVISORY', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(exportPackage, null, 2) }],
      };
    }
  );
}
