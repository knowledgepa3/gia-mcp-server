/**
 * @module    gate-persistence
 * @layer     GOVERNANCE
 * @mai       M — persistence of gate approvals is MANDATORY for production
 * @audit     true — gate decisions are governance artifacts
 * @owner     William J. Storey III / ACE / GIA
 *
 * MAI GATE APPROVAL POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for MAI gate approval decisions.
 * Every gate request and resolution is recorded here.
 *
 * IMPORTANT: The in-memory pendingApprovals Map holds Promise resolve/reject
 * callbacks that CANNOT be serialized or recovered. If the server restarts,
 * pending gates are lost (Promises are dead). This persistence layer:
 *
 * 1. Records gate requests when they enter PENDING state
 * 2. Records resolutions (APPROVED, REJECTED, TIMED_OUT)
 * 3. On recovery, marks stale PENDING gates as TIMED_OUT
 *    (the original Promise is gone — the operation that requested it has crashed)
 *
 * Design principles:
 * - Async writes: never block gate enforcement
 * - Audit trail: every gate lifecycle event persisted
 * - Stale detection: pending gates from crashed sessions are cleaned up
 */

import { bootNotice } from '../../shared/bootNotice.js';

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/**
 * Initialize the PostgreSQL connection pool for gate persistence.
 */
export async function initGatePersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    bootNotice('[Gate-Persist] No DATABASE_URL — running in-memory only');
    return false;
  }

  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Verify connection + table existence
    // Table is created by migration 029_srt_gate_persistence.sql
    const client = await pool.connect();
    try {
      await client.query(`SELECT 1 FROM gate_approvals_persistent LIMIT 0`);
    } catch {
      // Table doesn't exist — create as fallback (tenant_id matches migration 140)
      await client.query(`
        CREATE TABLE IF NOT EXISTS gate_approvals_persistent (
          gate_id TEXT PRIMARY KEY, classification VARCHAR(20) NOT NULL,
          operation TEXT NOT NULL, audit_id TEXT,
          requested_at TIMESTAMPTZ NOT NULL,
          owner_role VARCHAR(100) NOT NULL DEFAULT 'isso',
          escalation_level INTEGER NOT NULL DEFAULT 0,
          status VARCHAR(20), approved_by VARCHAR(255),
          rationale TEXT, decision JSONB,
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          tenant_id TEXT NOT NULL DEFAULT 'default'
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_status ON gate_approvals_persistent(status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_class ON gate_approvals_persistent(classification)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_requested ON gate_approvals_persistent(requested_at)`);
    }
    // Pre-140 fallback tables lack tenant_id — idempotent add so the stamped
    // INSERT (task #21) can't fail against an older sandbox table.
    await client.query(`ALTER TABLE gate_approvals_persistent ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
    client.release();

    persistenceEnabled = true;
    console.error('[Gate-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[Gate-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

/**
 * Persist a new pending gate request.
 * Fire-and-forget: errors are logged but never block gate enforcement.
 */
export function persistGateRequest(pending: {
  gateId: string;
  classification: string;
  operation: string;
  auditId: string;
  requestedAt: Date;
  ownerRole: string;
  escalationLevel: number;
}): void {
  if (!persistenceEnabled || !pool) return;

  // Tenant stamping (task #21, recon 2026-07-10): without an explicit
  // tenant_id the column defaults 'default' and every kernel-created
  // MANDATORY gate is invisible to real-tenant consoles (RLS) — actionable
  // only via the platform-owner safety-net view. PLATFORM_TENANT_ID follows
  // the telemetry-persistence precedent: env PLATFORM_PRIMARY_TENANT_ID,
  // falling back to 'default' when unset (unchanged behavior until the env
  // decision is made — see gate-notification-console-bugs memory).
  const tenantId = process.env.PLATFORM_PRIMARY_TENANT_ID || 'default';

  pool.query(
    `INSERT INTO gate_approvals_persistent (
      gate_id, classification, operation, audit_id,
      requested_at, owner_role, escalation_level, tenant_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      pending.gateId,
      pending.classification,
      pending.operation,
      pending.auditId,
      pending.requestedAt instanceof Date ? pending.requestedAt.toISOString() : pending.requestedAt,
      pending.ownerRole,
      pending.escalationLevel,
      tenantId,
    ]
  ).catch((err: any) => {
    if (err.code === '23505') return; // duplicate, safe to ignore
    console.error('[Gate-Persist] Gate request write failed:', err.message);
  });
}

/**
 * Persist a gate resolution (APPROVED, REJECTED, TIMED_OUT, BREAK_GLASS).
 * Fire-and-forget: errors are logged but never block resolution.
 */
export function persistGateResolution(resolution: {
  gateId: string;
  status: string;
  approvedBy: string;
  rationale: string;
  decision?: any;
}): void {
  if (!persistenceEnabled || !pool) return;

  pool.query(
    `UPDATE gate_approvals_persistent SET
      status = $2,
      approved_by = $3,
      rationale = $4,
      decision = $5,
      resolved_at = NOW()
    WHERE gate_id = $1`,
    [
      resolution.gateId,
      resolution.status,
      resolution.approvedBy,
      resolution.rationale,
      resolution.decision ? JSON.stringify(resolution.decision) : null,
    ]
  ).catch((err: any) => {
    console.error('[Gate-Persist] Gate resolution write failed:', err.message);
  });
}

/**
 * Guards cleanupStaleGates() so its DB mutation fires at most ONCE per
 * process lifetime.
 *
 * ROOT CAUSE FIX (2026-07-17 live incident): cleanupStaleGates() runs inside
 * every GovernanceEngine.initialize() call, and a single running gia-mcp
 * process legitimately builds MULTIPLE concurrent engines — one dashboard
 * engine plus one per tenant on /mcp and one per tenant on /mcp/agent (see
 * server-http.ts). Each is a genuinely separate in-memory pendingApprovals
 * Map. Without this guard, every engine construction AFTER the first sees
 * any gate not in ITS OWN empty map as "orphaned by a crashed session" and
 * force-times it out — even when the gate is alive and actively held by a
 * SIBLING engine in the SAME process. Observed live: 140 fresh engine
 * constructions in one 22-minute window (a customer's multi-agent
 * orchestration triggering /mcp tenant-session reconnect churn), one of
 * which reaped a MANDATORY gate ~2 minutes after it was requested — before
 * any human had a chance to approve it.
 *
 * Real orphan cleanup (gates truly abandoned by a PREVIOUS process that
 * crashed) still runs exactly once, on this process's first engine
 * construction. The guard lives in process memory, not the DB, so it resets
 * naturally on every genuine restart.
 */
let staleGatesCleanedThisProcess = false;

/**
 * MINIMUM AGE BEFORE A PENDING GATE MAY BE REAPED.
 *
 * 🔴 THE INCIDENT THIS EXISTS FOR (2026-07-26, live, William's own run).
 * Gate `gate-37a017d5-…` (MANDATORY, raised by `classify_decision`) was created
 * at 15:17:51.642 and force-resolved `TIMED_OUT` at 15:17:57.217 — **5.6
 * seconds later** — with the rationale "Server restarted". The `gia-mcp-http`
 * container HAD restarted, 0.7s after the gate row was written, and this
 * cleanup ran on that boot. So the process reaped the gate it had itself just
 * created, and managed run `9d8b6b23` was stranded `paused_at_gate` forever
 * with nothing left to approve. **A MANDATORY gate resolved itself without a
 * human. That is a governance-claim failure, not a UX bug.**
 *
 * The 2026-07-17 fix (`392a977e`, `staleGatesCleanedThisProcess`) closed the
 * SIBLING-ENGINE case — 140 engine constructions in one process reaping each
 * other's gates. It cannot close this one by design: the guard lives in process
 * memory precisely so it "resets naturally on every genuine restart", and this
 * WAS a genuine restart. The missing predicate was never the guard — it was
 * that the query had **no age floor at all** and would take a gate born one
 * second ago.
 *
 * Why 15 minutes: it is the longest window in which a pending gate is still
 * legitimately actionable anywhere in the platform — the pre-tool hook polls
 * for 900s, and the workspace consume path requires an approval no older than
 * 15 minutes. A gate younger than that has not yet had its chance, so calling
 * it "abandoned by a previous session" is a false statement about the world.
 * Older than that with no decision recorded, and the claim is defensible.
 *
 * FAILING TOWARD "STILL APPROVABLE" IS THE CORRECT DIRECTION HERE. A gate left
 * PENDING can still be approved by a human and its run resumed; a gate marked
 * TIMED_OUT is unrecoverable. When in doubt a governance chokepoint should
 * preserve the human's ability to decide, not consume it.
 */
const STALE_GATE_MIN_AGE_MINUTES = 15;

/**
 * Clean up stale pending gates from previous sessions.
 * Called on startup — marks long-abandoned PENDING gates as TIMED_OUT.
 * Gates younger than STALE_GATE_MIN_AGE_MINUTES are left alone (see above).
 * Returns the count of stale gates cleaned up.
 */
export async function cleanupStaleGates(): Promise<number> {
  if (!persistenceEnabled || !pool) return 0;
  if (staleGatesCleanedThisProcess) return 0;
  // Set synchronously, before any await, so concurrent callers (orchestrator
  // + workers all connecting at once) can't race past this check together.
  staleGatesCleanedThisProcess = true;

  try {
    const result = await pool.query(
      `UPDATE gate_approvals_persistent SET
        status = 'TIMED_OUT',
        rationale = $1,
        resolved_at = NOW()
      WHERE status IS NULL
        AND created_at < NOW() - ($2 || ' minutes')::interval
      RETURNING gate_id`,
      [
        // The old text asserted "Server restarted" as fact. This cleanup does
        // not verify that a restart occurred and cannot — it only knows it is
        // booting. It writes what it actually observed: no decision inside the
        // approval window. An audit record must not state a cause it did not check.
        `No decision recorded within the ${STALE_GATE_MIN_AGE_MINUTES}-minute approval window (session ended)`,
        String(STALE_GATE_MIN_AGE_MINUTES),
      ]
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      console.error(`[Gate-Persist] Cleaned up ${count} stale pending gate(s) from previous session`);
    }
    return count;
  } catch (err) {
    console.error('[Gate-Persist] Stale gate cleanup failed:', (err as Error).message);
    return 0;
  }
}

/**
 * Get recent gate decisions for reporting.
 */
export async function getRecentGateDecisions(limit: number = 50): Promise<any[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT * FROM gate_approvals_persistent
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row: any) => ({
      gateId: row.gate_id,
      classification: row.classification,
      operation: row.operation,
      auditId: row.audit_id,
      requestedAt: row.requested_at,
      ownerRole: row.owner_role,
      escalationLevel: row.escalation_level,
      status: row.status || 'PENDING',
      approvedBy: row.approved_by || undefined,
      rationale: row.rationale || undefined,
      decision: row.decision || undefined,
      resolvedAt: row.resolved_at || undefined,
    }));
  } catch (err) {
    console.error('[Gate-Persist] Query failed:', (err as Error).message);
    return [];
  }
}

export function isGatePersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Look up a single gate record from the DB by gate ID.
 * Used by board_approve_gate to explain why an in-memory gate is missing
 * (e.g., MCP server restarted and stale gates were marked TIMED_OUT).
 */
export async function getGateDbRecord(gateId: string): Promise<{
  gateId: string;
  classification: string;
  operation: string;
  status: string;
  approvedBy?: string;
  rationale?: string;
  requestedAt: Date;
  resolvedAt?: Date;
} | null> {
  if (!persistenceEnabled || !pool) return null;

  try {
    const result = await pool.query(
      `SELECT gate_id, classification, operation, status, approved_by, rationale, requested_at, resolved_at
       FROM gate_approvals_persistent WHERE gate_id = $1 LIMIT 1`,
      [gateId]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      gateId: row.gate_id,
      classification: row.classification,
      operation: row.operation,
      status: row.status || 'PENDING',
      approvedBy: row.approved_by || undefined,
      rationale: row.rationale || undefined,
      requestedAt: row.requested_at,
      resolvedAt: row.resolved_at || undefined,
    };
  } catch (err) {
    console.error('[Gate-Persist] Gate lookup failed:', (err as Error).message);
    return null;
  }
}

/**
 * Check if a specific gate has been resolved remotely (via mobile approval,
 * ntfy action button, or GIA console). Returns the decision if found, null otherwise.
 *
 * Used by the MCP gate polling loop to bridge remote approvals back to
 * the in-memory Promise that's blocking the pipeline.
 */
export async function checkRemoteGateResolution(gateId: string): Promise<{
  status: string;
  approvedBy: string;
  rationale: string;
} | null> {
  if (!persistenceEnabled || !pool) return null;

  try {
    const result = await pool.query(
      `SELECT status, approved_by, rationale
       FROM gate_approvals_persistent
       WHERE gate_id = $1 AND status IS NOT NULL`,
      [gateId]
    );
    if (result.rows.length > 0) {
      return {
        status: result.rows[0].status,
        approvedBy: result.rows[0].approved_by || 'remote',
        rationale: result.rows[0].rationale || 'Resolved via remote channel',
      };
    }
    return null;
  } catch (err) {
    console.error('[Gate-Persist] Remote resolution check failed:', (err as Error).message);
    return null;
  }
}

/**
 * Read advisory_timeout_ms from the mai_calibration table.
 * Falls back to the provided default (or 60s) on any failure so Advisory
 * gates always fire even if the DB read fails.
 */
export async function getAdvisoryTimeoutMs(fallbackMs: number = 60_000): Promise<number> {
  if (!persistenceEnabled || !pool) return fallbackMs;
  try {
    const result = await pool.query(
      `SELECT value FROM mai_calibration WHERE key = 'advisory_timeout_ms' LIMIT 1`
    );
    if (result.rows.length > 0) {
      const parsed = parseInt(result.rows[0].value, 10);
      if (!isNaN(parsed) && parsed >= 30_000 && parsed <= 300_000) return parsed;
    }
    return fallbackMs;
  } catch {
    return fallbackMs;
  }
}

/**
 * Gracefully close the gate persistence pool.
 * Called during server shutdown to avoid connection leaks.
 */
export async function closeGatePersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[Gate-Persist] Pool closed');
    } catch (err) {
      console.error('[Gate-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}
