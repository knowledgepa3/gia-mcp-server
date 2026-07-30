/**
 * @module    mcp-tool-verify-ledger
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — read-only verification, no side effects
 * @audit     false — verification itself does not modify the ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verify the internal self-consistency of the hash-chained forensic audit ledger.
 *
 * HONEST SCOPE (rescoped 2026-07-01, STATE-OF-THE-LEDGER-VERIFIED-2026-06-30 §4):
 * this tool walks the IN-MEMORY chain reconstruction, not persisted DB rows.
 * It proves the in-memory chain is internally self-consistent and linkage-intact
 * (append-only). It is NOT third-party content-verification and cannot detect
 * a direct edit to a persisted database row. Persisted-row verification is
 * verify_ledger_v2's job (Phase 5, ledger canonicalization v2).
 *
 * Classification: INFORMATIONAL — no mutations, no side effects.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GovernanceEngine } from '../../core/governance.js';
import { GENESIS_HASH, HASH_ALGORITHM, CHAIN_VERSION } from '../../shared/constants.js';

export function registerVerifyLedgerTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'verify_ledger',
    'Check the internal self-consistency of the hash-chained forensic audit ledger. Walks the in-memory chain reconstruction (not persisted DB rows) and reports whether it is internally consistent and linkage-intact. Not third-party content-verification. Classification: INFORMATIONAL — read-only, no side effects.',
    {},
    { title: 'Verify Ledger Integrity', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      // Full O(n) walk of the IN-MEMORY chain from genesis. The default verifyChain()
      // is an incremental checkpoint walk; for an explicit audit request we walk the
      // whole in-memory chain. NOTE: this is self-consistency over the process's own
      // reconstruction — it does not re-read persisted DB rows and cannot detect a
      // direct DB row edit (see module header; verify_ledger_v2 covers persisted rows).
      const result = engine.ledger.verifyChainFull();

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('verify_ledger', `verify-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          chainIntegrity: result.valid ? 'INTACT' : 'BROKEN',
          entriesVerified: result.entriesVerified,
          totalEntries: engine.ledger.size,
          chainHead: result.headHash,
          genesisHash: GENESIS_HASH,
          hashAlgorithm: HASH_ALGORITHM,
          chainVersion: CHAIN_VERSION,
          firstBrokenLink: result.firstBrokenLink,
          breakDetail: result.breakDetail ?? null,
          // Honest split: recovered-from-DB entries are linkage-verified only
          // (stored hash continuity); only in-process entries are content-verified.
          linkageOnlyPrefix: result.linkageOnlyPrefix ?? null,
          contentVerified: result.contentVerified ?? null,
          // Permanent historical damage from the pre-2026-07-01 rewrite loop —
          // recorded at recovery, reported on every walk, immutable by design.
          // `chainIntegrity` reflects NEW breaks only; see verify_ledger_v2 for
          // the persisted-row classification of these rows.
          legacyLinkageBreaks: result.legacyLinkageBreaks ?? null,
          verifiedAt: result.verifiedAt.toISOString(),
          verificationDurationMs: result.verificationDurationMs,
          verificationMethod: {
            type: 'in-memory-self-consistency',
            scope: 'Walks the in-memory chain reconstruction, NOT persisted DB rows. Cannot detect a direct edit to a persisted database row.',
            steps: [
              'Walk the in-memory append-only log from entry 0 through N',
              'For each entry: recompute SHA-256(previousHash || canonicalizedEntry)',
              'Verify recomputed hash matches the in-memory entryHash',
              'Verify each entry.previousHash matches prior entry.entryHash',
              'Verify final recomputed hash equals reported chainHead',
            ],
          },
          complianceNote: result.valid
            ? 'Hash chain is internally self-consistent and linkage-intact (append-only). This walks the in-memory reconstruction, not persisted DB rows; it is not third-party content-verification. See verify_ledger_v2 for persisted-row verification.'
            : `CHAIN SELF-CONSISTENCY FAILURE at entry ${result.firstBrokenLink}. The in-memory chain does not verify — investigate immediately.`,
        }, null, 2) }],
      };
    }
  );
}
