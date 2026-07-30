/**
 * @module    gmp-persistence
 * @layer     GOVERNANCE
 * @mai       M — persistence of GMPs is MANDATORY for production
 * @audit     true — GMPs are governance artifacts
 * @owner     William J. Storey III / ACE / GIA
 *
 * GOVERNED MEMORY PACK POSTGRESQL PERSISTENCE
 *
 * Write-through persistence for the in-memory gmpPacks Map.
 * Every seal/load/transfer/compose/promote writes here.
 * On startup, packs are recovered from the database.
 *
 * Design principles:
 * - Async writes: never block the in-memory operations
 * - Recovery: rebuild full Map from PostgreSQL on startup
 * - Idempotent: duplicate key errors silenced
 */

import { bootNotice } from '../../shared/bootNotice.js';

/** PostgreSQL pool — lazy initialized */
let pool: any = null;
let persistenceEnabled = false;

/**
 * Tenant attribution for gmp_usage_log AND governed_memory_packs writes.
 * gia-mcp is platform infrastructure with no per-request tenant identity
 * (same surface shape as telemetry-persistence governance_events) — both
 * stamp the platform tenant. Usage log: INSERT omitted tenant_id before
 * 2026-06-12 (migration 136 backfilled). Packs: same fix landed with
 * migration 139 (trust-level RLS — SYSTEM packs read globally, ORG/CASE
 * tenant-scoped). recoverPacks/recoverUsageLog stay platform ops: this pool
 * runs as the superuser DATABASE_URL role, which bypasses RLS — intentional,
 * recovery must rebuild the full in-memory Map.
 */
const PLATFORM_TENANT_ID = process.env.PLATFORM_PRIMARY_TENANT_ID || 'default';

/**
 * Initialize the PostgreSQL connection pool for GMP persistence.
 */
export async function initGMPPersistence(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    bootNotice('[GMP-Persist] No DATABASE_URL — running in-memory only');
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
    // Tables are created by migration 028_governed_memory_packs.sql
    // We only verify connectivity and that the tables exist.
    const client = await pool.connect();
    try {
      await client.query(`SELECT 1 FROM governed_memory_packs LIMIT 0`);
      await client.query(`SELECT 1 FROM gmp_usage_log LIMIT 0`);
    } catch {
      // Tables don't exist — try to create them (fallback for pre-migration setups)
      await client.query(`
        CREATE TABLE IF NOT EXISTS governed_memory_packs (
          memory_pack_id TEXT PRIMARY KEY, version VARCHAR(50) NOT NULL,
          type VARCHAR(50) NOT NULL, trust_level VARCHAR(20) NOT NULL,
          domain VARCHAR(100) NOT NULL, scope TEXT[] NOT NULL DEFAULT '{}',
          risk_level VARCHAR(20) NOT NULL, ttl_hours INTEGER NOT NULL,
          created_by VARCHAR(255) NOT NULL, signed_by VARCHAR(255) NOT NULL,
          hash VARCHAR(16) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'SEALED',
          policy JSONB NOT NULL DEFAULT '{}', content JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL, usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_by VARCHAR(255),
          tenant_id TEXT NOT NULL DEFAULT 'default'
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS gmp_usage_log (
          id BIGSERIAL PRIMARY KEY, event VARCHAR(50) NOT NULL,
          memory_pack_id TEXT NOT NULL, agent_id VARCHAR(255) NOT NULL,
          run_id VARCHAR(255) NOT NULL, hash VARCHAR(16) NOT NULL,
          approved_by VARCHAR(255), timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          tenant_id TEXT NOT NULL DEFAULT 'default'
        )
      `);
    }
    client.release();

    persistenceEnabled = true;
    console.error('[GMP-Persist] PostgreSQL persistence initialized');
    return true;
  } catch (err) {
    console.error('[GMP-Persist] Failed to initialize:', (err as Error).message);
    return false;
  }
}

/**
 * Persist a GMP pack (upsert — update on conflict for status/usage changes).
 */
export function persistPack(pack: any): void {
  if (!persistenceEnabled || !pool) return;

  pool.query(
    `INSERT INTO governed_memory_packs (
      memory_pack_id, version, type, trust_level, domain, scope,
      risk_level, ttl_hours, created_by, signed_by, hash, status,
      policy, content, created_at, last_reviewed_at, expires_at,
      usage_count, last_used_by, tenant_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (memory_pack_id) DO UPDATE SET
      status = EXCLUDED.status,
      usage_count = EXCLUDED.usage_count,
      last_used_by = EXCLUDED.last_used_by,
      last_reviewed_at = EXCLUDED.last_reviewed_at`,
    [
      pack.memoryPackId,
      pack.version,
      pack.type,
      pack.trustLevel,
      pack.domain,
      pack.content?.scope || pack.scope || [],
      pack.riskLevel,
      pack.audit?.expiresAt
        ? Math.ceil((new Date(pack.audit.expiresAt).getTime() - new Date(pack.audit.createdAt).getTime()) / 3600000)
        : pack.ttlHours || 720,
      pack.createdBy || pack.audit?.createdBy || 'unknown',
      pack.signedBy || 'unknown',
      pack.hash || '',
      pack.status,
      JSON.stringify(pack.policy || {}),
      JSON.stringify(pack.content || {}),
      pack.audit?.createdAt || new Date().toISOString(),
      pack.audit?.lastReviewed || new Date().toISOString(),
      pack.audit?.expiresAt || new Date(Date.now() + 720 * 3600000).toISOString(),
      pack.audit?.usageCount || 0,
      pack.audit?.lastUsedBy || null,
      PLATFORM_TENANT_ID,
    ]
  ).catch((err: any) => {
    if (err.code === '23505') return; // duplicate, safe to ignore
    console.error('[GMP-Persist] Pack write failed:', err.message);
  });
}

/**
 * Persist a usage log event.
 */
export function persistUsageEvent(event: any): void {
  if (!persistenceEnabled || !pool) return;

  pool.query(
    `INSERT INTO gmp_usage_log (event, memory_pack_id, agent_id, run_id, hash, approved_by, timestamp, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.event,
      event.memoryPackId,
      event.agentId,
      event.runId,
      event.hash,
      event.approvedBy || null,
      event.timestamp || new Date().toISOString(),
      PLATFORM_TENANT_ID,
    ]
  ).catch((err: any) => {
    console.error('[GMP-Persist] Usage log write failed:', err.message);
  });
}

/**
 * Recover all GMP packs from PostgreSQL.
 * Returns raw rows for the caller to reconstruct in-memory GMPPack objects.
 */
export async function recoverPacks(): Promise<any[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const result = await pool.query(
      `SELECT * FROM governed_memory_packs WHERE status != 'EXPIRED' ORDER BY created_at ASC`
    );
    console.error(`[GMP-Persist] Recovered ${result.rows.length} packs from PostgreSQL`);
    return result.rows;
  } catch (err) {
    console.error('[GMP-Persist] Recovery failed:', (err as Error).message);
    return [];
  }
}

/**
 * Recover usage log events for distillation.
 */
export async function recoverUsageLog(domain?: string): Promise<any[]> {
  if (!persistenceEnabled || !pool) return [];

  try {
    const query = domain
      ? `SELECT * FROM gmp_usage_log WHERE memory_pack_id LIKE $1 ORDER BY timestamp ASC`
      : `SELECT * FROM gmp_usage_log ORDER BY timestamp ASC`;
    const params = domain ? [`%${domain}%`] : [];
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('[GMP-Persist] Usage log recovery failed:', (err as Error).message);
    return [];
  }
}

export function isGMPPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * Gracefully close the GMP persistence pool.
 * Called during server shutdown to avoid connection leaks.
 */
export async function closeGMPPersistence(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      console.error('[GMP-Persist] Pool closed');
    } catch (err) {
      console.error('[GMP-Persist] Pool close error:', (err as Error).message);
    }
    pool = null;
    persistenceEnabled = false;
  }
}
