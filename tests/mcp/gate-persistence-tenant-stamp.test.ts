/**
 * @module    test-gate-persistence-tenant-stamp
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Task #21 (prereq for #19) — persistGateRequest previously omitted tenant_id,
 * so every kernel-created MANDATORY gate defaulted to tenant 'default' and was
 * invisible to real-tenant consoles under RLS (memory: gate-notification-
 * console-bugs). Source-guard style (the module's pool/enabled state is
 * private): the INSERT must stamp tenant_id from PLATFORM_PRIMARY_TENANT_ID
 * with the documented 'default' fallback, and the init fallback table must
 * carry the column so the stamped INSERT can't fail on a sandbox DB.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'core', 'persistence', 'gate-persistence.ts'), 'utf8');

describe('SOURCE GUARD: persistGateRequest tenant stamping (task #21)', () => {
  it('INSERT includes tenant_id as an explicit column + parameter', () => {
    const insertMatch = src.match(/INSERT INTO gate_approvals_persistent \(([^)]+)\)\s*VALUES \(([^)]+)\)/);
    expect(insertMatch, 'gate-request INSERT not found').toBeTruthy();
    expect(insertMatch![1]).toContain('tenant_id');
    expect(insertMatch![2]).toContain('$8');
  });

  it('tenant comes from PLATFORM_PRIMARY_TENANT_ID with the documented default fallback', () => {
    expect(src).toMatch(/process\.env\.PLATFORM_PRIMARY_TENANT_ID \|\| 'default'/);
  });

  it('init fallback table carries tenant_id (and the idempotent add for pre-140 sandboxes)', () => {
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS gate_approvals_persistent[\s\S]*tenant_id TEXT NOT NULL DEFAULT 'default'/);
    expect(src).toMatch(/ALTER TABLE gate_approvals_persistent ADD COLUMN IF NOT EXISTS tenant_id/);
  });

  it('resolution path stays tenant-agnostic (resolve is by gate_id — no tenant filter added)', () => {
    const resolveSection = src.slice(src.indexOf('persistGateResolution'));
    expect(resolveSection).not.toMatch(/tenant_id\s*=/);
  });
});
