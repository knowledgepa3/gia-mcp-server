/**
 * @module    canonical.test
 * @layer     GOVERNANCE
 * @inherits  audit-canonical
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Locks canonicalization contracts:
 *   1. LEGACY (epoch-1) canonical.ts mechanics stay pinned — recursive key sort,
 *      hash-field exclusion — because the legacy verifier semantics reference them.
 *      Do NOT delete these pins: they are the production-preimage regression
 *      record for the pre-v2 MCP algorithm (Option A §5.1 layer 4).
 *   2. Since 2026-07-01 the LIVE write paths (in-memory appendEntry + DB
 *      persistEntry) hash the Ledger Canonical v2 projection (canonicalV2.ts,
 *      epoch 2) — both pinned here to the same v2 hash.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { IAuditEntry } from '../../src/shared/types.js';
import { canonicalize, computeEntryHash } from '../../src/core/audit/canonical.js';
import { computeEntryHashV2 } from '../../src/core/audit/canonicalV2.js';
import { projectAuditEntryToV2 } from '../../src/core/audit/projectToV2.js';
import { ForensicLedger } from '../../src/core/audit/ledger.js';
import { GENESIS_HASH } from '../../src/shared/constants.js';

function makeEntry(overrides: Partial<IAuditEntry> = {}): IAuditEntry {
  return {
    id: 'canon-entry-1',
    timestamp: new Date('2026-06-29T00:00:00.000Z'),
    operation: 'test_operation',
    layer: 'CORE',
    maiLevel: 'I',
    actor: 'TEST',
    status: 'SUCCESS',
    metadata: {},
    entryHash: 'placeholder',
    previousHash: 'placeholder',
    chainIndex: 0,
    ...overrides,
  } as IAuditEntry;
}

// An entry whose NESTED metadata keys are deliberately out of sorted order —
// this is exactly where the old flat (top-level-only) sort diverged from the
// recursive sort. zulu/alpha at one level, delta/bravo nested below.
const NESTED_UNSORTED = { zulu: 1, alpha: { delta: 1, bravo: 2 } };
const NESTED_SORTED = { alpha: { bravo: 2, delta: 1 }, zulu: 1 };

describe('canonicalize — recursive determinism', () => {
  it('produces identical output regardless of nested key insertion order', () => {
    const a = makeEntry({ id: 'x', metadata: { ...NESTED_UNSORTED } });
    const b = makeEntry({ id: 'x', metadata: { ...NESTED_SORTED } });
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('excludes entryHash/previousHash/chainIndex from the canonical form', () => {
    const base = makeEntry({ id: 'x' });
    const tampered = makeEntry({ id: 'x', entryHash: 'DIFFERENT', previousHash: 'DIFFERENT', chainIndex: 999 });
    expect(canonicalize(base)).toBe(canonicalize(tampered));
  });

  it('computeEntryHash is deterministic and order-independent for nested metadata', () => {
    const a = makeEntry({ id: 'x', metadata: { ...NESTED_UNSORTED } });
    const b = makeEntry({ id: 'x', metadata: { ...NESTED_SORTED } });
    expect(computeEntryHash(GENESIS_HASH, a)).toBe(computeEntryHash(GENESIS_HASH, b));
  });
});

describe('in-memory ForensicLedger uses Ledger Canonical v2 (epoch 2)', () => {
  it('a recorded entry hashes to computeEntryHashV2(GENESIS, projectToV2(entry))', () => {
    const ledger = new ForensicLedger(); // no persistence init → in-memory only
    const entry = makeEntry({ id: 'rec-1', metadata: { ...NESTED_UNSORTED } });
    ledger.record(entry);

    const recorded = ledger.getEntry('rec-1');
    expect(recorded).toBeDefined();
    expect(recorded!.algoEpoch).toBe(2);
    expect(recorded!.entryHash).toBe(computeEntryHashV2(GENESIS_HASH, projectAuditEntryToV2(recorded!)));
  });
});

// ── DB persist path must agree with the shared hash ────────────────────────
const queryMock = vi.fn();
const releaseMock = vi.fn();
const mockClient = { query: queryMock, release: releaseMock };
const connectMock = vi.fn(async () => mockClient);

vi.mock('pg', () => ({
  Pool: class MockPool {
    connect = connectMock;
    query = vi.fn(async () => ({ rows: [] }));
    end = vi.fn(async () => undefined);
  },
}));

const HEAD_HASH = 'prev-hash-abc';
const HEAD_INDEX = 41;

function persistQueryImpl(sql: string): Promise<{ rows: any[] }> {
  if (typeof sql === 'string' && sql.includes('FROM forensic_ledger ORDER BY chain_index DESC')) {
    return Promise.resolve({ rows: [{ entry_hash: HEAD_HASH, chain_index: HEAD_INDEX }] });
  }
  return Promise.resolve({ rows: [] });
}

async function flush(): Promise<void> {
  await vi.waitFor(
    () => { if (releaseMock.mock.calls.length === 0) throw new Error('write not settled'); },
    { timeout: 5000, interval: 5 }
  );
  await new Promise((r) => setImmediate(r));
}

describe('DB persist path hashes the Ledger Canonical v2 projection', () => {
  let persistence: typeof import('../../src/core/audit/ledger-persistence.js');

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
    queryMock.mockImplementation(persistQueryImpl as any);
    persistence = await import('../../src/core/audit/ledger-persistence.js');
    const ok = await persistence.initLedgerPersistence();
    expect(ok).toBe(true);
  });

  afterAll(async () => {
    await persistence.closeLedgerPersistence();
    delete process.env.DATABASE_URL;
  });

  it('stored entry_hash equals computeEntryHashV2(projectToV2) for nested unsorted metadata, and the INSERTed metadata is the hashed form', async () => {
    queryMock.mockClear();
    releaseMock.mockClear();
    queryMock.mockImplementation(persistQueryImpl as any);

    const entry = makeEntry({ id: 'persist-nested', metadata: { ...NESTED_UNSORTED } });
    persistence.persistEntry(entry);
    await flush();

    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO forensic_ledger'));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as any[];
    const storedEntryHash = params[16];   // entry_hash
    const storedPrevHash = params[17];     // previous_hash = DB head
    expect(storedPrevHash).toBe(HEAD_HASH);

    // The persist path links off the DB head and hashes the v2 projection
    // (chainIndex/previousHash are never in the v2 preimage).
    const v2Source = projectAuditEntryToV2(entry);
    expect(storedEntryHash).toBe(computeEntryHashV2(HEAD_HASH, v2Source));

    // CLOSURE RULE: the metadata column receives the SAME sanitized object
    // that was hashed (hash-form ≡ persisted-form).
    expect(params[12]).toBe(JSON.stringify(v2Source.metadata));
    // algo_epoch column stamped 2.
    expect(params[22]).toBe(2);
  });
});
