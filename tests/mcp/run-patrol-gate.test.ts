/**
 * @module    test-run-patrol-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for the same self-report-trust bug class found
 * elsewhere in the 2026-07-14 MCP audit: gia_run_patrol's high-sensitivity
 * "MANDATORY" check was `if (!approved_by || BLOCKED_APPROVERS.includes(...))
 * reject` — a caller-supplied identity, not a real gate.
 *
 * No pack in the current PACK_LIBRARY has dataSensitivity:'high', so the
 * high-sensitivity branch cannot be exercised through a real seeded fixture
 * today (documented honestly, not silently skipped) — the pure predicate
 * that decides whether the gate applies is tested directly instead, and the
 * wiring is fixed by exact pattern parity with transfer_memory_pack and
 * gia_apply_pack, both of which DO have full integration coverage.
 */
import { describe, it, expect } from 'vitest';
import { isHighSensitivityPatrol } from '../../src/mcp/tools/remediation-packs.js';

describe('isHighSensitivityPatrol (pure predicate)', () => {
  it('high dataSensitivity requires the MANDATORY gate', () => {
    expect(isHighSensitivityPatrol({ dataSensitivity: 'high' })).toBe(true);
  });
  it('moderate dataSensitivity does not', () => {
    expect(isHighSensitivityPatrol({ dataSensitivity: 'moderate' })).toBe(false);
  });
  it('low dataSensitivity does not', () => {
    expect(isHighSensitivityPatrol({ dataSensitivity: 'low' })).toBe(false);
  });
});
