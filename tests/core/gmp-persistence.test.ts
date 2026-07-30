/**
 * @module    gmp-persistence.test
 * @layer     GOVERNANCE
 * @inherits  gmp-persistence
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Source-lock tests for governed_memory_packs tenant attribution
 * (migration 139, DESIGN CALL #2 ratified 2026-06-12).
 *
 * gmp-persistence builds its pool lazily from DATABASE_URL inside the module,
 * so these lock the SQL contract at the source level — the same pairing-lock
 * style as sso-tenant-binding's call-site locks. If someone removes the
 * tenant_id stamp from persistPack (or the fallback DDL), these fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '../../src/core/persistence/gmp-persistence.ts'),
  'utf-8'
);

describe('gmp-persistence tenant attribution (migration 139)', () => {
  it('persistPack INSERT column list carries tenant_id as the 20th column', () => {
    const insert = SOURCE.match(
      /INSERT INTO governed_memory_packs \(([\s\S]*?)\) VALUES \(([^)]*)\)/
    );
    expect(insert).not.toBeNull();
    const columns = insert![1].split(',').map((c) => c.trim());
    expect(columns).toContain('tenant_id');
    expect(columns.length).toBe(20);
    expect(insert![2]).toContain('$20');
  });

  it('persistPack params bind PLATFORM_TENANT_ID (not a literal default)', () => {
    // The params array for the pack INSERT must end with the platform tenant
    // constant — lastUsedBy || null is the 19th param, PLATFORM_TENANT_ID the 20th.
    expect(SOURCE).toMatch(
      /pack\.audit\?\.lastUsedBy \|\| null,\s*\n\s*PLATFORM_TENANT_ID,/
    );
  });

  it('persistUsageEvent still stamps PLATFORM_TENANT_ID (m136 regression lock)', () => {
    const usageInsert = SOURCE.match(
      /INSERT INTO gmp_usage_log \(([^)]*)\)/
    );
    expect(usageInsert).not.toBeNull();
    expect(usageInsert![1]).toContain('tenant_id');
  });

  it('fallback DDL for governed_memory_packs includes the tenant_id column', () => {
    const ddl = SOURCE.match(
      /CREATE TABLE IF NOT EXISTS governed_memory_packs \(([\s\S]*?)\)\s*`/
    );
    expect(ddl).not.toBeNull();
    expect(ddl![1]).toContain("tenant_id TEXT NOT NULL DEFAULT 'default'");
  });
});
