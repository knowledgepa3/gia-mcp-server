/**
 * @module    verify-ledger-v2.test
 * @layer     GOVERNANCE
 * @inherits  verify-ledger-v2
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Locks the persisted-row verifier contract (Option A §7):
 *   - epoch-2 rows: content-verified from persisted columns (INTACT / DRIFT)
 *   - epoch-1 rows: LEGACY_LINKAGE_ONLY — never content-recomputed, never
 *     falsely reported as tampered, never silently "healed"
 *   - linkage breaks and chain_index gaps: BROKEN_LINK, any epoch
 *   - unknown epochs: LEGACY_UNVERIFIABLE
 *   - a body edit on an epoch-2 row (the exact class the old recovery loop
 *     LAUNDERED) is now DETECTED as DRIFT
 */
import { describe, it, expect } from 'vitest';
import { GENESIS_HASH } from '../../src/shared/constants.js';
import { computeEntryHashV2 } from '../../src/core/audit/canonicalV2.js';
import {
  classifyLedgerRows,
  v2SourceFromRow,
  type ForensicLedgerRow,
} from '../../src/core/audit/verify-ledger-v2.js';

/** Build a chain-consistent epoch-2 row from the previous hash. */
function v2Row(
  chainIndex: number,
  previousHash: string,
  overrides: Partial<ForensicLedgerRow> = {}
): ForensicLedgerRow {
  const base: ForensicLedgerRow = {
    id: `row-${chainIndex}`,
    chain_index: chainIndex,
    timestamp: '2026-07-01T10:00:00.000Z',
    operation: 'governed_op',
    layer: 'MCP',
    actor: 'agent:test',
    parent_id: null,
    correlation_id: null,
    metadata: { seq: chainIndex, nested: { a: 1 } },
    entry_hash: 'PENDING',
    previous_hash: previousHash,
    algo_epoch: 2,
    ...overrides,
  };
  base.entry_hash = computeEntryHashV2(previousHash, v2SourceFromRow(base));
  return base;
}

/** A legacy epoch-1 row with an arbitrary foreign-preimage hash. */
function legacyRow(chainIndex: number, previousHash: string, entryHash: string): ForensicLedgerRow {
  return {
    id: `legacy-${chainIndex}`,
    chain_index: chainIndex,
    timestamp: '2026-06-01T00:00:00.000Z',
    operation: 'legacy_op',
    layer: 'PLATFORM',
    actor: 'ace-server',
    parent_id: null,
    correlation_id: null,
    metadata: {},
    entry_hash: entryHash,
    previous_hash: previousHash,
    algo_epoch: 1,
  };
}

describe('classifyLedgerRows — epoch dispatch', () => {
  it('mixed-epoch interleaved band: legacy rows LEGACY_LINKAGE_ONLY, v2 rows INTACT, clean overall', () => {
    const l0 = legacyRow(0, GENESIS_HASH, 'legacy-hash-0');
    const v1 = v2Row(1, 'legacy-hash-0');
    const l2 = legacyRow(2, v1.entry_hash, 'legacy-hash-2'); // interleave — expected during rollout
    const v3 = v2Row(3, 'legacy-hash-2');

    const result = classifyLedgerRows([l0, v1, l2, v3]);
    expect(result.clean).toBe(true);
    expect(result.counts.LEGACY_LINKAGE_ONLY).toBe(2);
    expect(result.counts.INTACT).toBe(2);
    expect(result.counts.DRIFT).toBe(0);
    expect(result.counts.BROKEN_LINK).toBe(0);
    expect(result.chainHead).toBe(v3.entry_hash);
  });

  it('a BODY EDIT on an epoch-2 row is detected as DRIFT (the class the old recovery loop laundered)', () => {
    const r0 = v2Row(0, GENESIS_HASH);
    const r1 = v2Row(1, r0.entry_hash);
    // Attacker edits the persisted metadata but leaves hashes and linkage intact.
    const tampered: ForensicLedgerRow = { ...r1, metadata: { seq: 1, nested: { a: 999 } } };

    const result = classifyLedgerRows([r0, tampered]);
    expect(result.clean).toBe(false);
    expect(result.counts.DRIFT).toBe(1);
    expect(result.problems[0].classification).toBe('DRIFT');
    expect(result.problems[0].chainIndex).toBe(1);
  });

  it('legacy epoch-1 rows are NEVER content-recomputed — foreign hashes do not produce false tampering', () => {
    const l0 = legacyRow(0, GENESIS_HASH, 'totally-foreign-preimage-hash');
    const result = classifyLedgerRows([l0]);
    expect(result.clean).toBe(true);
    expect(result.counts.LEGACY_LINKAGE_ONLY).toBe(1);
    expect(result.counts.DRIFT).toBe(0);
  });

  it('linkage break at an EPOCH-2 row is BROKEN_LINK and makes the chain dirty', () => {
    const r0 = v2Row(0, GENESIS_HASH);
    const r1 = v2Row(1, 'NOT-the-prior-hash');
    const result = classifyLedgerRows([r0, r1]);
    expect(result.clean).toBe(false);
    expect(result.counts.BROKEN_LINK).toBe(1);
    expect(result.problems[0].detail).toContain('does not match prior entry_hash');
  });

  it('linkage break at an EPOCH-1 row is LEGACY_BROKEN_LINK — permanently reported, does not page (pre-v2 rewrite-loop damage class)', () => {
    const l0 = legacyRow(0, GENESIS_HASH, 'legacy-hash-0');
    const l1 = legacyRow(1, 'NOT-legacy-hash-0', 'legacy-hash-1'); // historical stale pointer
    const result = classifyLedgerRows([l0, l1]);
    expect(result.counts.LEGACY_BROKEN_LINK).toBe(1);
    expect(result.counts.BROKEN_LINK).toBe(0);
    // Reported in problems (the damage is on the record), but clean=true —
    // MANDATORY paging is reserved for NEW (epoch-2-era) breaks and drift.
    expect(result.problems.some((p) => p.classification === 'LEGACY_BROKEN_LINK')).toBe(true);
    expect(result.clean).toBe(true);
  });

  it('chain_index gap is BROKEN_LINK', () => {
    const r0 = v2Row(0, GENESIS_HASH);
    const r5 = v2Row(5, r0.entry_hash); // gap 0 → 5
    const result = classifyLedgerRows([r0, r5]);
    expect(result.clean).toBe(false);
    expect(result.counts.BROKEN_LINK).toBe(1);
    expect(result.problems[0].detail).toContain('chain_index gap');
  });

  it('unknown algo_epoch is LEGACY_UNVERIFIABLE (R-7: never a silent algorithm choice)', () => {
    const weird = { ...legacyRow(0, GENESIS_HASH, 'h0'), algo_epoch: 7 };
    const result = classifyLedgerRows([weird]);
    expect(result.counts.LEGACY_UNVERIFIABLE).toBe(1);
    // Unverifiable ≠ broken: linkage held, so the chain is not declared dirty.
    expect(result.counts.BROKEN_LINK).toBe(0);
  });

  it('missing algo_epoch column (pre-migration rows) defaults to the legacy bucket', () => {
    const noEpoch = { ...legacyRow(0, GENESIS_HASH, 'h0'), algo_epoch: undefined };
    const result = classifyLedgerRows([noEpoch]);
    expect(result.counts.LEGACY_LINKAGE_ONLY).toBe(1);
  });

  it('mislabeled epoch (legacy hash stamped algo_epoch=2) surfaces as DRIFT, never silently passes (R-7)', () => {
    const mislabeled = { ...legacyRow(0, GENESIS_HASH, 'legacy-foreign-hash'), algo_epoch: 2 };
    const result = classifyLedgerRows([mislabeled]);
    expect(result.counts.DRIFT).toBe(1);
    expect(result.clean).toBe(false);
  });

  it('empty ledger is clean', () => {
    const result = classifyLedgerRows([]);
    expect(result.clean).toBe(true);
    expect(result.totalRows).toBe(0);
    expect(result.chainHead).toBeNull();
  });

  it('timestamp round-trip: a Date from pg and the written ISO string verify identically', () => {
    const asString = v2Row(0, GENESIS_HASH);
    // pg returns TIMESTAMPTZ as a JS Date — same instant must still verify.
    const asDate: ForensicLedgerRow = { ...asString, timestamp: new Date('2026-07-01T10:00:00.000Z') };
    const result = classifyLedgerRows([asDate]);
    expect(result.counts.INTACT).toBe(1);
  });
});
