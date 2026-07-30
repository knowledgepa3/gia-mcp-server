/**
 * @module    ledger-recovery-readonly.test
 * @layer     GOVERNANCE
 * @inherits  forensic-ledger
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Locks the READ-ONLY recovery contract (STATE-OF-THE-LEDGER-VERIFIED-2026-06-30
 * finding F-2 HIGH, fixed 2026-07-01):
 *
 *   1. Startup recovery NEVER issues UPDATE forensic_ledger — even when stored
 *      hashes do not match this process's algorithm (they legitimately differ
 *      for rows written by Express/sentry/tenantProvisioning historical
 *      preimages). The old behavior recomputed + UPDATE'd every such row on
 *      every restart, silently rewriting other writers' rows and laundering
 *      any genuine tamper.
 *   2. Recovered rows keep their STORED entry_hash/previous_hash/chain_index;
 *      the in-memory head becomes the stored head.
 *   3. A linkage break in the persisted chain is DETECTED and reported, never
 *      repaired.
 *   4. verifyChain(Full) after recovery is linkage-only for the recovered
 *      prefix (no false tampering on foreign-preimage rows) and content-verifies
 *      entries appended in-process.
 *   5. updateEntryHashes is a logging no-op — no SQL reaches the pool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAuditEntry } from '../../src/shared/types.js';
import { GENESIS_HASH } from '../../src/shared/constants.js';

// ---------------------------------------------------------------------------
// pg mock — captures every SQL string that reaches the pool or a client.
// ---------------------------------------------------------------------------
const allSql: string[] = [];
let recoveryRows: any[] = [];

const clientQueryMock = vi.fn(async (sql: string) => {
  allSql.push(String(sql));
  if (String(sql).includes('FROM forensic_ledger ORDER BY chain_index DESC')) {
    // Chain-head read for persistEntry — serve the last recovery row if any.
    const last = recoveryRows[recoveryRows.length - 1];
    return last
      ? { rows: [{ entry_hash: last.entry_hash, chain_index: last.chain_index }] }
      : { rows: [] };
  }
  return { rows: [] };
});
const releaseMock = vi.fn();
const mockClient = { query: clientQueryMock, release: releaseMock };

const poolQueryMock = vi.fn(async (sql: string) => {
  allSql.push(String(sql));
  if (String(sql).includes('SELECT * FROM forensic_ledger ORDER BY chain_index ASC')) {
    return { rows: recoveryRows };
  }
  return { rows: [] };
});

vi.mock('pg', () => ({
  Pool: class MockPool {
    connect = vi.fn(async () => mockClient);
    query = poolQueryMock;
    end = vi.fn(async () => undefined);
  },
}));

/** A persisted DB row whose entry_hash was produced by a FOREIGN preimage —
 * recomputing it with this process's algorithm can never match. */
function foreignRow(chainIndex: number, entryHash: string, previousHash: string): any {
  return {
    id: `row-${chainIndex}`,
    chain_index: chainIndex,
    timestamp: '2026-06-30T00:00:00.000Z',
    operation: 'express_event',
    layer: 'PLATFORM',
    mai_level: 'INFORMATIONAL',
    actor: 'ace-server',
    status: 'COMPLETED',
    parent_id: null,
    correlation_id: null,
    governance_score: null,
    gate_decision: null,
    metadata: { nested: { z: 1, a: 2 } },
    duration: null,
    error_code: null,
    error_message: null,
    entry_hash: entryHash,
    previous_hash: previousHash,
  };
}

async function freshModules() {
  vi.resetModules();
  const persistence = await import('../../src/core/audit/ledger-persistence.js');
  const { ForensicLedger } = await import('../../src/core/audit/ledger.js');
  return { persistence, ForensicLedger };
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
  allSql.length = 0;
  recoveryRows = [];
  clientQueryMock.mockClear();
  poolQueryMock.mockClear();
  releaseMock.mockClear();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('read-only recovery (F-2)', () => {
  it('never issues UPDATE forensic_ledger, even when stored hashes do not match this algorithm', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoveryRows = [
      foreignRow(0, 'express-preimage-hash-0', GENESIS_HASH),
      foreignRow(1, 'express-preimage-hash-1', 'express-preimage-hash-0'),
    ];

    const { ForensicLedger } = await freshModules();
    const ledger = new ForensicLedger();
    const result = await ledger.initPersistence();

    expect(result.recovered).toBe(2);
    expect(allSql.some((s) => s.includes('UPDATE forensic_ledger'))).toBe(false);
    errSpy.mockRestore();
  });

  it('keeps STORED hashes and adopts the stored head — no re-linking', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoveryRows = [
      foreignRow(0, 'express-preimage-hash-0', GENESIS_HASH),
      foreignRow(1, 'express-preimage-hash-1', 'express-preimage-hash-0'),
    ];

    const { ForensicLedger } = await freshModules();
    const ledger = new ForensicLedger();
    await ledger.initPersistence();

    expect(ledger.chainHead).toBe('express-preimage-hash-1');
    const recovered = ledger.getChainSlice(0);
    expect(recovered[0].entryHash).toBe('express-preimage-hash-0');
    expect(recovered[0].previousHash).toBe(GENESIS_HASH);
    expect(recovered[1].entryHash).toBe('express-preimage-hash-1');
    expect(recovered[1].previousHash).toBe('express-preimage-hash-0');
    errSpy.mockRestore();
  });

  it('detects a persisted linkage break, reports it, and does NOT repair it', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoveryRows = [
      foreignRow(0, 'hash-0', GENESIS_HASH),
      foreignRow(1, 'hash-1', 'NOT-hash-0'), // broken linkage
    ];

    const { ForensicLedger } = await freshModules();
    const ledger = new ForensicLedger();
    const result = await ledger.initPersistence();

    expect(result.recovered).toBe(2);
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('LINKAGE BREAK');
    expect(allSql.some((s) => s.includes('UPDATE forensic_ledger'))).toBe(false);
    // Stored values untouched in memory too.
    expect(ledger.getChainSlice(0)[1].previousHash).toBe('NOT-hash-0');

    // KNOWN-LEGACY-BREAK BASELINE (incident 2026-07-01, gate-9d3f1c43): the
    // break recorded at recovery is permanent immutable history — it is
    // REPORTED on every walk (legacyLinkageBreaks) but does NOT flip the chain
    // to invalid, so the integrity sentry does not fire a MANDATORY gate at
    // every boot forever for damage that can never be repaired.
    const full = ledger.verifyChainFull();
    expect(full.valid).toBe(true);
    expect(full.legacyLinkageBreaks).toBe(1);
    errSpy.mockRestore();
  });

  it('verifyChainFull after recovery: recovered prefix is linkage-only (no false tampering), in-process appends are content-verified', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoveryRows = [
      foreignRow(0, 'express-preimage-hash-0', GENESIS_HASH),
      foreignRow(1, 'express-preimage-hash-1', 'express-preimage-hash-0'),
    ];

    const { ForensicLedger } = await freshModules();
    const ledger = new ForensicLedger();
    await ledger.initPersistence();

    // Full walk: foreign-preimage rows must NOT be reported as tampered.
    const full = ledger.verifyChainFull();
    expect(full.valid).toBe(true);
    expect(full.linkageOnlyPrefix).toBe(2);
    expect(full.contentVerified).toBe(0);

    // Append in-process — this entry IS content-verifiable.
    ledger.record({
      id: 'in-proc-1',
      timestamp: new Date('2026-07-01T00:00:00.000Z'),
      operation: 'test_operation',
      layer: 'CORE',
      maiLevel: 'I',
      actor: 'TEST',
      status: 'SUCCESS',
      metadata: {},
    } as unknown as IAuditEntry);

    const full2 = ledger.verifyChainFull();
    expect(full2.valid).toBe(true);
    expect(full2.linkageOnlyPrefix).toBe(2);
    expect(full2.contentVerified).toBe(1);
    expect(full2.entriesVerified).toBe(3);
    errSpy.mockRestore();
  });

  it('updateEntryHashes is a logging no-op — no SQL reaches the pool', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { persistence } = await freshModules();
    await persistence.initLedgerPersistence();
    allSql.length = 0;

    persistence.updateEntryHashes(42, 'new-hash', 'new-prev');
    await new Promise((r) => setImmediate(r));

    expect(allSql).toHaveLength(0);
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('BLOCKED');
    expect(logged).toContain('42');
    errSpy.mockRestore();
  });
});
