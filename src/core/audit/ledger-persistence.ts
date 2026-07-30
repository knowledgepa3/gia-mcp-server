/**
 * @module    ledger-persistence
 * @layer     GOVERNANCE
 * @mai       M — persistence of audit entries is MANDATORY
 * @audit     true — this IS the persistence layer for the audit system
 * @owner     William J. Storey III / ACE / GIA
 *
 * FORENSIC LEDGER POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for the in-memory ForensicLedger.
 * Every entry appended to the ledger is also written to PostgreSQL.
 * On startup, the ledger is recovered from the database.
 *
 * Design principles:
 * - Async writes: never block the in-memory ledger
 * - Recovery: rebuild full chain from PostgreSQL on startup
 * - Append-only: PostgreSQL rules prevent UPDATE/DELETE
 * - No data loss: fire-and-forget with error logging
 */

import type { IAuditEntry } from '../../shared/types.js';
import { computeEntryHashV2, toCanonicalTimestamp, CHAIN_VERSION_V2 } from './canonicalV2.js';
import { projectAuditEntryToV2 } from './projectToV2.js';

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let poolInitialized = false;
let persistenceEnabled = false;

/**
 * Unique instance ID for this process. Tracks which writer produced each
 * ledger entry so that chain integrity can be verified per-writer even when
 * multiple processes (ace-server, gia-mcp) share the same forensic_ledger table.
 */
const SOURCE_INSTANCE = `${process.env.HOSTNAME || 'unknown'}-${process.pid}-${Date.now().toString(36)}`;

/**
 * Initialize the PostgreSQL connection pool for ledger persistence.
 * Call once at server startup. If DATABASE_URL is not set, persistence
 * is disabled gracefully (ledger works in-memory only).
 */
export async function initLedgerPersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[Ledger-Persist] No DATABASE_URL — running in-memory only');
    return false;
  }

  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      // Sized at 20 for concurrent readers/writers. (Historically bumped from
      // 5 to absorb the recovery hash-sync UPDATE burst; that write path was
      // permanently removed 2026-07-01 — recovery is read-only now.)
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Verify connection
    const client = await pool.connect();
    // Ensure table exists (idempotent)
    // PRIMARY KEY is (chain_index), NOT (id): the ledger records every state
    // transition (STARTED, then COMPLETED/FAILED) as a SEPARATE row sharing the
    // audit id, so id is intentionally NON-UNIQUE (F-5, migration 155). Making
    // id the PK silently dropped one transition per audit. chain_index is the
    // natural key (globally unique, monotonic). Fresh/DR deploys must match m155.
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_ledger (
        id              TEXT        NOT NULL,
        chain_index     INTEGER     NOT NULL PRIMARY KEY,
        timestamp       TIMESTAMPTZ NOT NULL,
        operation       TEXT        NOT NULL,
        layer           TEXT        NOT NULL DEFAULT 'CORE',
        mai_level       TEXT        NOT NULL,
        actor           TEXT        NOT NULL DEFAULT 'SYSTEM',
        status          TEXT        NOT NULL,
        parent_id       TEXT,
        correlation_id   TEXT,
        governance_score JSONB,
        gate_decision    JSONB,
        metadata         JSONB      NOT NULL DEFAULT '{}',
        duration         INTEGER,
        error_code       TEXT,
        error_message    TEXT,
        entry_hash       TEXT        NOT NULL UNIQUE,
        previous_hash    TEXT        NOT NULL,
        source_instance  TEXT,
        delegated_by     TEXT,
        tenant_id        TEXT        NOT NULL DEFAULT 'default',
        actor_tenant_id  TEXT,
        algo_epoch       INTEGER     NOT NULL DEFAULT 1,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add columns to existing tables (safe for upgrades).
    // NOTE (R-9): the table is declared in THREE places — server migrations
    // (026 base, 052 delegated_by/actor_tenant_id, 110 tenant_id, 154 algo_epoch),
    // this inline CREATE, and this ALTER list. Any new column MUST be added to
    // all three or a fresh/DR deploy that bootstraps the table here will reject
    // every INSERT naming the column.
    //
    // 2026-07-18 live-fire finding: delegated_by/tenant_id/actor_tenant_id were
    // in the real INSERT (below) and in migrations 052/110, but NOT here — a
    // fresh/DR bootstrap using this fallback silently dropped every single
    // forensic_ledger write (fire-and-forget catch, never surfaced to the
    // caller). Confirmed live on a throwaway Postgres: zero rows persisted
    // across a full test run. Production was never affected — its schema came
    // from the real migration chain, which already had all three columns.
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS correlation_id TEXT
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS source_instance TEXT
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS delegated_by TEXT
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS actor_tenant_id TEXT
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS algo_epoch INTEGER NOT NULL DEFAULT 1
    `).catch(() => { /* column already exists */ });
    // Fast lookup by audit id now that id is non-unique (state-transition history).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_ledger_id ON forensic_ledger(id)
    `).catch(() => { /* index already exists */ });
    client.release();

    poolInitialized = true;
    persistenceEnabled = true;
    console.error('[Ledger-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[Ledger-Persist] Failed to initialize — running in-memory only:', (err as Error).message);
    return false;
  }
}

/**
 * Advisory lock ID for serializing chain writes across processes.
 * Both ace-server and gia-mcp must use the same lock to prevent forking.
 * Value is arbitrary but must be consistent across all writers.
 */
const CHAIN_LOCK_ID = 777_888_999;

// Epoch-2 hashing happens inline in persistEntry via projectAuditEntryToV2 +
// computeEntryHashV2 (Ledger Canonical v2, 2026-07-01). The projected v2
// metadata is BOTH hashed and inserted — hash-form and persisted-form cannot
// diverge (closure rule, projectToV2.ts).

/**
 * Persist a single ledger entry to PostgreSQL with serialized chain linking.
 *
 * CRITICAL: Uses pg_advisory_xact_lock to serialize ALL writers (ace-server
 * and gia-mcp) so the chain is strictly linear with no forks.
 *
 * Flow:
 * 1. BEGIN transaction
 * 2. Acquire advisory lock (blocks other writers)
 * 3. Read current chain head + max chain_index from DB
 * 4. Recompute entry hash using DB's chain head (not in-memory)
 * 5. INSERT with correct linear chain linkage
 * 6. COMMIT (releases lock, next writer proceeds)
 *
 * Fire-and-forget from caller's perspective: errors are logged, never thrown.
 */
/**
 * In-flight persist promises. persistEntry is fire-and-forget (returns void so
 * it never blocks the in-memory ledger), but a short-lived process that exits
 * before these settle DROPS the queued writes — which is how two-phase
 * begin→record flows lost their outcome rows in short invocations (F-5,
 * 2026-07-01). drainPendingWrites() awaits this set so shutdown paths can flush
 * before exit. Bounded by natural write throughput; entries self-remove on settle.
 */
const pendingWrites: Set<Promise<void>> = new Set();

/** Number of writes still in flight (for diagnostics/tests). */
export function pendingWriteCount(): number {
  return pendingWrites.size;
}

/**
 * Await all in-flight persist writes. Call before process exit so fire-and-forget
 * ledger writes are not lost. Resolves even if individual writes rejected (they
 * log their own errors). Safe to call repeatedly.
 */
export async function drainPendingWrites(): Promise<void> {
  // Snapshot: awaiting may let new writes enqueue; loop until quiescent (bounded
  // — nothing enqueues new writes during shutdown once inputs are closed).
  let guard = 0;
  while (pendingWrites.size > 0 && guard < 100) {
    await Promise.allSettled([...pendingWrites]);
    guard++;
  }
}

export function persistEntry(entry: IAuditEntry): void {
  if (!persistenceEnabled || !pool) return;

  // Field-to-column closure: the timestamp COLUMN gets exactly the canonical
  // ISO form the hash attests, so verify-time reconstruction is byte-stable.
  const timestamp = toCanonicalTimestamp(entry.timestamp);

  // Serialized write — ensures strict linear chain. Tracked in pendingWrites so
  // drainPendingWrites() can flush before a process exits (F-5).
  const writePromise = (async () => {
    const client = await pool.connect();
    // Hoisted so the 23505 discriminator in catch can report which
    // chain_index the failed INSERT attempted.
    let attemptedChainIndex: number | null = null;
    try {
      await client.query('BEGIN');

      // PLATFORM CONTEXT PIN — required because the chain-head read below must
      // see the GLOBAL chain head under FORCE RLS. The tenant_isolation policy
      // passes when current_setting('app.current_tenant_id', true) = '' (system
      // context); if this connection inherited a tenant-scoped GUC, the head
      // SELECT would return a tenant-filtered (stale) head, the INSERT would
      // collide on UNIQUE(chain_index) with 23505, and the entry would be
      // silently lost (incident 2026-06-12; mirrors server withTransactionPlatform).
      // SET LOCAL scopes the pin to this transaction only — tenant ATTRIBUTION
      // on the inserted row (tenant_id/actor_tenant_id params) is unchanged.
      await client.query(`SET LOCAL app.current_tenant_id = ''`);

      // Step 2: Acquire advisory lock — serializes ALL chain writers
      await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK_ID]);

      // Step 3: Read current chain head from DB
      const headResult = await client.query(
        'SELECT entry_hash, chain_index FROM forensic_ledger ORDER BY chain_index DESC LIMIT 1'
      );
      const dbPrevHash = headResult.rows.length > 0
        ? headResult.rows[0].entry_hash
        : 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a'; // GENESIS_HASH
      const dbNextIndex = headResult.rows.length > 0
        ? headResult.rows[0].chain_index + 1
        : 0;
      attemptedChainIndex = dbNextIndex;

      // Step 4: Recompute hash using DB's chain head for strict linear linking.
      // Epoch-2 (Ledger Canonical v2): hash the closed v2 projection. The
      // projected metadata is inserted below via JSON.stringify of the SAME
      // object, so the persisted JSONB always equals the hashed form.
      const v2Source = projectAuditEntryToV2(entry);
      const correctedHash = computeEntryHashV2(dbPrevHash, v2Source);

      // Tenant isolation columns. tenant_id is the CANONICAL isolation column
      // (RLS m111 keys on it); actor_tenant_id is provenance only. This writer
      // uses a raw pool.connect() with no GUC set, so the m114 autofill trigger
      // does not fire and tenant_id would otherwise silently fall to its DEFAULT
      // 'default' while actor_tenant_id stayed NULL — divergent and inconsistent.
      // The in-memory ForensicLedger / IAuditEntry carries no tenant identity in
      // this MCP context (no tenant is threaded down to the ledger entry), so we
      // set BOTH columns explicitly to the same value: the acting agent's tenant
      // if one is ever present on the entry's metadata, otherwise 'default'.
      // Setting both consistently is the whole point — they must never diverge.
      const entryTenant =
        (typeof (entry.metadata as Record<string, unknown> | undefined)?.tenantId === 'string'
          ? ((entry.metadata as Record<string, unknown>).tenantId as string)
          : null) || 'default';

      // Step 5: INSERT with correct linear chain linkage
      await client.query(
        `INSERT INTO forensic_ledger (
          id, chain_index, timestamp, operation, layer, mai_level,
          actor, status, parent_id, correlation_id, governance_score, gate_decision,
          metadata, duration, error_code, error_message,
          entry_hash, previous_hash, source_instance, delegated_by,
          tenant_id, actor_tenant_id, algo_epoch
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          entry.id,
          dbNextIndex,
          timestamp, // canonical ISO (see above) — identical to the hashed form
          entry.operation,
          entry.layer,
          entry.maiLevel,
          entry.actor,
          entry.status,
          entry.parentId ?? null,
          entry.correlationId ?? null,
          entry.governanceScore ? JSON.stringify(entry.governanceScore) : null,
          entry.gateDecision ? JSON.stringify(entry.gateDecision) : null,
          // CLOSURE RULE: insert the SAME sanitized object that was hashed.
          JSON.stringify(v2Source.metadata ?? {}),
          entry.duration ?? null,
          entry.errorCode ?? null,
          entry.errorMessage ?? null,
          correctedHash,
          dbPrevHash,
          SOURCE_INSTANCE,
          entry.delegatedBy ?? null,
          entryTenant, // tenant_id — canonical isolation column
          entryTenant, // actor_tenant_id — kept consistent with tenant_id (never NULL while tenant_id='default')
          CHAIN_VERSION_V2, // algo_epoch = 2 — Ledger Canonical v2 row
        ]
      );

      // Step 6: COMMIT — releases advisory lock
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {}); // qa:ignore — ROLLBACK after error: connection released in finally
      // 23505 = unique_violation — DISCRIMINATE by constraint.
      //
      // ⚠ POST-migration-155 (F-5): the PRIMARY KEY is now (chain_index), NOT id.
      // `id` is intentionally NON-UNIQUE — every state transition (STARTED then
      // COMPLETED/FAILED) is its own row sharing the audit id. So an id "dup" is
      // no longer a constraint violation at all; that was the bug that silently
      // swallowed one transition per audit.
      // Benign ⇔ a TRUE content duplicate: same entry_hash (idempotent re-append
      // of the identical entry). Everything else — including a collision on the
      // chain_index PK (now named forensic_ledger_pkey) — is the SILENT-LOSS
      // class (stale head under RLS, incident 2026-06-12): never swallow.
      if (err.code === '23505') {
        const constraint: string | undefined = err.constraint;
        const isBenignDupe =
          typeof constraint === 'string' && constraint.includes('entry_hash');
        if (isBenignDupe) return;
        console.error(
          `[Ledger-Persist] CHAIN-INDEX COLLISION — entry NOT persisted (silent-loss class): operation=${entry.operation} status=${entry.status} attempted chain_index=${attemptedChainIndex ?? 'unknown'} constraint=${constraint ?? 'unknown'}:`,
          err.message
        );
        return;
      }
      console.error('[Ledger-Persist] Serialized write failed:', err.message);
    } finally {
      client.release();
    }
  })().catch((err: any) => {
    console.error('[Ledger-Persist] Connection failed:', err.message);
  });

  // Track the write so shutdown can drain it; self-remove on settle (F-5).
  pendingWrites.add(writePromise);
  void writePromise.finally(() => pendingWrites.delete(writePromise));
}

/**
 * Recover all ledger entries from PostgreSQL, ordered by chain_index.
 * Returns entries in chain order for rebuilding the in-memory ledger.
 */
export async function recoverEntries(): Promise<IAuditEntry[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT * FROM forensic_ledger ORDER BY chain_index ASC`
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: new Date(row.timestamp),
      operation: row.operation,
      layer: row.layer,
      maiLevel: row.mai_level,
      actor: row.actor,
      status: row.status,
      parentId: row.parent_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      governanceScore: row.governance_score ?? undefined,
      gateDecision: row.gate_decision ?? undefined,
      metadata: row.metadata ?? {},
      duration: row.duration ?? undefined,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      entryHash: row.entry_hash,
      previousHash: row.previous_hash,
      chainIndex: row.chain_index,
      algoEpoch: row.algo_epoch ?? 1,
    }));
  } catch (err) {
    console.error('[Ledger-Persist] Recovery failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get the count of persisted entries.
 */
export async function getPersistedCount(): Promise<number> {
  if (!persistenceEnabled || !pool) return 0;
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM forensic_ledger');
    return parseInt(result.rows[0].count, 10);
  } catch {
    return 0;
  }
}

/**
 * Export all ledger entries as JSON — for compliance evidence packages.
 */
export async function exportLedgerJSON(): Promise<object[]> {
  if (!persistenceEnabled || !pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM forensic_ledger ORDER BY chain_index ASC`
    );
    return result.rows;
  } catch (err) {
    console.error('[Ledger-Persist] Export failed:', (err as Error).message);
    return [];
  }
}

/**
 * PERMANENTLY DISABLED (2026-07-01) — logging no-op, kept only so any future
 * caller is loudly visible in logs instead of silently rewriting the ledger.
 *
 * This function used to issue
 *   UPDATE forensic_ledger SET entry_hash=$1, previous_hash=$2 WHERE chain_index=$3
 * on every "drifted" row found during startup recovery. Because the ledger is
 * written by multiple writers with historically different hash preimages,
 * every non-MCP row "drifted" on every restart — so this rewrote other
 * writers' rows, and would have laundered a genuine tamper by recomputing
 * over the edited body and destroying the original hash (the only evidence).
 * See docs/STATE-OF-THE-LEDGER-VERIFIED-2026-06-30.md finding F-2 (HIGH).
 *
 * The forensic ledger is immutable: no UPDATE forensic_ledger. Ever.
 * Do NOT reintroduce a write path here — recovery is read-only by design.
 */
export function updateEntryHashes(chainIndex: number, _entryHash: string, _previousHash: string): void {
  console.error(
    `[Ledger-Persist] BLOCKED: updateEntryHashes(chain_index=${chainIndex}) called — ` +
    'ledger UPDATEs are permanently disabled (read-only recovery, F-2). No write was performed.'
  );
}

/**
 * Check if persistence is active.
 */
export function isPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Gracefully close the ledger persistence pool.
 * Called during server shutdown to avoid connection leaks.
 */
export async function closeLedgerPersistence(): Promise<void> {
  // Flush in-flight fire-and-forget writes BEFORE tearing down the pool, so a
  // graceful shutdown never drops a queued ledger entry (F-5).
  await drainPendingWrites();
  if (pool) {
    try {
      await pool.end();
      console.error('[Ledger-Persist] Pool closed');
    } catch (err) {
      console.error('[Ledger-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}
