/**
 * @module    mcp-tool-verify-ledger-v2
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       I — read-only verification; DRIFT/BROKEN_LINK findings append a
 *             MANDATORY LEDGER_INTEGRITY_VIOLATION entry (INSERT, never UPDATE)
 * @audit     true — violations are anchored in the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * verify_ledger_v2 — PERSISTED-ROW ledger verification (Option A §7).
 *
 * This is the auditor-facing verifier: it reads the actual PostgreSQL
 * forensic_ledger rows (not an in-memory reconstruction) and dispatches per
 * row by algorithm epoch — epoch-2 rows are content-verified with Ledger
 * Canonical v2; epoch-1 legacy rows are linkage-verified only and are honestly
 * labeled as such, never silently auto-healed.
 *
 * HONEST CLAIM SCOPE: a clean result proves (a) linkage integrity across the
 * whole chain and (b) content integrity of every epoch-2 row against persisted
 * columns. It does NOT prove epoch-1 content (heterogeneous legacy bucket) and
 * is still INTERNAL verification — third-party verifiability requires external
 * anchoring of chain heads (planned Phase 6), and DB-level immutability
 * requires the non-superuser gia_app role.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GovernanceEngine } from '../../core/governance.js';
import { GENESIS_HASH, HASH_ALGORITHM, CHAIN_VERSION } from '../../shared/constants.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { exportLedgerJSON, isPersistenceEnabled } from '../../core/audit/ledger-persistence.js';
import { classifyLedgerRows, type ForensicLedgerRow } from '../../core/audit/verify-ledger-v2.js';

/**
 * Append a MANDATORY LEDGER_INTEGRITY_VIOLATION entry for a dirty verification
 * result — a new INSERT via the canonical writer (completeness-patrol pattern).
 * Never an UPDATE; the finding becomes part of the immutable record.
 */
export function recordIntegrityViolation(
  engine: GovernanceEngine,
  summary: { totalRows: number; drift: number; brokenLink: number; firstDetail: string },
): string {
  const entry = engine.ledger.begin('LEDGER_INTEGRITY_VIOLATION', MaiClassification.MANDATORY, GiaLayer.CORE, 'verify-ledger-v2');
  entry.addMetadata('driftRows', summary.drift);
  entry.addMetadata('brokenLinkRows', summary.brokenLink);
  entry.addMetadata('totalRows', summary.totalRows);
  entry.addMetadata('firstProblem', summary.firstDetail);
  entry.addMetadata('source', 'verify_ledger_v2');

  const score = engine.scorer.scoreDefault('verify-ledger-v2');
  const completed = entry.complete(score, {
    classification: MaiClassification.MANDATORY,
    confidence: 1.0,
    rationale: 'Persisted-row ledger verification found integrity problems',
    requiresGate: true,
  });
  engine.ledger.record(completed);
  return entry.id;
}

export function registerVerifyLedgerV2Tool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'verify_ledger_v2',
    'Verify the PERSISTED forensic ledger rows in PostgreSQL (not an in-memory reconstruction). Epoch-aware: epoch-2 rows are content-verified against persisted columns with Ledger Canonical v2; legacy epoch-1 rows are linkage-verified only and labeled honestly. Findings append a MANDATORY LEDGER_INTEGRITY_VIOLATION entry (never repaired, never UPDATEd). Classification: INFORMATIONAL read; MANDATORY escalation on findings.',
    {},
    { title: 'Verify Ledger (Persisted Rows, v2)', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      if (!isPersistenceEnabled()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            available: false,
            note: 'PostgreSQL persistence is not enabled in this process — there are no persisted rows to verify. Use verify_ledger for the in-memory self-consistency check.',
          }, null, 2) }],
        };
      }

      const rows = (await exportLedgerJSON()) as unknown as ForensicLedgerRow[];
      const result = classifyLedgerRows(rows);

      // Findings are anchored in the immutable record and page MANDATORY.
      let violationAuditId: string | null = null;
      if (!result.clean) {
        violationAuditId = recordIntegrityViolation(engine, {
          totalRows: result.totalRows,
          drift: result.counts.DRIFT,
          brokenLink: result.counts.BROKEN_LINK,
          firstDetail: result.problems[0]
            ? `chain_index=${result.problems[0].chainIndex}: ${result.problems[0].classification} — ${result.problems[0].detail}`
            : 'see problems list',
        });
      }

      engine.telemetryService.emitToolCall('verify_ledger_v2', `verify-v2-${Date.now().toString(36)}`, result.clean ? 'INFORMATIONAL' : 'MANDATORY', result.clean);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          chainIntegrity: result.clean ? 'CLEAN' : 'PROBLEMS_FOUND',
          ...result,
          violationAuditId,
          genesisHash: GENESIS_HASH,
          hashAlgorithm: HASH_ALGORITHM,
          chainVersion: CHAIN_VERSION,
          verificationMethod: {
            type: 'persisted-row-epoch-dispatch',
            scope: 'Reads actual PostgreSQL forensic_ledger rows ordered by chain_index.',
            steps: [
              'Walk persisted rows from chain_index 0 through head',
              'Every row: verify previous_hash matches prior stored entry_hash + chain_index sequential (BROKEN_LINK otherwise)',
              'algo_epoch=2 rows: reconstruct the Ledger Canonical v2 preimage from persisted columns and recompute SHA-256 (INTACT / DRIFT)',
              'algo_epoch=1 rows: LEGACY_LINKAGE_ONLY — heterogeneous pre-v2 bucket, content honestly not verifiable',
              'Findings append a MANDATORY LEDGER_INTEGRITY_VIOLATION entry — never repaired, never UPDATEd',
            ],
          },
          complianceNote: result.clean
            ? `No NEW integrity problems: content verified for ${result.counts.INTACT} epoch-2 rows; ${result.counts.LEGACY_LINKAGE_ONLY} legacy epoch-1 rows linkage-verified only. Known legacy damage on permanent record: ${result.counts.LEGACY_BROKEN_LINK} linkage break(s) at epoch-1 rows (pre-2026-07-01 rewrite-loop damage; immutable, cannot be distinguished from an epoch-1-region edit until external anchoring lands). Internal verification — third-party verifiability requires external anchoring (pending).`
            : `INTEGRITY PROBLEMS FOUND: ${result.counts.DRIFT} content drift, ${result.counts.BROKEN_LINK} epoch-2 broken links (plus ${result.counts.LEGACY_BROKEN_LINK} known legacy breaks). A MANDATORY LEDGER_INTEGRITY_VIOLATION entry was appended (${violationAuditId}). Investigate immediately.`,
        }, null, 2) }],
      };
    }
  );
}
