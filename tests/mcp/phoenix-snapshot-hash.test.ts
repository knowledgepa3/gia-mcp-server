/**
 * @module    test-phoenix-snapshot-hash
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * M4 closure — phoenix_snapshot must emit a REAL SHA-256 over the captured state.
 *
 * Before M4, stateHash was `SHA256:` + Date.now().toString(16) — a hex timestamp, not a
 * hash — while the tool description claimed "Each snapshot is SHA-256 hashed ... for tamper
 * evidence". These tests pin a real, deterministic digest of the snapshot content.
 *
 * Run: cd gia-mcp-server && npx vitest run tests/mcp/phoenix-snapshot-hash.test.ts
 */

import { describe, it, expect } from 'vitest';
import { computeSnapshotStateHash } from '../../src/mcp/tools/phoenix-recovery.js';

describe('computeSnapshotStateHash (M4)', () => {
  it('returns a real 64-char lowercase SHA-256 hex digest, not the old placeholder', () => {
    const h = computeSnapshotStateHash({ a: 1, b: 'two' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h.startsWith('SHA256:')).toBe(false);
  });

  it('is deterministic for the same content', () => {
    const state = { ledger: { totalEntries: 5 }, agents: ['x', 'y'] };
    expect(computeSnapshotStateHash(state)).toBe(computeSnapshotStateHash(state));
  });

  it('changes when the captured state changes (so it actually binds the content)', () => {
    const a = computeSnapshotStateHash({ ledger: { totalEntries: 5 } });
    const b = computeSnapshotStateHash({ ledger: { totalEntries: 6 } });
    expect(a).not.toBe(b);
  });
});
