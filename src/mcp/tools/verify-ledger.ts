/**
 * @module    mcp-tool-verify-ledger
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — read-only verification, no side effects
 * @audit     false — verification itself does not modify the ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verify the integrity of the hash-chained forensic audit ledger.
 *
 * This tool recomputes every SHA-256 hash in the chain from genesis
 * and compares against stored hashes. If any entry has been modified,
 * the chain breaks at that point and the tool reports the exact
 * location and nature of the break.
 *
 * Classification: INFORMATIONAL — no mutations, no side effects.
 * This is a pure verification/compliance evidence tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GovernanceEngine } from '../../core/governance.js';
import { GENESIS_HASH, HASH_ALGORITHM, CHAIN_VERSION } from '../../shared/constants.js';

export function registerVerifyLedgerTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'verify_ledger',
    'Verify the integrity of the hash-chained forensic audit ledger. Recomputes every SHA-256 hash from genesis and reports whether the chain is intact. Classification: INFORMATIONAL — read-only, no side effects.',
    {},
    { title: 'Verify Ledger Integrity', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const result = engine.ledger.verifyChain();

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
          verifiedAt: result.verifiedAt.toISOString(),
          verificationDurationMs: result.verificationDurationMs,
          verificationMethod: {
            type: 'full-chain-recomputation',
            steps: [
              'Walk append-only ledger from entry 0 through N',
              'For each entry: recompute SHA-256(previousHash || canonicalizedEntry)',
              'Verify recomputed hash matches stored entryHash',
              'Verify each entry.previousHash matches prior entry.entryHash',
              'Verify final recomputed hash equals reported chainHead',
            ],
          },
          complianceNote: result.valid
            ? 'Hash chain verified — tamper-evident audit trail is intact. Suitable for EU AI Act Article 12 (Record-Keeping) and NIST 800-53 AU (Audit and Accountability) compliance evidence.'
            : `CHAIN INTEGRITY FAILURE at entry ${result.firstBrokenLink}. Audit trail tamper evidence detected. Investigate immediately.`,
        }, null, 2) }],
      };
    }
  );
}
