/**
 * @module    routing-persistence
 * @layer     GOVERNANCE
 * @inherits  src/core/threshold/routing-monitor
 * @mai       I — read-side hydration of routing observations
 * @audit     false — observations are telemetry; assessments audit via ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * ROUTING OBSERVATION HYDRATION (read side)
 *
 * The egress chokepoint for GIA model calls is the server-side LLM kernel
 * (ace-server container), which WRITES one routing_observations row per
 * completed request to the shared PostgreSQL (canonical schema:
 * server/src/db/migrations/128_routing_observations.sql).
 *
 * This module is the READ side: the gia-mcp engine hydrates the
 * ModelRoutingThresholdMonitor from those rows before each assessment.
 * The table is ensured here too (idempotent DDL) so whichever container
 * boots first creates it.
 */

import {
  IRoutingObservation,
  ModelTier,
  RoutingOutcome,
} from '../threshold/routing-types.js';
import { bootNotice } from '../../shared/bootNotice.js';

/** PostgreSQL pool — lazy initialized (same pattern as gate-persistence) */
let pool: any = null;
let persistenceEnabled = false;

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS routing_observations (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    planned_model TEXT NOT NULL,
    served_model TEXT NOT NULL,
    outcome TEXT NOT NULL,
    batched BOOLEAN NOT NULL DEFAULT FALSE,
    batch_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    is_canary BOOLEAN NOT NULL DEFAULT FALSE
  )
`;

export async function initRoutingPersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    bootNotice('[Routing-Persist] No DATABASE_URL — monitor runs in-memory only');
    return false;
  }

  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const client = await pool.connect();
    try {
      await client.query(ENSURE_TABLE_SQL);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_routing_obs_time ON routing_observations(observed_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_routing_obs_planned ON routing_observations(planned_model, observed_at)`,
      );
    } finally {
      client.release();
    }

    persistenceEnabled = true;
    console.error('[Routing-Persist] PostgreSQL hydration initialized');
    return true;
  } catch (err) {
    console.error('[Routing-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

export function isRoutingPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Load observations for a window from the shared table. Returns [] when
 * persistence is unavailable — the monitor then assesses on in-memory
 * observations only and INSUFFICIENT_DATA does the honest talking.
 */
export async function loadRoutingObservations(
  windowStart: Date,
  windowEnd: Date,
): Promise<IRoutingObservation[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT request_id, observed_at, planned_model, served_model, outcome,
              batched, batch_eligible, input_tokens, cache_read_tokens,
              cache_write_tokens, output_tokens, is_canary
         FROM routing_observations
        WHERE observed_at >= $1 AND observed_at <= $2
        ORDER BY observed_at ASC
        LIMIT 50000`,
      [windowStart, windowEnd],
    );

    return result.rows.map((r: Record<string, unknown>): IRoutingObservation => ({
      requestId: String(r.request_id),
      timestamp: new Date(r.observed_at as string),
      plannedTier: String(r.planned_model) as ModelTier,
      servedTier: String(r.served_model) as ModelTier,
      outcome: String(r.outcome) as RoutingOutcome,
      batched: Boolean(r.batched),
      batchEligible: Boolean(r.batch_eligible),
      inputTokens: Number(r.input_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      outputTokens: Number(r.output_tokens),
      canary: Boolean(r.is_canary),
    }));
  } catch (err) {
    console.error('[Routing-Persist] Load failed:', (err as Error).message);
    return [];
  }
}

// ─── Premium-routing halt flag (shared enforcement signal) ────────────────
// The kernel (ace-server container) polls this key with a 30s cache and
// refuses premium-tier dispatches while it is 'true'. Durable in the DB so
// a gia-mcp restart cannot silently lift a halt (the in-memory gate promise
// dies with the process; the flag does not).

const PREMIUM_ROUTING_HALT_KEY = 'premium_routing_halted';

export async function setPremiumRoutingHaltFlag(halted: boolean, updatedBy: string): Promise<void> {
  if (!persistenceEnabled || !pool) {
    console.error('[Routing-Persist] Cannot write halt flag — persistence unavailable');
    return;
  }
  try {
    await pool.query(
      `INSERT INTO mcp_security_config (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
      [PREMIUM_ROUTING_HALT_KEY, halted ? 'true' : 'false', updatedBy],
    );
    console.error(`[Routing-Persist] premium_routing_halted=${halted} (by ${updatedBy})`);
  } catch (err) {
    console.error('[Routing-Persist] Halt flag write failed:', (err as Error).message);
  }
}

export async function getPremiumRoutingHaltFlag(): Promise<boolean> {
  if (!persistenceEnabled || !pool) return false;
  try {
    const r = await pool.query(
      `SELECT value FROM mcp_security_config WHERE key = $1`,
      [PREMIUM_ROUTING_HALT_KEY],
    );
    return r.rows.length > 0 && r.rows[0].value === 'true';
  } catch (err) {
    console.error('[Routing-Persist] Halt flag read failed:', (err as Error).message);
    return false;
  }
}

export async function closeRoutingPersistence(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
    persistenceEnabled = false;
  }
}
