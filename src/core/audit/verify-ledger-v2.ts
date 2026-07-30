/**
 * @module    verify-ledger-v2
 * @layer     GOVERNANCE
 * @inherits  audit-canonical-v2
 * @mai       I — read-only verification; findings escalate via the caller
 * @audit     false — this module never writes (violations are appended by the caller)
 * @owner     William J. Storey III / ACE / GIA
 *
 * PERSISTED-ROW LEDGER VERIFIER (Option A §7) — the real one.
 *
 * Unlike verify_ledger (in-memory self-consistency), this walks the PERSISTED
 * forensic_ledger rows and dispatches PER ROW by algorithm epoch:
 *
 *   algo_epoch=2  → CONTENT verification: reconstruct the LedgerCanonicalEntry
 *                   from persisted columns (field-to-column closure, §7.3) and
 *                   recompute computeEntryHashV2. Match → INTACT, else DRIFT.
 *                   A hash match also PROVES the in-preimage schemaVersion=2
 *                   agrees with the algo_epoch column (R-7): the recompute
 *                   embeds schemaVersion, so a mislabeled epoch cannot verify.
 *   algo_epoch=1  → LEGACY_LINKAGE_ONLY: the heterogeneous legacy bucket
 *                   (≥3 sub-algorithms, no per-row record of which) — linkage
 *                   is checked, content CANNOT be honestly verified.
 *   anything else → LEGACY_UNVERIFIABLE.
 *
 * Linkage (previous_hash → prior entry_hash continuity + chain_index
 * sequentiality) is checked for EVERY row regardless of epoch → BROKEN_LINK.
 *
 * NEVER repairs, never UPDATEs, never mutates. Findings are returned; the
 * caller appends (INSERT) a LEDGER_INTEGRITY_VIOLATION entry — the completeness
 * -patrol pattern — and pages MANDATORY.
 */

import { GENESIS_HASH } from '../../shared/constants.js';
import { computeEntryHashV2, mapToV2Layer, CHAIN_VERSION_V2, type LedgerCanonicalSource } from './canonicalV2.js';

export type LedgerRowClassification =
  | 'INTACT'
  | 'DRIFT'
  | 'BROKEN_LINK'
  | 'LEGACY_BROKEN_LINK'
  | 'LEGACY_LINKAGE_ONLY'
  | 'LEGACY_UNVERIFIABLE';

export interface LedgerRowProblem {
  chainIndex: number;
  classification: LedgerRowClassification;
  operation: string;
  detail: string;
}

export interface VerifyLedgerV2Result {
  totalRows: number;
  counts: Record<LedgerRowClassification, number>;
  /**
   * True when no DRIFT and no epoch-2 BROKEN_LINK anywhere in the chain.
   * LEGACY_BROKEN_LINK rows (linkage breaks at epoch-1 rows — the immutable
   * damage left by the pre-2026-07-01 rewrite loop) are permanently REPORTED
   * in counts/problems but do not page: without an externally anchored
   * baseline (Phase 6) a new epoch-1-region edit is indistinguishable from
   * the historical damage — that limitation is stated, not hidden (R-6b).
   */
  clean: boolean;
  /** Problems, most severe first, capped (totalProblems carries the true count). */
  problems: LedgerRowProblem[];
  totalProblems: number;
  chainHead: string | null;
  headChainIndex: number | null;
  verifiedAt: string;
  verificationDurationMs: number;
}

/** Raw forensic_ledger row (snake_case, as returned by SELECT *). */
export interface ForensicLedgerRow {
  id: string;
  chain_index: number;
  timestamp: Date | string;
  operation: string;
  layer: string;
  actor: string;
  parent_id: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
  entry_hash: string;
  previous_hash: string;
  algo_epoch?: number | null;
}

const MAX_REPORTED_PROBLEMS = 25;

/**
 * Reconstruct the epoch-2 canonical source from persisted columns (§7.3 —
 * every hashed v2 field must round-trip losslessly from a column; the write
 * paths guarantee this via the closure rule in each projectToV2 mapper).
 */
export function v2SourceFromRow(row: ForensicLedgerRow): LedgerCanonicalSource {
  return {
    id: row.id,
    timestamp: row.timestamp,
    operation: row.operation,
    layer: mapToV2Layer(row.layer),
    actor: row.actor,
    correlationId: row.correlation_id ?? null,
    parentId: row.parent_id ?? null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Classify every persisted row. Pure — rows in, verdict out. No I/O, no writes.
 */
export function classifyLedgerRows(rows: ForensicLedgerRow[]): VerifyLedgerV2Result {
  const startTime = Date.now();
  const counts: Record<LedgerRowClassification, number> = {
    INTACT: 0,
    DRIFT: 0,
    BROKEN_LINK: 0,
    LEGACY_BROKEN_LINK: 0,
    LEGACY_LINKAGE_ONLY: 0,
    LEGACY_UNVERIFIABLE: 0,
  };
  const problems: LedgerRowProblem[] = [];
  let totalProblems = 0;

  const report = (p: LedgerRowProblem): void => {
    totalProblems++;
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push(p);
  };

  let prevStoredHash = GENESIS_HASH;
  let prevChainIndex: number | null = null;

  for (const row of rows) {
    let broken = false;
    // A linkage break AT an epoch-1 row is the known immutable damage class
    // left by the pre-2026-07-01 rewrite loop (partial UPDATE bursts) —
    // permanently reported, but not the same severity as a break at an
    // epoch-2 row, which the read-only/append-only regime can never produce
    // legitimately.
    const isLegacyRow = (row.algo_epoch ?? 1) === 1;
    const breakClass: LedgerRowClassification = isLegacyRow ? 'LEGACY_BROKEN_LINK' : 'BROKEN_LINK';

    // Linkage — writer-agnostic, meaningful for every epoch.
    if (row.previous_hash !== prevStoredHash) {
      broken = true;
      report({
        chainIndex: row.chain_index,
        classification: breakClass,
        operation: row.operation,
        detail: `previous_hash ${String(row.previous_hash).slice(0, 16)}… does not match prior entry_hash ${prevStoredHash.slice(0, 16)}…`,
      });
    }
    if (prevChainIndex !== null && row.chain_index !== prevChainIndex + 1) {
      broken = true;
      report({
        chainIndex: row.chain_index,
        classification: breakClass,
        operation: row.operation,
        detail: `chain_index gap: ${prevChainIndex} → ${row.chain_index}`,
      });
    }

    if (broken) {
      counts[breakClass]++;
    } else if ((row.algo_epoch ?? 1) === CHAIN_VERSION_V2) {
      // Epoch-2: honest content verification against persisted columns.
      let recomputed: string | null = null;
      let failureDetail = '';
      try {
        recomputed = computeEntryHashV2(row.previous_hash, v2SourceFromRow(row));
      } catch (err) {
        failureDetail = ` (reconstruction failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      if (recomputed === row.entry_hash) {
        counts.INTACT++;
      } else {
        counts.DRIFT++;
        report({
          chainIndex: row.chain_index,
          classification: 'DRIFT',
          operation: row.operation,
          detail: `stored entry_hash does not match v2 recompute from persisted columns${failureDetail} — row body edited, or algo_epoch mislabeled (R-7); investigate immediately`,
        });
      }
    } else if ((row.algo_epoch ?? 1) === 1) {
      // Legacy bucket: linkage held (checked above); content is NOT verifiable.
      counts.LEGACY_LINKAGE_ONLY++;
    } else {
      counts.LEGACY_UNVERIFIABLE++;
      report({
        chainIndex: row.chain_index,
        classification: 'LEGACY_UNVERIFIABLE',
        operation: row.operation,
        detail: `unknown algo_epoch=${String(row.algo_epoch)} — no algorithm can be honestly applied`,
      });
    }

    prevStoredHash = row.entry_hash;
    prevChainIndex = row.chain_index;
  }

  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    totalRows: rows.length,
    counts,
    clean: counts.BROKEN_LINK === 0 && counts.DRIFT === 0,
    // LEGACY_BROKEN_LINK deliberately excluded from `clean` — see field doc.
    problems,
    totalProblems,
    chainHead: last ? last.entry_hash : null,
    headChainIndex: last ? last.chain_index : null,
    verifiedAt: new Date().toISOString(),
    verificationDurationMs: Date.now() - startTime,
  };
}
