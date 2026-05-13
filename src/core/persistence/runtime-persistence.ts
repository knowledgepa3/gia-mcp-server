/**
 * @module    runtime-persistence
 * @layer     GOVERNANCE
 * @mai       M — runtime accountability is MANDATORY for production
 * @audit     true — runtime sessions are compliance evidence
 * @owner     William J. Storey III / ACE / GIA
 *
 * RUNTIME SESSION POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for runtime sessions — the 4th control surface.
 * Follows telemetry-persistence.ts pattern:
 * - Lazy Pool initialization from DATABASE_URL
 * - Fire-and-forget writes (.catch() logs, never blocks)
 * - Graceful fallback when DB unavailable
 * - init/close/isEnabled lifecycle
 *
 * Migration: 036_runtime_accountability.sql
 */

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/** Dropped session counter — compliance visibility */
let droppedSessionCount = 0;

const MAX_METADATA_CHARS = 5000;

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

export async function initRuntimePersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[Runtime-Persist] No DATABASE_URL — running in-memory only');
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
      await client.query('SELECT 1 FROM runtime_sessions LIMIT 0');
    } catch {
      // Table doesn't exist — create as fallback (matches 036_runtime_accountability.sql)
      await client.query(`
        CREATE TABLE IF NOT EXISTS runtime_sessions (
          id                  BIGSERIAL PRIMARY KEY,
          runtime_id          VARCHAR(100) NOT NULL UNIQUE,
          instance_id         VARCHAR(100) NOT NULL,
          session_type        VARCHAR(30) NOT NULL DEFAULT 'tool_invocation',
          parent_runtime_id   VARCHAR(100),
          workflow_id         VARCHAR(100),
          contract_id         VARCHAR(100),
          run_id              VARCHAR(100),
          agent_id            VARCHAR(100),
          agent_role          VARCHAR(100),
          provider            VARCHAR(50),
          model               VARCHAR(100),
          environment         VARCHAR(20) NOT NULL DEFAULT 'production',
          policy_pack_id      VARCHAR(100),
          policy_pack_version VARCHAR(20),
          config_fingerprint  VARCHAR(64),
          started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at            TIMESTAMPTZ,
          disposition         VARCHAR(30) NOT NULL DEFAULT 'active',
          tools_invoked       TEXT[] DEFAULT '{}',
          tool_count          INT DEFAULT 0,
          mai_level           VARCHAR(20),
          gate_count          INT DEFAULT 0,
          retry_count         INT DEFAULT 0,
          fallback_count      INT DEFAULT 0,
          break_glass_used    BOOLEAN DEFAULT FALSE,
          input_tokens        INT DEFAULT 0,
          output_tokens       INT DEFAULT 0,
          total_tokens        INT DEFAULT 0,
          latency_ms          INT DEFAULT 0,
          estimated_cost_usd  NUMERIC(10,6) DEFAULT 0,
          error_message       TEXT,
          error_code          VARCHAR(50),
          audit_id            TEXT,
          metadata            JSONB DEFAULT '{}',
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_instance ON runtime_sessions(instance_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_parent ON runtime_sessions(parent_runtime_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_workflow ON runtime_sessions(workflow_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_contract ON runtime_sessions(contract_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_agent ON runtime_sessions(agent_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_disposition ON runtime_sessions(disposition)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_started ON runtime_sessions(started_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_env ON runtime_sessions(environment)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_instance_disp ON runtime_sessions(instance_id, disposition)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_runtime_started_disp ON runtime_sessions(started_at DESC, disposition)');
    }
    client.release();

    persistenceEnabled = true;
    console.error('[Runtime-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[Runtime-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

export function isRuntimePersistenceEnabled(): boolean {
  return persistenceEnabled;
}

export async function closeRuntimePersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[Runtime-Persist] Pool closed');
    } catch (err) {
      console.error('[Runtime-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}

export function getDroppedSessionCount(): number {
  return droppedSessionCount;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function fireAndForget(sql: string, params: any[], label: string): void {
  pool.query(sql, params).catch((err: any) => {
    console.error(`[Runtime-Persist] ${label} failed (attempt 1):`, err.message);
    setTimeout(() => {
      pool.query(sql, params).catch((err2: any) => {
        console.error(`[Runtime-Persist] ${label} failed (attempt 2, dropped):`, err2.message);
        droppedSessionCount++;
      });
    }, 500);
  });
}

function sanitizeMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata) return '{}';
  const json = JSON.stringify(metadata);
  if (json.length <= MAX_METADATA_CHARS) return json;
  return JSON.stringify({ _truncated: true, _originalSize: json.length });
}

// ═══════════════════════════════════════════════════════════════════
// RUNTIME SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

export interface RuntimeSessionRecord {
  runtimeId: string;
  instanceId: string;
  sessionType?: string;
  parentRuntimeId?: string;
  workflowId?: string;
  contractId?: string;
  runId?: string;
  agentId?: string;
  agentRole?: string;
  provider?: string;
  model?: string;
  environment?: string;
  policyPackId?: string;
  policyPackVersion?: string;
  configFingerprint?: string;
  maiLevel?: string;
  auditId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSessionUpdate {
  disposition: string;
  toolsInvoked?: string[];
  toolCount?: number;
  gateCount?: number;
  retryCount?: number;
  fallbackCount?: number;
  breakGlassUsed?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  estimatedCostUsd?: number;
  errorMessage?: string;
  errorCode?: string;
  maiLevel?: string;
}

/**
 * Persist a new runtime session start. Fire-and-forget.
 */
export function persistRuntimeSession(session: RuntimeSessionRecord): void {
  if (!persistenceEnabled || !pool) return;

  fireAndForget(
    `INSERT INTO runtime_sessions
       (runtime_id, instance_id, session_type, parent_runtime_id, workflow_id,
        contract_id, run_id, agent_id, agent_role, provider, model,
        environment, policy_pack_id, policy_pack_version, config_fingerprint,
        mai_level, audit_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      session.runtimeId,
      session.instanceId,
      session.sessionType || 'tool_invocation',
      session.parentRuntimeId || null,
      session.workflowId || null,
      session.contractId || null,
      session.runId || null,
      session.agentId || null,
      session.agentRole || null,
      session.provider || null,
      session.model || null,
      session.environment || 'production',
      session.policyPackId || null,
      session.policyPackVersion || null,
      session.configFingerprint || null,
      session.maiLevel || null,
      session.auditId || null,
      sanitizeMetadata(session.metadata),
    ],
    'Session start'
  );
}

/**
 * Update a runtime session on completion. Fire-and-forget.
 */
export function updateRuntimeSession(runtimeId: string, update: RuntimeSessionUpdate): void {
  if (!persistenceEnabled || !pool) return;

  fireAndForget(
    `UPDATE runtime_sessions SET
       disposition = $2,
       ended_at = NOW(),
       tools_invoked = $3,
       tool_count = $4,
       gate_count = $5,
       retry_count = $6,
       fallback_count = $7,
       break_glass_used = $8,
       input_tokens = $9,
       output_tokens = $10,
       total_tokens = $11,
       latency_ms = $12,
       estimated_cost_usd = $13,
       error_message = $14,
       error_code = $15,
       mai_level = COALESCE($16, mai_level)
     WHERE runtime_id = $1`,
    [
      runtimeId,
      update.disposition,
      update.toolsInvoked || [],
      update.toolCount || 0,
      update.gateCount || 0,
      update.retryCount || 0,
      update.fallbackCount || 0,
      update.breakGlassUsed || false,
      update.inputTokens || 0,
      update.outputTokens || 0,
      update.totalTokens || 0,
      update.latencyMs || 0,
      update.estimatedCostUsd || 0,
      update.errorMessage || null,
      update.errorCode || null,
      update.maiLevel || null,
    ],
    'Session update'
  );
}

// ═══════════════════════════════════════════════════════════════════
// RUNTIME QUERIES — for reports and system-status
// ═══════════════════════════════════════════════════════════════════

export interface RuntimeStats {
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  failedSessions: number;
  escalatedSessions: number;
  avgLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  uniqueAgents: number;
  uniqueProviders: number;
  uniqueModels: number;
  breakGlassCount: number;
  retryTotal: number;
  fallbackTotal: number;
  dispositionBreakdown: Record<string, number>;
  environmentBreakdown: Record<string, number>;
  providerBreakdown: Record<string, number>;
}

export async function getRuntimeStats(since?: Date): Promise<RuntimeStats> {
  const empty: RuntimeStats = {
    totalSessions: 0, activeSessions: 0, completedSessions: 0,
    failedSessions: 0, escalatedSessions: 0, avgLatencyMs: 0,
    totalTokens: 0, totalCostUsd: 0, uniqueAgents: 0,
    uniqueProviders: 0, uniqueModels: 0, breakGlassCount: 0,
    retryTotal: 0, fallbackTotal: 0,
    dispositionBreakdown: {}, environmentBreakdown: {}, providerBreakdown: {},
  };

  if (!persistenceEnabled || !pool) return empty;

  try {
    const sinceClause = since ? `WHERE started_at >= $1` : '';
    const params = since ? [since.toISOString()] : [];

    const result = await pool.query(
      `SELECT
         COUNT(*)::int as total,
         COUNT(*) FILTER (WHERE disposition = 'active')::int as active,
         COUNT(*) FILTER (WHERE disposition = 'completed')::int as completed,
         COUNT(*) FILTER (WHERE disposition = 'failed')::int as failed,
         COUNT(*) FILTER (WHERE disposition = 'escalated')::int as escalated,
         COALESCE(AVG(latency_ms) FILTER (WHERE disposition != 'active'), 0)::int as avg_latency,
         COALESCE(SUM(total_tokens), 0)::int as sum_tokens,
         COALESCE(SUM(estimated_cost_usd), 0)::numeric as sum_cost,
         COUNT(DISTINCT agent_id)::int as unique_agents,
         COUNT(DISTINCT provider)::int as unique_providers,
         COUNT(DISTINCT model)::int as unique_models,
         COUNT(*) FILTER (WHERE break_glass_used = TRUE)::int as break_glass,
         COALESCE(SUM(retry_count), 0)::int as sum_retries,
         COALESCE(SUM(fallback_count), 0)::int as sum_fallbacks
       FROM runtime_sessions ${sinceClause}`,
      params
    );

    const row = result.rows[0] || {};

    // Disposition breakdown
    const dispResult = await pool.query(
      `SELECT disposition, COUNT(*)::int as count FROM runtime_sessions ${sinceClause} GROUP BY disposition`,
      params
    );
    const dispositionBreakdown: Record<string, number> = {};
    for (const r of dispResult.rows) {
      dispositionBreakdown[r.disposition] = r.count;
    }

    // Environment breakdown
    const envResult = await pool.query(
      `SELECT environment, COUNT(*)::int as count FROM runtime_sessions ${sinceClause} GROUP BY environment`,
      params
    );
    const environmentBreakdown: Record<string, number> = {};
    for (const r of envResult.rows) {
      environmentBreakdown[r.environment] = r.count;
    }

    // Provider breakdown
    const provResult = await pool.query(
      `SELECT COALESCE(provider, 'unknown') as provider, COUNT(*)::int as count FROM runtime_sessions ${sinceClause} GROUP BY provider`,
      params
    );
    const providerBreakdown: Record<string, number> = {};
    for (const r of provResult.rows) {
      providerBreakdown[r.provider] = r.count;
    }

    return {
      totalSessions: row.total || 0,
      activeSessions: row.active || 0,
      completedSessions: row.completed || 0,
      failedSessions: row.failed || 0,
      escalatedSessions: row.escalated || 0,
      avgLatencyMs: row.avg_latency || 0,
      totalTokens: row.sum_tokens || 0,
      totalCostUsd: parseFloat(row.sum_cost) || 0,
      uniqueAgents: row.unique_agents || 0,
      uniqueProviders: row.unique_providers || 0,
      uniqueModels: row.unique_models || 0,
      breakGlassCount: row.break_glass || 0,
      retryTotal: row.sum_retries || 0,
      fallbackTotal: row.sum_fallbacks || 0,
      dispositionBreakdown,
      environmentBreakdown,
      providerBreakdown,
    };
  } catch (err) {
    console.error('[Runtime-Persist] Stats query failed:', (err as Error).message);
    return empty;
  }
}

/**
 * Get active (unresolved) runtime sessions for a given instance.
 */
export async function getActiveSessions(instanceId: string): Promise<number> {
  if (!persistenceEnabled || !pool) return 0;
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int as count FROM runtime_sessions WHERE instance_id = $1 AND disposition = 'active'`,
      [instanceId]
    );
    return result.rows[0]?.count || 0;
  } catch {
    return 0;
  }
}
