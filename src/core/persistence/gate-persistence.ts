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

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/**
 * Initialize the PostgreSQL connection pool for gate persistence.
 */
export async function initGatePersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[Gate-Persist] No DATABASE_URL — running in-memory only');
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
      // Table doesn't exist — create as fallback
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_status ON gate_approvals_persistent(status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_class ON gate_approvals_persistent(classification)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_gate_persist_requested ON gate_approvals_persistent(requested_at)`);
    }
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

  pool.query(
    `INSERT INTO gate_approvals_persistent (
      gate_id, classification, operation, audit_id,
      requested_at, owner_role, escalation_level
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      pending.gateId,
      pending.classification,
      pending.operation,
      pending.auditId,
      pending.requestedAt instanceof Date ? pending.requestedAt.toISOString() : pending.requestedAt,
      pending.ownerRole,
      pending.escalationLevel,
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
 * Clean up stale pending gates from previous sessions.
 * Called on startup — marks any PENDING gates (from crashed sessions) as TIMED_OUT.
 * Returns the count of stale gates cleaned up.
 */
export async function cleanupStaleGates(): Promise<number> {
  if (!persistenceEnabled || !pool) return 0;

  try {
    const result = await pool.query(
      `UPDATE gate_approvals_persistent SET
        status = 'TIMED_OUT',
        rationale = 'Server restarted — pending gate expired (stale session)',
        resolved_at = NOW()
      WHERE status IS NULL
      RETURNING gate_id`
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
