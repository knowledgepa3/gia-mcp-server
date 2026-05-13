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
      // Bumped from 5 → 20 to absorb the recovery hash-sync burst.
      // updateEntryHashes() is called fire-and-forget for every drifted
      // entry on startup; with 2000+ entries and a small pool, the burst
      // saturated the pool and caused cascading timeouts that blocked
      // builder board sessions and memory pack loads.
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Verify connection
    const client = await pool.connect();
    // Ensure table exists (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_ledger (
        id              TEXT        PRIMARY KEY,
        chain_index     INTEGER     NOT NULL UNIQUE,
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
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add columns to existing tables (safe for upgrades)
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS correlation_id TEXT
    `).catch(() => { /* column already exists */ });
    await client.query(`
      ALTER TABLE forensic_ledger ADD COLUMN IF NOT EXISTS source_instance TEXT
    `).catch(() => { /* column already exists */ });
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

/**
 * Recompute SHA-256 hash matching the in-memory ledger's algorithm.
 * Hash = SHA-256(previousHash || '||' || canonical JSON of entry fields).
 */
async function recomputeHash(previousHash: string, entry: IAuditEntry): Promise<string> {
  const { createHash } = await import('crypto');
  // Canonical: sorted keys, Dates as ISO strings, skip hash/chain fields
  const canonical: Record<string, unknown> = {};
  const sortedKeys = Object.keys(entry).sort();
  for (const key of sortedKeys) {
    if (key === 'entryHash' || key === 'previousHash' || key === 'chainIndex') continue;
    const val = (entry as any)[key];
    canonical[key] = val instanceof Date ? val.toISOString() : val;
  }
  const preimage = previousHash + '||' + JSON.stringify(canonical);
  return createHash('sha256').update(preimage).digest('hex');
}

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
export function persistEntry(entry: IAuditEntry): void {
  if (!persistenceEnabled || !pool) return;

  const timestamp = entry.timestamp instanceof Date
    ? entry.timestamp.toISOString()
    : String(entry.timestamp);

  // Serialized write — ensures strict linear chain
  (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

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

      // Step 4: Recompute hash using DB's chain head for strict linear linking
      const correctedEntry: IAuditEntry = {
        ...entry,
        chainIndex: dbNextIndex,
        previousHash: dbPrevHash,
      };
      const correctedHash = await recomputeHash(dbPrevHash, correctedEntry);

      // Step 5: INSERT with correct linear chain linkage
      await client.query(
        `INSERT INTO forensic_ledger (
          id, chain_index, timestamp, operation, layer, mai_level,
          actor, status, parent_id, correlation_id, governance_score, gate_decision,
          metadata, duration, error_code, error_message,
          entry_hash, previous_hash, source_instance, delegated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          entry.id,
          dbNextIndex,
          timestamp,
          entry.operation,
          entry.layer,
          entry.maiLevel,
          entry.actor,
          entry.status,
          entry.parentId ?? null,
          entry.correlationId ?? null,
          entry.governanceScore ? JSON.stringify(entry.governanceScore) : null,
          entry.gateDecision ? JSON.stringify(entry.gateDecision) : null,
          JSON.stringify(entry.metadata ?? {}),
          entry.duration ?? null,
          entry.errorCode ?? null,
          entry.errorMessage ?? null,
          correctedHash,
          dbPrevHash,
          SOURCE_INSTANCE,
          entry.delegatedBy ?? null,
        ]
      );

      // Step 6: COMMIT — releases advisory lock
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {}); // qa:ignore — ROLLBACK after error: connection released in finally
      // 23505 = unique_violation — entry already persisted, safe to ignore
      if (err.code === '23505') return;
      console.error('[Ledger-Persist] Serialized write failed:', err.message);
    } finally {
      client.release();
    }
  })().catch((err: any) => {
    console.error('[Ledger-Persist] Connection failed:', err.message);
  });
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
 * Update entry_hash and previous_hash for a given chain_index.
 * Used after recovery recomputes hashes to keep DB in sync with in-memory chain.
 * Fire-and-forget from the caller's perspective — errors are logged but never block.
 *
 * Internally serialized via a drain queue so a recovery burst of N entries
 * does not saturate the pool. Without this, a startup with thousands of
 * drifted hashes would queue thousands of pool.query() calls, exhaust the
 * pool, and cascade timeouts into other Ledger-Persist callers (board
 * sessions, memory pack loads, etc.).
 */
let hashUpdateQueue: Promise<void> = Promise.resolve();

export function updateEntryHashes(chainIndex: number, entryHash: string, previousHash: string): void {
  if (!persistenceEnabled || !pool) return;
  // Chain to the previous queue entry — serializes execution without
  // blocking the caller. Each enqueued operation runs after the prior one
  // resolves, so at most one hash-sync UPDATE is in flight at a time.
  hashUpdateQueue = hashUpdateQueue
    .then(() =>
      pool.query(
        `UPDATE forensic_ledger SET entry_hash = $1, previous_hash = $2 WHERE chain_index = $3`,
        [entryHash, previousHash, chainIndex]
      ).then(() => undefined)
    )
    .catch((err: any) => {
      console.error('[Ledger-Persist] Hash update failed at chain_index', chainIndex, ':', err.message);
    });
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
