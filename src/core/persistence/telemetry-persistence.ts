/**
 * @module    telemetry-persistence
 * @layer     GOVERNANCE
 * @mai       M — governance telemetry persistence is MANDATORY for production
 * @audit     true — governance events are compliance evidence
 * @owner     William J. Storey III / ACE / GIA
 *
 * GOVERNANCE TELEMETRY POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for governance events and agent delegations.
 * Replaces ephemeral in-memory governanceEventsStore with durable PostgreSQL.
 *
 * Follows gate-persistence.ts pattern exactly:
 * - Lazy Pool initialization from DATABASE_URL
 * - Fire-and-forget writes (.catch() logs, never blocks)
 * - Graceful fallback when DB unavailable
 * - init/close/isEnabled lifecycle
 *
 * Migration: 035_governance_telemetry.sql
 */

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/** Dropped event counter — compliance visibility for lost writes */
let droppedEventCount = 0;
let droppedDelegationCount = 0;

/** Max metadata size in characters (prevents JSONB bloat) */
const MAX_METADATA_CHARS = 5000;

/**
 * Get counts of events that failed to persist after retry.
 * Non-zero = compliance gap that should appear in reports.
 */
export function getDroppedCounts(): { events: number; delegations: number } {
  return { events: droppedEventCount, delegations: droppedDelegationCount };
}

/**
 * Fire-and-forget write with single retry after 500ms.
 * Logs on both failures, increments drop counter on final failure.
 */
function fireAndForgetQuery(
  sql: string,
  params: any[],
  label: string,
  onDropped: () => void
): void {
  pool.query(sql, params).catch((err: any) => {
    console.error(`[Telemetry-Persist] ${label} write failed (attempt 1):`, err.message);
    // Single retry after 500ms — covers transient connection blips
    setTimeout(() => {
      pool.query(sql, params).catch((err2: any) => {
        console.error(`[Telemetry-Persist] ${label} write failed (attempt 2, dropped):`, err2.message);
        onDropped();
      });
    }, 500);
  });
}

/**
 * Enforce metadata size limit. Truncates oversized metadata with a warning marker.
 */
function sanitizeMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata) return '{}';
  const json = JSON.stringify(metadata);
  if (json.length <= MAX_METADATA_CHARS) return json;
  console.error(`[Telemetry-Persist] Metadata truncated: ${json.length} chars > ${MAX_METADATA_CHARS} limit`);
  return JSON.stringify({ _truncated: true, _originalSize: json.length, _reason: 'exceeded MAX_METADATA_CHARS' });
}

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the PostgreSQL connection pool for telemetry persistence.
 */
export async function initTelemetryPersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[Telemetry-Persist] No DATABASE_URL — running in-memory only');
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
    const client = await pool.connect();
    try {
      await client.query('SELECT 1 FROM governance_events LIMIT 0');
      await client.query('SELECT 1 FROM agent_delegations LIMIT 0');
    } catch {
      // Tables don't exist — create as fallback (matches 035_governance_telemetry.sql exactly)
      await client.query(`
        CREATE TABLE IF NOT EXISTS governance_events (
          id              BIGSERIAL PRIMARY KEY,
          event_type      VARCHAR(50) NOT NULL,
          source_tool     VARCHAR(100),
          source_audit_id TEXT,
          mai_level       VARCHAR(20),
          details         TEXT NOT NULL,
          metadata        JSONB DEFAULT '{}',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // All 6 indexes from migration (5 original + 1 composite for common query pattern)
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_type ON governance_events(event_type)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_created ON governance_events(created_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_source ON governance_events(source_tool)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_mai ON governance_events(mai_level)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_audit_id ON governance_events(source_audit_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_gov_events_type_created ON governance_events(event_type, created_at DESC)');

      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_delegations (
          id                BIGSERIAL PRIMARY KEY,
          parent_agent_id   VARCHAR(100) NOT NULL,
          sub_agent_id      VARCHAR(100) NOT NULL,
          task              TEXT NOT NULL,
          authority_scope   VARCHAR(100) NOT NULL DEFAULT 'read-only',
          policy_pack       VARCHAR(100),
          approval_status   VARCHAR(20) NOT NULL DEFAULT 'pending',
          approval_owner    VARCHAR(100),
          accountable_owner VARCHAR(100),
          disposition       VARCHAR(20),
          drift_flag        BOOLEAN DEFAULT FALSE,
          remediation_link  TEXT,
          parent_audit_id   TEXT,
          sub_audit_id      TEXT,
          metadata          JSONB DEFAULT '{}',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at       TIMESTAMPTZ
        )
      `);
      // All 6 indexes from migration
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_parent ON agent_delegations(parent_agent_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_sub ON agent_delegations(sub_agent_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_status ON agent_delegations(approval_status)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_drift ON agent_delegations(drift_flag) WHERE drift_flag = TRUE');
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_created ON agent_delegations(created_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_delegations_parent_audit ON agent_delegations(parent_audit_id)');
    }
    client.release();

    persistenceEnabled = true;
    console.error('[Telemetry-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[Telemetry-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

export function isTelemetryPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Gracefully close the telemetry persistence pool.
 */
export async function closeTelemetryPersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[Telemetry-Persist] Pool closed');
    } catch (err) {
      console.error('[Telemetry-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// GOVERNANCE EVENT PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

export interface GovernanceEventRecord {
  eventType: string;
  sourceTool?: string;
  sourceAuditId?: string;
  maiLevel?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a governance event. Fire-and-forget.
 */
export function persistGovernanceEvent(event: GovernanceEventRecord): void {
  if (!persistenceEnabled || !pool) return;

  fireAndForgetQuery(
    `INSERT INTO governance_events (event_type, source_tool, source_audit_id, mai_level, details, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.eventType,
      event.sourceTool || null,
      event.sourceAuditId || null,
      event.maiLevel || null,
      event.details,
      sanitizeMetadata(event.metadata),
    ],
    'Event',
    () => { droppedEventCount++; }
  );
}

/**
 * Query governance events with filters. Used by reports.
 */
export async function queryGovernanceEvents(filters: {
  since?: Date;
  eventType?: string;
  sourceTool?: string;
  limit?: number;
}): Promise<GovernanceEventRecord[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters.since) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(filters.since.toISOString());
    }
    if (filters.eventType) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(filters.eventType);
    }
    if (filters.sourceTool) {
      conditions.push(`source_tool = $${paramIdx++}`);
      params.push(filters.sourceTool);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 500;

    const result = await pool.query(
      `SELECT * FROM governance_events ${where} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      [...params, limit]
    );

    return result.rows.map((row: any) => ({
      eventType: row.event_type,
      sourceTool: row.source_tool,
      sourceAuditId: row.source_audit_id,
      maiLevel: row.mai_level,
      details: row.details,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    }));
  } catch (err) {
    console.error('[Telemetry-Persist] Event query failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get governance event counts by type since a given date.
 * Optimized aggregation query for reports.
 */
export async function getGovernanceEventCounts(since?: Date): Promise<Record<string, number>> {
  if (!persistenceEnabled || !pool) return {};

  try {
    const sinceClause = since ? `WHERE created_at >= $1` : '';
    const params = since ? [since.toISOString()] : [];

    const result = await pool.query(
      `SELECT event_type, COUNT(*)::int as count
       FROM governance_events ${sinceClause}
       GROUP BY event_type`,
      params
    );

    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.event_type] = row.count;
    }
    return counts;
  } catch (err) {
    console.error('[Telemetry-Persist] Event count query failed:', (err as Error).message);
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// AGENT DELEGATION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

export interface DelegationRecord {
  parentAgentId: string;
  subAgentId: string;
  task: string;
  authorityScope: string;
  policyPack?: string;
  approvalOwner?: string;
  accountableOwner?: string;
  parentAuditId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a new delegation. Fire-and-forget.
 * Returns void — use queryDelegations to read back.
 */
export function persistDelegation(delegation: DelegationRecord): void {
  if (!persistenceEnabled || !pool) return;

  fireAndForgetQuery(
    `INSERT INTO agent_delegations
       (parent_agent_id, sub_agent_id, task, authority_scope, policy_pack,
        approval_owner, accountable_owner, parent_audit_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      delegation.parentAgentId,
      delegation.subAgentId,
      delegation.task,
      delegation.authorityScope,
      delegation.policyPack || null,
      delegation.approvalOwner || null,
      delegation.accountableOwner || null,
      delegation.parentAuditId || null,
      sanitizeMetadata(delegation.metadata),
    ],
    'Delegation',
    () => { droppedDelegationCount++; }
  );
}

/**
 * Update a delegation's disposition (completed, failed, escalated, recalled).
 * Fire-and-forget.
 */
export function updateDelegationDisposition(
  parentAgentId: string,
  subAgentId: string,
  disposition: string,
  driftFlag: boolean,
  remediationLink?: string,
  subAuditId?: string
): void {
  if (!persistenceEnabled || !pool) return;

  // Use subquery pattern — PostgreSQL doesn't support ORDER BY/LIMIT in UPDATE
  pool.query(
    `UPDATE agent_delegations SET
       disposition = $3,
       drift_flag = $4,
       remediation_link = $5,
       sub_audit_id = $6,
       approval_status = CASE WHEN $3 = 'completed' THEN 'approved' ELSE approval_status END,
       resolved_at = NOW()
     WHERE id = (
       SELECT id FROM agent_delegations
       WHERE parent_agent_id = $1 AND sub_agent_id = $2 AND resolved_at IS NULL
       ORDER BY created_at DESC LIMIT 1
     )`,
    [parentAgentId, subAgentId, disposition, driftFlag, remediationLink || null, subAuditId || null]
  ).catch((err: any) => {
    console.error('[Telemetry-Persist] Delegation update failed:', err.message);
  });
}

/**
 * Get delegation statistics for reporting.
 */
export async function getDelegationStats(since?: Date): Promise<{
  totalDelegations: number;
  activeDelegations: number;
  completedDelegations: number;
  driftCount: number;
  uniqueParentAgents: number;
  uniqueSubAgents: number;
}> {
  if (!persistenceEnabled || !pool) {
    return {
      totalDelegations: 0,
      activeDelegations: 0,
      completedDelegations: 0,
      driftCount: 0,
      uniqueParentAgents: 0,
      uniqueSubAgents: 0,
    };
  }

  try {
    const sinceClause = since ? `WHERE created_at >= $1` : '';
    const params = since ? [since.toISOString()] : [];

    const result = await pool.query(
      `SELECT
         COUNT(*)::int as total,
         COUNT(*) FILTER (WHERE resolved_at IS NULL)::int as active,
         COUNT(*) FILTER (WHERE disposition = 'completed')::int as completed,
         COUNT(*) FILTER (WHERE drift_flag = TRUE)::int as drift_count,
         COUNT(DISTINCT parent_agent_id)::int as unique_parents,
         COUNT(DISTINCT sub_agent_id)::int as unique_subs
       FROM agent_delegations ${sinceClause}`,
      params
    );

    const row = result.rows[0] || {};
    return {
      totalDelegations: row.total || 0,
      activeDelegations: row.active || 0,
      completedDelegations: row.completed || 0,
      driftCount: row.drift_count || 0,
      uniqueParentAgents: row.unique_parents || 0,
      uniqueSubAgents: row.unique_subs || 0,
    };
  } catch (err) {
    console.error('[Telemetry-Persist] Delegation stats query failed:', (err as Error).message);
    return {
      totalDelegations: 0,
      activeDelegations: 0,
      completedDelegations: 0,
      driftCount: 0,
      uniqueParentAgents: 0,
      uniqueSubAgents: 0,
    };
  }
}
