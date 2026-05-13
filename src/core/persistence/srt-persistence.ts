/**
 * @module    srt-persistence
 * @layer     GOVERNANCE
 * @mai       M — persistence of SRT incidents is MANDATORY for production
 * @audit     true — SRT incidents are governance artifacts
 * @owner     William J. Storey III / ACE / GIA
 *
 * SRT INCIDENT POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for the in-memory incidents Map.
 * Every state transition (DETECTED, DIAGNOSING, REPAIR_PROPOSED,
 * REPAIR_APPROVED, REPAIR_EXECUTING, REPAIR_COMPLETE, POSTMORTEM_GENERATED)
 * writes here.
 *
 * On startup, active incidents are recovered from the database.
 *
 * Design principles:
 * - Async writes: never block the in-memory operations
 * - Recovery: rebuild incidents Map from PostgreSQL on startup
 * - Upsert: update on conflict for status transitions
 */

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/**
 * Initialize the PostgreSQL connection pool for SRT persistence.
 */
export async function initSRTPersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[SRT-Persist] No DATABASE_URL — running in-memory only');
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
      await client.query(`SELECT 1 FROM srt_incidents_persistent LIMIT 0`);
    } catch {
      // Table doesn't exist — create as fallback
      await client.query(`
        CREATE TABLE IF NOT EXISTS srt_incidents_persistent (
          incident_id TEXT PRIMARY KEY, status VARCHAR(50) NOT NULL,
          severity VARCHAR(20) NOT NULL, finding JSONB, diagnosis JSONB,
          repair_plan JSONB, postmortem JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_srt_persist_status ON srt_incidents_persistent(status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_srt_persist_severity ON srt_incidents_persistent(severity)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_srt_persist_created ON srt_incidents_persistent(created_at)`);
    }
    client.release();

    persistenceEnabled = true;
    console.error('[SRT-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[SRT-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

/**
 * Persist an SRT incident (upsert — update on conflict for status transitions).
 * Fire-and-forget: errors are logged but never block the caller.
 */
export function persistIncident(incident: any): void {
  if (!persistenceEnabled || !pool) return;

  pool.query(
    `INSERT INTO srt_incidents_persistent (
      incident_id, status, severity, finding, diagnosis,
      repair_plan, postmortem, created_at, updated_at, resolved_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (incident_id) DO UPDATE SET
      status = EXCLUDED.status,
      severity = EXCLUDED.severity,
      finding = EXCLUDED.finding,
      diagnosis = EXCLUDED.diagnosis,
      repair_plan = EXCLUDED.repair_plan,
      postmortem = EXCLUDED.postmortem,
      updated_at = EXCLUDED.updated_at,
      resolved_at = EXCLUDED.resolved_at`,
    [
      incident.incidentId,
      incident.status,
      incident.severity,
      incident.finding ? JSON.stringify(incident.finding) : null,
      incident.diagnosis ? JSON.stringify(incident.diagnosis) : null,
      incident.repairPlan ? JSON.stringify(incident.repairPlan) : null,
      incident.postmortem ? JSON.stringify(incident.postmortem) : null,
      incident.createdAt || new Date().toISOString(),
      incident.updatedAt || new Date().toISOString(),
      incident.resolvedAt || null,
    ]
  ).catch((err: any) => {
    if (err.code === '23505') return; // duplicate, safe to ignore
    console.error('[SRT-Persist] Incident write failed:', err.message);
  });
}

/**
 * Recover active SRT incidents from PostgreSQL.
 * Returns raw objects for the caller to reconstruct in-memory SRTIncident objects.
 * Only recovers non-resolved incidents (still actionable).
 */
export async function recoverIncidents(): Promise<any[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT * FROM srt_incidents_persistent
       WHERE status NOT IN ('POSTMORTEM_GENERATED', 'CLOSED')
       ORDER BY created_at ASC`
    );
    console.error(`[SRT-Persist] Recovered ${result.rows.length} active incidents from PostgreSQL`);
    return result.rows.map((row: any) => ({
      incidentId: row.incident_id,
      status: row.status,
      severity: row.severity,
      finding: row.finding || undefined,
      diagnosis: row.diagnosis || undefined,
      repairPlan: row.repair_plan || undefined,
      postmortem: row.postmortem || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      resolvedAt: row.resolved_at ? (row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at) : undefined,
    }));
  } catch (err) {
    console.error('[SRT-Persist] Recovery failed:', (err as Error).message);
    return [];
  }
}

/**
 * Recover ALL incidents (including resolved) for reporting.
 */
export async function recoverAllIncidents(): Promise<any[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT * FROM srt_incidents_persistent ORDER BY created_at ASC`
    );
    return result.rows.map((row: any) => ({
      incidentId: row.incident_id,
      status: row.status,
      severity: row.severity,
      finding: row.finding || undefined,
      diagnosis: row.diagnosis || undefined,
      repairPlan: row.repair_plan || undefined,
      postmortem: row.postmortem || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      resolvedAt: row.resolved_at ? (row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at) : undefined,
    }));
  } catch (err) {
    console.error('[SRT-Persist] Full recovery failed:', (err as Error).message);
    return [];
  }
}

export function isSRTPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Gracefully close the SRT persistence pool.
 * Called during server shutdown to avoid connection leaks.
 */
export async function closeSRTPersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[SRT-Persist] Pool closed');
    } catch (err) {
      console.error('[SRT-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}
