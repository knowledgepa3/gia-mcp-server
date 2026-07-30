/**
 * @module    forensic-ledger
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — all ledger operations are MANDATORY audit events
 * @audit     true — the ledger IS the audit system
 * @owner     William J. Storey III / ACE / GIA
 *
 * HASH-CHAINED FORENSIC LEDGER
 *
 * Every entry in this ledger is cryptographically chained to the previous entry
 * via SHA-256 hashing. The hash of each entry is computed over the canonical
 * JSON serialization of the entry's data concatenated with the previous entry's hash.
 *
 * This produces a tamper-evident audit trail: modifying any historical entry
 * invalidates the hash chain from that point forward, making tampering
 * computationally detectable.
 *
 * Hash algorithm: SHA-256 (NIST FIPS 180-4)
 * Canonical form: Deterministic JSON with sorted keys, dates as ISO strings
 * Genesis: First entry chains from GENESIS_HASH constant
 *
 * This implementation is a patent claim (Claim 6: Hash-Chained Audit Ledger)
 * in U.S. Provisional Patent Application:
 * "Systems and Methods for Risk-Classified Governance of Autonomous AI Agents
 *  Using Cryptographically Attested Human-in-the-Loop Decision Gates"
 */

import {
  type IAuditEntry, type IGovernanceScore, type IGateDecision, type IMaiResult,
  MaiClassification, GiaLayer, EntryStatus,
} from '../../shared/types.js';
import { MAX_AUDIT_METADATA_SIZE, GENESIS_HASH } from '../../shared/constants.js';
import { computeEntryHashV2, CHAIN_VERSION_V2 } from './canonicalV2.js';
import { projectAuditEntryToV2 } from './projectToV2.js';
import { generateAuditId, utcNow, durationMs, truncateMetadata } from '../../shared/utils.js';
import { LedgerWriteError } from '../../shared/errors.js';
import { persistEntry, recoverEntries, initLedgerPersistence, isPersistenceEnabled, getPersistedCount, closeLedgerPersistence } from './ledger-persistence.js';

// ─── Result type for chain verification ────────────────────────────────────────

export interface IChainVerificationResult {
  /** Whether the entire chain is intact (no tampering detected). */
  valid: boolean;
  /** Total entries verified. */
  entriesVerified: number;
  /** Index of the first broken link, or -1 if chain is valid. */
  firstBrokenLink: number;
  /** Hash of the most recent entry (chain head). */
  headHash: string;
  /** Details of the break if chain is invalid. */
  breakDetail?: string;
  /** Verification timestamp. */
  verifiedAt: Date;
  /** Duration of verification in milliseconds. */
  verificationDurationMs: number;
  /**
   * Entries recovered from PostgreSQL that were LINKAGE-verified only
   * (stored previous_hash → stored entry_hash continuity). Recovered rows may
   * have been written by other writers with different historical preimages, so
   * their content is NOT recomputed here — that is verify_ledger_v2's job.
   */
  linkageOnlyPrefix?: number;
  /** Entries content-verified (hash recomputed and compared) in this walk. */
  contentVerified?: number;
  /**
   * KNOWN legacy linkage breaks in the recovered prefix — permanent historical
   * damage inherited from the pre-2026-07-01 recovery loop that rewrote
   * hashes in place (partial fire-and-forget UPDATE bursts left stale
   * previous_hash pointers). These rows are immutable and will never be
   * "fixed"; the break set is recorded once at recovery and reported here on
   * every walk. `valid` reflects NEW breaks only — a mismatch NOT in the
   * recorded baseline still fails verification.
   */
  legacyLinkageBreaks?: number;
}

// ─── Canonical serialization + hashing ──────────────────────────────────────
// Moved to ./canonical.ts — the SINGLE source of truth shared with
// ledger-persistence.ts so the DB-persisted hash and the in-memory hash can
// never diverge again (truth-map #6, 2026-06-29). computeEntryHash is imported.

// ─── AuditEntryBuilder ─────────────────────────────────────────────────────────

export class AuditEntryBuilder {
  public readonly id: string;
  private readonly startTime: Date;
  private entry: IAuditEntry;
  private sealed = false;

  constructor(operation: string, maiLevel: MaiClassification, layer: GiaLayer, actor: string, parentId?: string, correlationId?: string, delegatedBy?: string) {
    this.id = generateAuditId();
    this.startTime = utcNow();
    this.entry = {
      id: this.id, timestamp: this.startTime, operation, layer, maiLevel,
      actor, status: EntryStatus.STARTED, metadata: {}, parentId, correlationId, delegatedBy,
    };
  }

  complete(score: IGovernanceScore, classification: IMaiResult, gateDecision?: IGateDecision): IAuditEntry {
    this.assertNotSealed();
    this.entry = {
      ...this.entry, status: EntryStatus.COMPLETED,
      governanceScore: score, gateDecision,
      duration: durationMs(this.startTime, utcNow()),
      metadata: { ...this.entry.metadata, maiClassification: classification.classification, maiConfidence: classification.confidence },
      delegatedBy: this.entry.delegatedBy,
    };
    this.sealed = true;
    return this.entry;
  }

  fail(error: Error, maiLevel: MaiClassification): IAuditEntry {
    this.assertNotSealed();
    this.entry = {
      ...this.entry, status: EntryStatus.FAILED, maiLevel,
      duration: durationMs(this.startTime, utcNow()),
      errorCode: ((error as unknown as Record<string, unknown>).code as string) ?? 'UNKNOWN',
      errorMessage: error.message,
      delegatedBy: this.entry.delegatedBy,
    };
    this.sealed = true;
    return this.entry;
  }

  escalate(rationale: string): IAuditEntry {
    this.assertNotSealed();
    this.entry = {
      ...this.entry, status: EntryStatus.ESCALATED,
      duration: durationMs(this.startTime, utcNow()),
      metadata: { ...this.entry.metadata, escalationRationale: rationale },
      delegatedBy: this.entry.delegatedBy,
    };
    this.sealed = true;
    return this.entry;
  }

  addMetadata(key: string, value: unknown): void {
    this.assertNotSealed();
    this.entry.metadata[key] = value;
    this.entry.metadata = truncateMetadata(this.entry.metadata, MAX_AUDIT_METADATA_SIZE);
  }

  private assertNotSealed(): void {
    if (this.sealed) throw new Error(`Audit entry ${this.id} already sealed.`);
  }
}

// ─── ForensicLedger ─────────────────────────────────────────────────────────────

/**
 * ForensicLedger — hash-chained, append-only audit log.
 *
 * CRITICAL DESIGN: This is a true append-only chain with SHA-256 hash linking.
 * Every state transition (STARTED → COMPLETED, STARTED → FAILED, etc.) is
 * recorded as a separate entry in the log. Entries are never overwritten or deleted.
 *
 * HASH CHAIN: Every entry includes:
 *   - previousHash: the SHA-256 hash of the preceding entry (or GENESIS_HASH for entry 0)
 *   - entryHash: SHA-256(previousHash || canonicalize(entry))
 *   - chainIndex: the entry's position in the append-only log
 *
 * TAMPER EVIDENCE: To verify integrity, recompute each entry's hash from its
 * canonical data and the previous entry's hash. If any computed hash doesn't
 * match the stored hash, the chain has been tampered with.
 *
 * The `latestByAuditId` index provides O(1) lookup for the most recent
 * state of a given audit ID, but the full history is always preserved
 * in the append-only `log` array.
 *
 * If there is no record, it did not happen.
 */
export class ForensicLedger {
  /** Append-only log — entries are NEVER removed or overwritten. */
  private readonly log: IAuditEntry[] = [];
  /** Index: audit ID → most recent entry for that ID (for fast lookup). */
  private readonly latestByAuditId: Map<string, number> = new Map();
  /** Tracks builders that have not yet been completed/failed/escalated. */
  private activeBuilders: Map<string, AuditEntryBuilder> = new Map();
  /** The hash of the most recently appended entry. GENESIS_HASH before any entries. */
  private headHash: string = GENESIS_HASH;
  /**
   * Incremental verification checkpoint.
   * verifyChain() starts from here instead of index 0, making repeat calls
   * O(new entries) rather than O(n). Reset to -1 on any tamper detection.
   * Set to log.length-1 after recovery (recovery already recomputes all hashes).
   */
  private verifyCheckpointIndex: number = -1;
  private verifyCheckpointHash: string = GENESIS_HASH;
  /**
   * Index of the last entry loaded from PostgreSQL during recovery, or -1 if
   * this process started fresh. Entries at or below this index carry STORED
   * hashes (possibly produced by other writers with different historical
   * preimages) and are LINKAGE-verified only; entries above it were hashed by
   * this process and are content-verifiable with this process's algorithm.
   */
  private recoveryBoundaryIndex: number = -1;
  /**
   * Log positions (array index) of recovered entries whose STORED previous_hash
   * did not match the prior stored entry_hash — the known-legacy-break baseline
   * recorded ONCE at recovery. verifyChain treats exactly these positions as
   * documented historical damage (reported, never paged); any OTHER mismatch is
   * a NEW break and fails verification. Without this baseline the integrity
   * sentry would fire a MANDATORY gate at every boot, forever, for immutable
   * history (gate-fatigue failure mode, incident 2026-07-01 gate-9d3f1c43).
   */
  private readonly legacyBreakPositions: Set<number> = new Set();

  /**
   * Initialize persistence and recover ledger state from PostgreSQL.
   * Call once at startup BEFORE any operations execute.
   * If no DATABASE_URL, runs in-memory only (graceful degradation).
   */
  async initPersistence(): Promise<{ recovered: number; persisted: boolean }> {
    const persisted = await initLedgerPersistence();
    if (!persisted) {
      return { recovered: 0, persisted: false };
    }

    // Recover entries from PostgreSQL
    const entries = await recoverEntries();
    if (entries.length === 0) {
      console.error('[ForensicLedger] No entries to recover — starting fresh');
      return { recovered: 0, persisted: true };
    }

    // Rebuild the in-memory chain from recovered entries.
    // Entries arrive sorted by chain_index ASC.
    //
    // READ-ONLY RECOVERY (2026-07-01, STATE-OF-THE-LEDGER-VERIFIED-2026-06-30
    // F-2): recovery NEVER rewrites the persisted ledger. The previous
    // implementation recomputed every row's hash with THIS process's algorithm
    // and UPDATE'd any "drifted" row back to the DB. Because the ledger is
    // written by multiple writers with historically different preimages
    // (Express auditStoreSecure, charterIntegritySentry, tenantProvisioning),
    // every non-MCP row "drifted" on every restart — so recovery was silently
    // rewriting other writers' rows AND would have laundered a genuine tamper
    // (recompute over the edited body, overwrite the stored hash, destroy the
    // evidence). Now: stored hashes are carried forward untouched, and the
    // recovered prefix is LINKAGE-verified only (stored previous_hash must
    // equal the prior row's stored entry_hash). Content verification of
    // persisted rows is verify_ledger_v2's job, dispatched per algorithm epoch.
    let linkageBreaks = 0;
    let epoch2Drift = 0;
    let prevStoredHash = GENESIS_HASH;

    for (const entry of entries) {
      if (entry.previousHash !== prevStoredHash) {
        linkageBreaks++;
        // Record the position in the known-legacy-break baseline: reported on
        // every verify walk, but only NEW breaks (not in this set) page.
        this.legacyBreakPositions.add(this.log.length);
        console.error(
          `[ForensicLedger] LINKAGE BREAK in persisted chain at chain_index=${entry.chainIndex} ` +
          `(op=${entry.operation}): stored previous_hash=${String(entry.previousHash).substring(0, 12)}... ` +
          `!= prior stored entry_hash=${prevStoredHash.substring(0, 12)}... — NOT repaired (read-only recovery)`
        );
      }

      // Epoch-aware content ASSERT (report-only, design §7.1): epoch-2 rows
      // were written with Ledger Canonical v2, so a recompute is meaningful.
      // Epoch-1 rows are the heterogeneous legacy bucket — linkage-only.
      if (entry.algoEpoch === CHAIN_VERSION_V2 && entry.previousHash) {
        const recomputed = computeEntryHashV2(entry.previousHash, projectAuditEntryToV2(entry));
        if (recomputed !== entry.entryHash) {
          epoch2Drift++;
          console.error(
            `[ForensicLedger] EPOCH-2 CONTENT DRIFT at chain_index=${entry.chainIndex} ` +
            `(op=${entry.operation}): stored entry_hash does not match v2 recompute — ` +
            `possible row tamper. NOT repaired (read-only recovery); run verify_ledger_v2.`
          );
        }
      }

      // Keep the STORED chain fields exactly as persisted — no re-linking,
      // no re-hashing, no UPDATE. The persisted ledger is the record.
      const frozen = Object.freeze({ ...entry });
      const idx = this.log.length;
      this.log.push(frozen);
      this.latestByAuditId.set(entry.id, idx);
      prevStoredHash = entry.entryHash ?? prevStoredHash;
    }

    this.headHash = prevStoredHash;
    // The recovered prefix is LINKAGE-verified only, NOT content-verified.
    // recoveryBoundaryIndex marks where trust-in-stored-hashes ends and
    // in-process content verification begins; verifyChain(Full) uses it to
    // avoid falsely recomputing other writers' rows with this algorithm.
    this.recoveryBoundaryIndex = this.log.length - 1;
    this.verifyCheckpointIndex = this.log.length - 1;
    this.verifyCheckpointHash = prevStoredHash;

    if (linkageBreaks > 0 || epoch2Drift > 0) {
      console.error(`[ForensicLedger] Recovered ${entries.length} entries from PostgreSQL — ${linkageBreaks} LINKAGE BREAK(S), ${epoch2Drift} epoch-2 content drift(s) detected and left untouched (head: ${this.headHash.substring(0, 12)}...)`);
    } else {
      console.error(`[ForensicLedger] Recovered ${entries.length} entries from PostgreSQL, linkage intact (head: ${this.headHash.substring(0, 12)}...)`);
    }
    return { recovered: entries.length, persisted: true };
  }

  /** Whether PostgreSQL persistence is active. */
  get persistent(): boolean { return isPersistenceEnabled(); }

  /** Count of entries persisted to PostgreSQL. */
  async persistedCount(): Promise<number> { return getPersistedCount(); }

  /** Close the persistence pool on shutdown. */
  async closePersistence(): Promise<void> { return closeLedgerPersistence(); }

  begin(operation: string, maiLevel: MaiClassification, layer: GiaLayer = GiaLayer.CORE, actor: string = 'SYSTEM', parentId?: string, correlationId?: string, delegatedBy?: string): AuditEntryBuilder {
    const builder = new AuditEntryBuilder(operation, maiLevel, layer, actor, parentId, correlationId, delegatedBy);
    this.activeBuilders.set(builder.id, builder);
    const startEntry: IAuditEntry = {
      id: builder.id, timestamp: utcNow(), operation, layer, maiLevel,
      actor, status: EntryStatus.STARTED, metadata: {}, parentId, correlationId, delegatedBy,
    };
    this.appendEntry(startEntry);
    return builder;
  }

  record(entry: IAuditEntry): void {
    this.appendEntry(entry);
    this.activeBuilders.delete(entry.id);
  }

  /** Get the most recent state of an audit entry by ID. */
  getEntry(id: string): IAuditEntry | undefined {
    const idx = this.latestByAuditId.get(id);
    return idx !== undefined ? this.log[idx] : undefined;
  }

  /** Get the full state-transition history for a given audit ID (append-only proof). */
  getEntryHistory(id: string): IAuditEntry[] {
    return this.log.filter(e => e.id === id);
  }

  queryByOperation(operation: string): IAuditEntry[] {
    // Return only the latest state per audit ID for a given operation
    const seen = new Set<string>();
    const results: IAuditEntry[] = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i];
      if (e.operation === operation && !seen.has(e.id)) {
        seen.add(e.id);
        results.push(e);
      }
    }
    return results.reverse();
  }

  queryByMaiLevel(level: MaiClassification, since?: Date): IAuditEntry[] {
    return this.getLatestEntries()
      .filter(e => e.maiLevel === level)
      .filter(e => !since || e.timestamp >= since);
  }

  queryByTimeRange(start: Date, end: Date): IAuditEntry[] {
    return this.getLatestEntries().filter(e => e.timestamp >= start && e.timestamp <= end);
  }

  queryCompleted(since?: Date): IAuditEntry[] {
    return this.getLatestEntries()
      .filter(e => e.status === EntryStatus.COMPLETED || e.status === EntryStatus.ESCALATED)
      .filter(e => !since || e.timestamp >= since);
  }

  /** Total entries in the append-only log (including state transitions). */
  get size(): number { return this.log.length; }

  /** Total unique audit IDs tracked. */
  get uniqueOperations(): number { return this.latestByAuditId.size; }

  /** The SHA-256 hash of the most recent entry in the chain. */
  get chainHead(): string { return this.headHash; }

  countByStatus(status: EntryStatus): number {
    return this.getLatestEntries().filter(e => e.status === status).length;
  }

  getActiveOperations(): string[] { return Array.from(this.activeBuilders.keys()); }

  /**
   * Verify the internal consistency of the in-memory hash chain.
   *
   * Entries appended by THIS process (above recoveryBoundaryIndex) are
   * content-verified: their hash is recomputed with this process's algorithm
   * and compared. Entries recovered from PostgreSQL (at or below the boundary)
   * are LINKAGE-verified only — stored previous_hash must equal the prior
   * entry's stored entry_hash — because recovered rows may have been written
   * by other writers whose historical preimages differ; recomputing them with
   * this algorithm would report false tampering. Persisted-row content
   * verification is verify_ledger_v2's job.
   *
   * Time complexity: O(n) where n = log.length
   * This is an INFORMATIONAL operation — read-only, no side effects.
   */
  verifyChain(): IChainVerificationResult {
    const startTime = Date.now();
    const linkageOnlyPrefix = this.recoveryBoundaryIndex + 1;
    const legacyLinkageBreaks = this.legacyBreakPositions.size;

    if (this.log.length === 0) {
      return {
        valid: true,
        entriesVerified: 0,
        firstBrokenLink: -1,
        headHash: GENESIS_HASH,
        verifiedAt: utcNow(),
        verificationDurationMs: Date.now() - startTime,
        linkageOnlyPrefix: 0,
        contentVerified: 0,
        legacyLinkageBreaks: 0,
      };
    }

    // Incremental: start from the last verified checkpoint.
    // If nothing new since last verify, return instantly.
    const startIndex = this.verifyCheckpointIndex + 1;
    if (startIndex >= this.log.length) {
      return {
        valid: true,
        entriesVerified: this.log.length,
        firstBrokenLink: -1,
        headHash: this.verifyCheckpointHash,
        verifiedAt: utcNow(),
        verificationDurationMs: Date.now() - startTime,
        linkageOnlyPrefix,
        contentVerified: Math.max(0, this.log.length - linkageOnlyPrefix),
        legacyLinkageBreaks,
      };
    }

    let previousHash = startIndex === 0 ? GENESIS_HASH : this.verifyCheckpointHash;
    let contentVerified = 0;

    const fail = (i: number, breakDetail: string): IChainVerificationResult => {
      this.verifyCheckpointIndex = -1;
      this.verifyCheckpointHash = GENESIS_HASH;
      return {
        valid: false,
        entriesVerified: i,
        firstBrokenLink: i,
        headHash: previousHash,
        breakDetail,
        verifiedAt: utcNow(),
        verificationDurationMs: Date.now() - startTime,
        linkageOnlyPrefix,
        contentVerified,
        legacyLinkageBreaks,
      };
    };

    for (let i = startIndex; i < this.log.length; i++) {
      const entry = this.log[i];
      const isRecovered = i <= this.recoveryBoundaryIndex;

      // Linkage check — applies to every entry, recovered or not.
      // A mismatch at a KNOWN legacy-break position (recorded once at
      // recovery) is permanent immutable history: reported via
      // legacyLinkageBreaks, never re-paged. Any OTHER mismatch is NEW.
      if (entry.previousHash !== previousHash) {
        if (!(isRecovered && this.legacyBreakPositions.has(i))) {
          return fail(i, `Previous hash mismatch at position ${i}: expected ${previousHash.substring(0, 16)}..., found ${(entry.previousHash ?? 'undefined').substring(0, 16)}...`);
        }
      }

      if (isRecovered) {
        // Recovered row: carry the STORED hash forward — linkage-only.
        // Recomputing another writer's historical preimage with this
        // process's algorithm would report false tampering.
        previousHash = entry.entryHash ?? previousHash;
        continue;
      }

      // In-process entry: full content verification (epoch-2 algorithm).
      if (entry.chainIndex !== i) {
        return fail(i, `Chain index mismatch at position ${i}: expected ${i}, found ${entry.chainIndex}`);
      }

      const recomputed = computeEntryHashV2(previousHash, projectAuditEntryToV2(entry));
      if (entry.entryHash !== recomputed) {
        return fail(i, `Entry hash mismatch at position ${i} (id: ${entry.id}, op: ${entry.operation}): stored ${(entry.entryHash ?? 'undefined').substring(0, 16)}..., computed ${recomputed.substring(0, 16)}...`);
      }

      contentVerified++;
      previousHash = recomputed;
    }

    // Advance checkpoint to cover all verified entries
    this.verifyCheckpointIndex = this.log.length - 1;
    this.verifyCheckpointHash = previousHash;

    return {
      valid: true,
      entriesVerified: this.log.length,
      firstBrokenLink: -1,
      headHash: previousHash,
      verifiedAt: utcNow(),
      verificationDurationMs: Date.now() - startTime,
      linkageOnlyPrefix,
      contentVerified,
      legacyLinkageBreaks,
    };
  }

  /**
   * Full O(n) chain recomputation from genesis — always walks every entry.
   * Use for compliance exports, explicit audit requests, or after a tamper alert.
   * The normal verifyChain() is incremental and O(new entries).
   */
  verifyChainFull(): IChainVerificationResult {
    // Temporarily reset checkpoint so verifyChain() walks from 0
    const savedIndex = this.verifyCheckpointIndex;
    const savedHash = this.verifyCheckpointHash;
    this.verifyCheckpointIndex = -1;
    this.verifyCheckpointHash = GENESIS_HASH;
    const result = this.verifyChain();
    // If full verify failed, checkpoint stays reset (tamper detected)
    if (!result.valid) {
      this.verifyCheckpointIndex = savedIndex;
      this.verifyCheckpointHash = savedHash;
    }
    return result;
  }

  /**
   * Get a contiguous slice of the raw append-only log with hash chain data.
   * Used for chain export, external verification, and compliance evidence.
   */
  getChainSlice(start: number, end?: number): IAuditEntry[] {
    return this.log.slice(start, end);
  }

  /** Returns the latest entry for each unique audit ID. */
  private getLatestEntries(): IAuditEntry[] {
    return Array.from(this.latestByAuditId.values()).map(idx => this.log[idx]);
  }

  /**
   * Append-only write with SHA-256 hash chaining.
   *
   * For each entry appended:
   * 1. Set chainIndex to the current log length (position in chain)
   * 2. Set previousHash to the hash of the last entry (or GENESIS_HASH)
   * 3. Compute entryHash = SHA-256(previousHash || canonicalize(entry))
   * 4. Freeze the entry (immutable)
   * 5. Push to append-only log
   * 6. Update headHash to the new entry's hash
   *
   * Once appended, the entry is frozen and its hash is part of the chain.
   * Any subsequent entry's hash depends on this one, making retroactive
   * modification detectable.
   */
  private appendEntry(entry: IAuditEntry): void {
    try {
      // Step 1-2: Assign chain position and previous hash
      const chainedEntry: IAuditEntry = {
        ...entry,
        chainIndex: this.log.length,
        previousHash: this.headHash,
        algoEpoch: CHAIN_VERSION_V2,
      };

      // Step 3: Compute SHA-256 hash over (previousHash || canonicalV2 projection).
      // Epoch-2 (Ledger Canonical v2): the hash attests the closed v2 skeleton
      // (id/timestamp/operation/layer/actor/correlationId/parentId/metadata/
      // schemaVersion); excluded fields remain content-attested DB columns.
      const hash = computeEntryHashV2(this.headHash, projectAuditEntryToV2(chainedEntry));
      chainedEntry.entryHash = hash;

      // Step 4-5: Freeze and append
      const frozen = Object.freeze(chainedEntry);
      const idx = this.log.length;
      this.log.push(frozen);
      this.latestByAuditId.set(entry.id, idx);

      // Step 6: Advance chain head
      this.headHash = hash;

      // Step 7: Persist to PostgreSQL (fire-and-forget — never blocks)
      persistEntry(frozen);
    } catch (error) {
      throw new LedgerWriteError(entry.operation, entry.id, error instanceof Error ? error : new Error(String(error)));
    }
  }
}
