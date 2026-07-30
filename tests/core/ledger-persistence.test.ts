/**
 * @module    ledger-persistence.test
 * @layer     GOVERNANCE
 * @inherits  ledger-persistence
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Chain-write platform-context pin + 23505 discrimination
 * (incident 2026-06-12, mirrors server commit b1364589).
 *
 * Under FORCE RLS on forensic_ledger, the chain-head SELECT must run in
 * platform context (app.current_tenant_id = '') or it sees a tenant-filtered
 * (stale) head → UNIQUE(chain_index) 23505 → if swallowed as "already
 * persisted", entries are silently lost. These tests mock the pg client and
 * assert:
 *   (a) SET LOCAL platform pin is issued after BEGIN and before the head read
 *   (b) 23505 on forensic_ledger_chain_index_key → error-level log, not swallow
 *   (c) 23505 on pkey / entry_hash constraints stays benign (true dupes)
 *   (d) inserted row params (tenant attribution) are unchanged
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { IAuditEntry } from '../../src/shared/types.js';
import { EntryStatus } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// pg mock — module-level so the lazy `await import('pg')` in
// initLedgerPersistence resolves to it.
// ---------------------------------------------------------------------------
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

function makeEntry(overrides: Partial<IAuditEntry> = {}): IAuditEntry {
  return {
    id: 'test-entry-1',
    timestamp: new Date('2026-06-12T00:00:00.000Z'),
    operation: 'test_operation',
    layer: 'CORE',
    maiLevel: 'I',
    actor: 'TEST',
    status: 'SUCCESS',
    metadata: {},
    entryHash: 'deadbeef',
    previousHash: 'genesis',
    chainIndex: 0,
    ...overrides,
  } as IAuditEntry;
}

/** Default query behavior: head SELECT returns an existing chain head. */
function defaultQueryImpl(sql: string): Promise<{ rows: any[] }> {
  if (typeof sql === 'string' && sql.includes('FROM forensic_ledger ORDER BY chain_index DESC')) {
    return Promise.resolve({ rows: [{ entry_hash: 'prev-hash-abc', chain_index: 41 }] });
  }
  return Promise.resolve({ rows: [] });
}

/**
 * Drain the fire-and-forget persistEntry IIFE deterministically: the write
 * path always ends with client.release() in finally, so wait for it rather
 * than a fixed number of event-loop hops (flaky under parallel suite load).
 * Each test calls persistEntry exactly once after a mockClear, so waiting
 * for release also guarantees no in-flight write bleeds into the next test.
 */
async function flush(): Promise<void> {
  await vi.waitFor(
    () => {
      if (releaseMock.mock.calls.length === 0) throw new Error('write not settled');
    },
    { timeout: 5000, interval: 5 }
  );
  // Let any trailing microtasks (post-release logging) complete.
  await new Promise((r) => setImmediate(r));
}

let ledger: typeof import('../../src/core/audit/ledger-persistence.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
  queryMock.mockImplementation(defaultQueryImpl as any);
  ledger = await import('../../src/core/audit/ledger-persistence.js');
  const ok = await ledger.initLedgerPersistence();
  expect(ok).toBe(true);
});

afterAll(async () => {
  await ledger.closeLedgerPersistence();
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  queryMock.mockClear();
  releaseMock.mockClear();
  queryMock.mockImplementation(defaultQueryImpl as any);
});

describe('persistEntry chain-write platform context pin (incident 2026-06-12)', () => {
  it('issues SET LOCAL app.current_tenant_id = \'\' after BEGIN and before the chain-head read', async () => {
    ledger.persistEntry(makeEntry());
    await flush();

    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    const beginIdx = sqls.findIndex((s) => s === 'BEGIN');
    const pinIdx = sqls.findIndex((s) => /SET LOCAL app\.current_tenant_id\s*=\s*''/i.test(s));
    const headIdx = sqls.findIndex((s) => s.includes('ORDER BY chain_index DESC'));

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(pinIdx).toBeGreaterThan(beginIdx);
    expect(headIdx).toBeGreaterThan(pinIdx);
  });

  it('inserted row params — 23 params, tenant attribution stamped, algo_epoch=2 (Ledger Canonical v2)', async () => {
    ledger.persistEntry(makeEntry({ id: 'tenant-attr-entry', metadata: { tenantId: 'acme' } }));
    await flush();

    const insertCall = queryMock.mock.calls.find(
      (c) =>
        String(c[0]).includes('INSERT INTO forensic_ledger') &&
        (c[1] as any[])[0] === 'tenant-attr-entry'
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as any[];
    expect(params).toHaveLength(23);
    expect(params[0]).toBe('tenant-attr-entry');    // id
    expect(params[1]).toBe(42);                     // chain_index = head + 1
    expect(params[17]).toBe('prev-hash-abc');       // previous_hash = DB head
    expect(params[20]).toBe('acme');                // tenant_id (canonical)
    expect(params[21]).toBe('acme');                // actor_tenant_id (consistent)
    expect(params[22]).toBe(2);                     // algo_epoch = 2 (epoch-2 row)
    expect(queryMock.mock.calls.map((c) => String(c[0]))).toContain('COMMIT');
  });
});

describe('persistEntry 23505 discrimination', () => {
  function rejectInsertWith(err: any): void {
    queryMock.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO forensic_ledger')) {
        return Promise.reject(err);
      }
      return defaultQueryImpl(sql);
    });
  }

  it('23505 on forensic_ledger_chain_index_key logs at error level with operation + chain_index — never silent', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('duplicate key value violates unique constraint "forensic_ledger_chain_index_key"');
    err.code = '23505';
    err.constraint = 'forensic_ledger_chain_index_key';
    rejectInsertWith(err);

    ledger.persistEntry(makeEntry({ operation: 'gate_decision' }));
    await flush();

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('gate_decision');
    expect(logged).toContain('42'); // attempted chain_index
    errSpy.mockRestore();
  });

  it('23505 with missing .constraint is treated as chain-index class — logged at error level', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('duplicate key value violates unique constraint');
    err.code = '23505'; // no .constraint property
    rejectInsertWith(err);

    ledger.persistEntry(makeEntry({ operation: 'mystery_op' }));
    await flush();

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('mystery_op');
    errSpy.mockRestore();
  });

  it('POST-migration-155 (F-5): 23505 on forensic_ledger_pkey is a CHAIN_INDEX collision — LOUD, not swallowed', async () => {
    // After m155 the PK is (chain_index). A forensic_ledger_pkey 23505 is now the
    // silent-loss class (stale head), NOT a benign id dup. The old code returned
    // silently here, hiding dropped state-transition rows. It must log at error.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('duplicate key value violates unique constraint "forensic_ledger_pkey"');
    err.code = '23505';
    err.constraint = 'forensic_ledger_pkey';
    rejectInsertWith(err);

    ledger.persistEntry(makeEntry({ operation: 'classify-decision' }));
    await flush();

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('CHAIN-INDEX COLLISION');
    expect(logged).toContain('classify-decision');
    errSpy.mockRestore();
  });

  it('23505 on a constraint containing entry_hash is benign (true dupe) — no error log', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('duplicate key value violates unique constraint "forensic_ledger_entry_hash_key"');
    err.code = '23505';
    err.constraint = 'forensic_ledger_entry_hash_key';
    rejectInsertWith(err);

    ledger.persistEntry(makeEntry());
    await flush();

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('non-23505 errors still log the generic serialized-write failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err: any = new Error('connection reset');
    err.code = '57P01';
    rejectInsertWith(err);

    ledger.persistEntry(makeEntry());
    await flush();

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('connection reset');
    errSpy.mockRestore();
  });
});

describe('F-5: two state transitions per audit id both persist (no app-layer swallow)', () => {
  it('STARTED and COMPLETED sharing one id both issue INSERTs with correct status', async () => {
    queryMock.mockClear();
    releaseMock.mockClear();
    queryMock.mockImplementation(defaultQueryImpl as any);

    ledger.persistEntry(makeEntry({ id: 'audit-x', status: EntryStatus.STARTED }));
    ledger.persistEntry(makeEntry({ id: 'audit-x', status: EntryStatus.COMPLETED }));

    // Wait for BOTH fire-and-forget writes to settle (each releases its client).
    await vi.waitFor(
      () => { if (releaseMock.mock.calls.length < 2) throw new Error('writes not settled'); },
      { timeout: 5000, interval: 5 }
    );
    await new Promise((r) => setImmediate(r));

    const inserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO forensic_ledger'));
    expect(inserts.length).toBe(2); // NEITHER swallowed — the F-5 bug would have dropped one
    const statuses = inserts.map((c) => (c[1] as any[])[7]).sort(); // $8 status
    expect(statuses).toEqual(['COMPLETED', 'STARTED']);
    // Same audit id on both rows (id is intentionally non-unique now).
    expect((inserts[0][1] as any[])[0]).toBe('audit-x');
    expect((inserts[1][1] as any[])[0]).toBe('audit-x');
  });
});

describe('R-9 schema drift guard: fresh-bootstrap fallback must declare every column persistEntry writes (2026-07-18 live-fire finding)', () => {
  // Live-fire finding (2026-07-18): a real throwaway Postgres bootstrapped
  // ONLY via this module's inline CREATE TABLE + ALTER list (no real
  // migrations applied) silently dropped every single forensic_ledger write
  // — delegated_by/tenant_id/actor_tenant_id were in the INSERT and in
  // migrations 052/110, but missing from both the CREATE fallback and the
  // ALTER upgrade list. Production was unaffected (its schema came from the
  // real migration chain), but a fresh/DR bootstrap using ONLY this file's
  // fallback silently no-op'd the sacrosanct audit trail. This test extracts
  // the actual column set declared by CREATE+ALTER, and the actual column
  // set the real INSERT references, from the REAL SQL strings this module
  // sends (not a hardcoded list a future edit could forget to update), and
  // asserts INSERT-columns ⊆ (CREATE-columns ∪ ALTER-columns). It fails
  // immediately if a future column is added to the INSERT without updating
  // the fallback bootstrap — the exact failure mode the R-9 comment warns
  // about, now enforced instead of just documented.

  function extractCreateTableColumns(sql: string): Set<string> {
    const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
    const columns = new Set<string>();
    for (const line of body.split(',')) {
      const name = line.trim().split(/\s+/)[0];
      if (name) columns.add(name);
    }
    return columns;
  }

  function extractAlterAddedColumn(sql: string): string | null {
    const m = /ADD COLUMN IF NOT EXISTS\s+(\w+)/i.exec(sql);
    return m ? m[1] : null;
  }

  function extractInsertColumns(sql: string): string[] {
    const inside = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'));
    return inside.split(',').map((s) => s.trim()).filter(Boolean);
  }

  it('CREATE TABLE + ALTER list together declare every column the real INSERT writes', async () => {
    queryMock.mockClear();
    releaseMock.mockClear();
    queryMock.mockImplementation(defaultQueryImpl as any);

    // Re-run init to capture ITS bootstrap SQL fresh (beforeEach already
    // wiped the beforeAll-time call history). Safe: connectMock/queryMock
    // are module-shared mocks, re-init just re-sends the same bootstrap SQL.
    const reinitOk = await ledger.initLedgerPersistence();
    expect(reinitOk).toBe(true);

    const bootstrapSqls = queryMock.mock.calls.map((c) => String(c[0]));
    const createSql = bootstrapSqls.find((s) => /CREATE TABLE IF NOT EXISTS forensic_ledger/i.test(s));
    expect(createSql, 'CREATE TABLE fallback must have run during init').toBeDefined();

    const declaredColumns = extractCreateTableColumns(createSql!);
    for (const sql of bootstrapSqls) {
      const added = extractAlterAddedColumn(sql);
      if (added) declaredColumns.add(added);
    }

    // Now capture the REAL INSERT's column list from an actual persistEntry call.
    queryMock.mockClear();
    releaseMock.mockClear();
    queryMock.mockImplementation(defaultQueryImpl as any);
    ledger.persistEntry(makeEntry({ id: 'schema-guard-entry' }));
    await flush();

    const insertSql = queryMock.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('INSERT INTO forensic_ledger'));
    expect(insertSql, 'persistEntry must issue an INSERT').toBeDefined();
    const insertColumns = extractInsertColumns(insertSql!);
    expect(insertColumns.length).toBeGreaterThan(10); // sanity: the extractor actually found columns

    const missing = insertColumns.filter((c) => !declaredColumns.has(c));
    expect(missing, `columns written by INSERT but NOT declared by CREATE+ALTER fallback: ${missing.join(', ')}`).toEqual([]);
  });

  it('specifically: delegated_by, tenant_id, and actor_tenant_id are declared (the exact 2026-07-18 gap)', async () => {
    queryMock.mockClear();
    releaseMock.mockClear();
    queryMock.mockImplementation(defaultQueryImpl as any);
    await ledger.initLedgerPersistence();

    const bootstrapSqls = queryMock.mock.calls.map((c) => String(c[0]));
    const createSql = bootstrapSqls.find((s) => /CREATE TABLE IF NOT EXISTS forensic_ledger/i.test(s))!;
    const declaredColumns = extractCreateTableColumns(createSql);
    for (const sql of bootstrapSqls) {
      const added = extractAlterAddedColumn(sql);
      if (added) declaredColumns.add(added);
    }

    for (const col of ['delegated_by', 'tenant_id', 'actor_tenant_id']) {
      expect(declaredColumns.has(col), `${col} must be declared by the fresh-bootstrap fallback`).toBe(true);
    }
  });
});

describe('F-5: drainPendingWrites flushes in-flight writes before exit', () => {
  it('blocks until a slow INSERT completes, then pendingWriteCount returns to 0', async () => {
    queryMock.mockClear();
    releaseMock.mockClear();

    let releaseInsert: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    queryMock.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO forensic_ledger')) {
        return gate.then(() => ({ rows: [] }));
      }
      return defaultQueryImpl(sql);
    });

    ledger.persistEntry(makeEntry({ id: 'slow-1' }));
    // Let the write IIFE advance to the awaiting INSERT.
    await vi.waitFor(
      () => { if (ledger.pendingWriteCount() < 1) throw new Error('write not registered'); },
      { timeout: 2000, interval: 5 }
    );
    expect(ledger.pendingWriteCount()).toBe(1);

    let drained = false;
    const drainPromise = ledger.drainPendingWrites().then(() => { drained = true; });
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false); // drain is genuinely waiting on the in-flight write

    releaseInsert(); // let the INSERT finish
    await drainPromise;
    expect(drained).toBe(true);
    expect(ledger.pendingWriteCount()).toBe(0);

    queryMock.mockImplementation(defaultQueryImpl as any);
  });
});
