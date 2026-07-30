/**
 * @module    intelligence-persistence
 * @layer     GOVERNANCE
 * @mai       I — read-only intelligence data, INFORMATIONAL
 * @audit     false — reads only, no mutations
 * @owner     William J. Storey III / ACE / GIA
 *
 * INTELLIGENCE DATA POSTGRESQL READER
 *
 * Read-only persistence layer that queries phoenix_records and
 * cerebro_signals tables written by the ACE Governance API server.
 *
 * This closes the intelligence loop: the Express API writes Phoenix
 * records and Cerebro signals as agents execute, and the GIA MCP
 * server reads them to surface in governance tools (system_status,
 * generate_report, monitor_agents).
 *
 * Design principles:
 * - Read-only: MCP server NEVER writes to these tables
 * - Async: never blocks governance operations
 * - Graceful degradation: returns empty data if DB unavailable
 * - Same DATABASE_URL as other persistence modules (same PostgreSQL)
 */

import { bootNotice } from '../../shared/bootNotice.js';

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhoenixRecordSummary {
  runId: string;
  caseId: string | null;
  workforceType: string | null;
  parentRunId: string | null;
  lineageDepth: number;
  completedAt: string | null;
  finalStatus: string;
  gatePatterns: string[];
  effectiveDirectives: string[];
  humanCorrections: string[];
  agentSequence: string[];
  tokenEfficiency: number;
  createdAt: string;
}

export interface CerebroSignalSummary {
  signalId: string;
  timestamp: string;
  confidence: number;
  severity: string;
  signalType: string;
  title: string;
  description: string;
  correlatedSources: string[];
  suggestedAction: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface IntelligenceStats {
  phoenix: {
    totalRecords: number;
    last24hRecords: number;
    successCount: number;
    failureCount: number;
    avgTokenEfficiency: number;
    workforceBreakdown: Record<string, number>;
    topGatePatterns: string[];
  };
  cerebro: {
    totalSignals: number;
    last24hSignals: number;
    lastHourSignals: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    typeBreakdown: Record<string, number>;
    avgConfidence: number;
  };
  persistenceEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Init / Shutdown
// ---------------------------------------------------------------------------

/**
 * Initialize the PostgreSQL connection pool for intelligence data reading.
 * Tables must already exist (created by migration 031_intelligence_persistence.sql
 * on the ACE Governance API server).
 */
export async function initIntelligencePersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    bootNotice('[Intel-Persist] No DATABASE_URL — intelligence data unavailable');
    return false;
  }

  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,              // Read-only, low concurrency
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Verify connection + table existence
    const client = await pool.connect();
    try {
      await client.query('SELECT 1 FROM phoenix_records LIMIT 0');
      await client.query('SELECT 1 FROM cerebro_signals LIMIT 0');
    } catch {
      // Tables don't exist yet — migration hasn't run on this database
      // Non-fatal: we'll return empty data until tables are created
      console.error('[Intel-Persist] Tables not found — intelligence data unavailable until migration 031 runs');
      client.release();
      persistenceEnabled = true; // Pool works, just no tables yet
      return true;
    }
    client.release();

    persistenceEnabled = true;
    console.error('[Intel-Persist] PostgreSQL intelligence reader initialized');
    return true;
  } catch (err) {
    console.error('[Intel-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

export function isIntelligencePersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/** Returns a diagnostic reason string for why persistence is in its current state. */
export function getIntelligencePersistenceReason(): string {
  if (persistenceEnabled) return 'Active — PostgreSQL intelligence reader connected';
  if (!process.env.DATABASE_URL) return 'Disabled — DATABASE_URL environment variable not set';
  return 'Disabled — connection failed during initialization';
}

export async function closeIntelligencePersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[Intel-Persist] Pool closed');
    } catch (err) {
      console.error('[Intel-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}

// ---------------------------------------------------------------------------
// Phoenix Records — Read
// ---------------------------------------------------------------------------

/**
 * Get recent Phoenix records (newest first).
 */
export async function getRecentPhoenixRecords(limit: number = 50): Promise<PhoenixRecordSummary[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT run_id, case_id, workforce_type, parent_run_id, lineage_depth,
              completed_at, final_status, gate_patterns, effective_directives,
              human_corrections, agent_sequence, token_efficiency, created_at
       FROM phoenix_records
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapPhoenixRow);
  } catch (err) {
    console.error('[Intel-Persist] Phoenix read failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get Phoenix records by case ID (for lineage analysis).
 */
export async function getPhoenixRecordsByCase(caseId: string): Promise<PhoenixRecordSummary[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT run_id, case_id, workforce_type, parent_run_id, lineage_depth,
              completed_at, final_status, gate_patterns, effective_directives,
              human_corrections, agent_sequence, token_efficiency, created_at
       FROM phoenix_records
       WHERE case_id = $1
       ORDER BY lineage_depth ASC, created_at ASC`,
      [caseId]
    );
    return result.rows.map(mapPhoenixRow);
  } catch (err) {
    console.error('[Intel-Persist] Phoenix case query failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get Phoenix aggregate stats for governance reporting.
 */
export async function getPhoenixStats(): Promise<IntelligenceStats['phoenix']> {
  const empty: IntelligenceStats['phoenix'] = {
    totalRecords: 0,
    last24hRecords: 0,
    successCount: 0,
    failureCount: 0,
    avgTokenEfficiency: 0,
    workforceBreakdown: {},
    topGatePatterns: [],
  };

  if (!persistenceEnabled || !pool) return empty;

  try {
    // Aggregate stats in a single query
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_records,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h_records,
        COUNT(*) FILTER (WHERE final_status IN ('completed', 'success'))::int AS success_count,
        COUNT(*) FILTER (WHERE final_status IN ('failed', 'error', 'blocked'))::int AS failure_count,
        COALESCE(AVG(token_efficiency), 0)::real AS avg_token_efficiency
      FROM phoenix_records
    `);

    const row = result.rows[0] || {};

    // Workforce breakdown
    const workforceResult = await pool.query(`
      SELECT workforce_type, COUNT(*)::int AS count
      FROM phoenix_records
      WHERE workforce_type IS NOT NULL
      GROUP BY workforce_type
      ORDER BY count DESC
    `);
    const workforceBreakdown: Record<string, number> = {};
    for (const wr of workforceResult.rows) {
      workforceBreakdown[wr.workforce_type] = wr.count;
    }

    // Top gate patterns (flatten JSONB arrays, count occurrences)
    const patternResult = await pool.query(`
      SELECT pattern, COUNT(*)::int AS count
      FROM phoenix_records, jsonb_array_elements_text(gate_patterns) AS pattern
      GROUP BY pattern
      ORDER BY count DESC
      LIMIT 10
    `);
    const topGatePatterns = patternResult.rows.map((r: any) => `${r.pattern} (${r.count})`);

    return {
      totalRecords: row.total_records || 0,
      last24hRecords: row.last_24h_records || 0,
      successCount: row.success_count || 0,
      failureCount: row.failure_count || 0,
      avgTokenEfficiency: Math.round((row.avg_token_efficiency || 0) * 100) / 100,
      workforceBreakdown,
      topGatePatterns,
    };
  } catch (err) {
    console.error('[Intel-Persist] Phoenix stats query failed:', (err as Error).message);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Cerebro Signals — Read
// ---------------------------------------------------------------------------

/**
 * Get recent Cerebro signals (newest first).
 */
export async function getRecentCerebroSignals(limit: number = 50): Promise<CerebroSignalSummary[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT signal_id, timestamp, confidence, severity, signal_type,
              title, description, correlated_sources, suggested_action,
              metadata, created_at
       FROM cerebro_signals
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapCerebroRow);
  } catch (err) {
    console.error('[Intel-Persist] Cerebro read failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get Cerebro signals by severity (for targeted analysis).
 */
export async function getCerebroSignalsBySeverity(
  severity: string,
  limit: number = 50
): Promise<CerebroSignalSummary[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT signal_id, timestamp, confidence, severity, signal_type,
              title, description, correlated_sources, suggested_action,
              metadata, created_at
       FROM cerebro_signals
       WHERE severity = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [severity, limit]
    );
    return result.rows.map(mapCerebroRow);
  } catch (err) {
    console.error('[Intel-Persist] Cerebro severity query failed:', (err as Error).message);
    return [];
  }
}

/**
 * Get Cerebro aggregate stats for governance reporting.
 */
export async function getCerebroStats(): Promise<IntelligenceStats['cerebro']> {
  const empty: IntelligenceStats['cerebro'] = {
    totalSignals: 0,
    last24hSignals: 0,
    lastHourSignals: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    typeBreakdown: {},
    avgConfidence: 0,
  };

  if (!persistenceEnabled || !pool) return empty;

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_signals,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h_signals,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour_signals,
        COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical_count,
        COUNT(*) FILTER (WHERE severity = 'high')::int AS high_count,
        COUNT(*) FILTER (WHERE severity = 'medium')::int AS medium_count,
        COUNT(*) FILTER (WHERE severity = 'low')::int AS low_count,
        COALESCE(AVG(confidence), 0)::real AS avg_confidence
      FROM cerebro_signals
    `);

    const row = result.rows[0] || {};

    // Type breakdown
    const typeResult = await pool.query(`
      SELECT signal_type, COUNT(*)::int AS count
      FROM cerebro_signals
      GROUP BY signal_type
      ORDER BY count DESC
    `);
    const typeBreakdown: Record<string, number> = {};
    for (const tr of typeResult.rows) {
      typeBreakdown[tr.signal_type] = tr.count;
    }

    return {
      totalSignals: row.total_signals || 0,
      last24hSignals: row.last_24h_signals || 0,
      lastHourSignals: row.last_hour_signals || 0,
      criticalCount: row.critical_count || 0,
      highCount: row.high_count || 0,
      mediumCount: row.medium_count || 0,
      lowCount: row.low_count || 0,
      typeBreakdown,
      avgConfidence: Math.round((row.avg_confidence || 0) * 100) / 100,
    };
  } catch (err) {
    console.error('[Intel-Persist] Cerebro stats query failed:', (err as Error).message);
    return empty;
  }
}

/**
 * Get full intelligence stats (Phoenix + Cerebro combined).
 */
export async function getIntelligenceStats(): Promise<IntelligenceStats> {
  const [phoenix, cerebro] = await Promise.all([
    getPhoenixStats(),
    getCerebroStats(),
  ]);

  return {
    phoenix,
    cerebro,
    persistenceEnabled,
  };
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapPhoenixRow(row: any): PhoenixRecordSummary {
  return {
    runId: row.run_id,
    caseId: row.case_id,
    workforceType: row.workforce_type,
    parentRunId: row.parent_run_id,
    lineageDepth: row.lineage_depth,
    completedAt: row.completed_at,
    finalStatus: row.final_status,
    gatePatterns: Array.isArray(row.gate_patterns) ? row.gate_patterns : [],
    effectiveDirectives: Array.isArray(row.effective_directives) ? row.effective_directives : [],
    humanCorrections: Array.isArray(row.human_corrections) ? row.human_corrections : [],
    agentSequence: Array.isArray(row.agent_sequence) ? row.agent_sequence : [],
    tokenEfficiency: row.token_efficiency || 0,
    createdAt: row.created_at,
  };
}

function mapCerebroRow(row: any): CerebroSignalSummary {
  return {
    signalId: row.signal_id,
    timestamp: row.timestamp,
    confidence: row.confidence,
    severity: row.severity,
    signalType: row.signal_type,
    title: row.title,
    description: row.description,
    correlatedSources: Array.isArray(row.correlated_sources) ? row.correlated_sources : [],
    suggestedAction: row.suggested_action,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}
