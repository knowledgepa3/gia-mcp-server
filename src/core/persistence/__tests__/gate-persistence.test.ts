/**
 * @module    gate-persistence.test
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Root-cause regression test for the 2026-07-17 live incident: a customer's
 * multi-agent managed-run orchestration produced a MANDATORY gate that was
 * force-timed-out ~2 minutes after being requested, rationale "Server
 * restarted — pending gate expired (stale session)" — while the container
 * had NOT restarted. Root cause: cleanupStaleGates() runs inside every
 * GovernanceEngine.initialize() call, and this process legitimately builds
 * MULTIPLE concurrent engines (dashboard + one per tenant on /mcp + one per
 * tenant on /mcp/agent — server-http.ts). Each fresh engine's cleanup swept
 * ANY still-open gate not in its OWN empty in-memory map — including gates
 * actively held by a SIBLING engine in the SAME live process — and marked it
 * TIMED_OUT. 140 fresh engine constructions were observed live in a single
 * 22-minute window (vs. zero in an earlier idle baseline), directly tied to
 * MCP tenant-session reconnect churn.
 *
 * Fix: cleanupStaleGates() now runs its DB mutation at most once per process
 * lifetime (a module-level guard). Real orphan cleanup — gates truly
 * abandoned by a PREVIOUS process that crashed — still runs exactly once, on
 * this process's first engine construction; the guard resets naturally on
 * every real restart because it lives in process memory, not the DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake pg Pool — enough surface for gate-persistence.ts's calls: connect(),
// query() (both via the pool directly and via a checked-out client), and the
// throwaway existence-probe query pattern used by initGatePersistence().
function makeFakePool() {
  const queryLog: string[] = [];
  const fakeClient = {
    query: vi.fn(async (sql: string) => {
      queryLog.push(sql);
      if (/SELECT 1 FROM gate_approvals_persistent/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => fakeClient),
    query: vi.fn(async (sql: string) => {
      queryLog.push(sql);
      if (/UPDATE gate_approvals_persistent SET\s+status = 'TIMED_OUT'/.test(sql)) {
        return { rows: [{ gate_id: 'gate-stale-orphan' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool, fakeClient, queryLog };
}

describe('cleanupStaleGates — process-lifetime guard (2026-07-17 incident fix)', () => {
  let fake: ReturnType<typeof makeFakePool>;

  beforeEach(async () => {
    vi.resetModules();
    fake = makeFakePool();
    vi.doMock('pg', () => ({ Pool: vi.fn(() => fake.pool) }));
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  });

  afterEach(() => {
    vi.doUnmock('pg');
    delete process.env.DATABASE_URL;
  });

  /*
    2026-07-26 INCIDENT — the age floor. A genuine restart 0.7s after a gate was
    created ran this cleanup, and it took the gate: created 15:17:51, TIMED_OUT
    15:17:57, rationale "Server restarted". A MANDATORY gate resolved itself
    without a human and stranded managed run 9d8b6b23 permanently.

    The 2026-07-17 process guard could not prevent it — that guard lives in
    process memory SO THAT it resets on a real restart, and this was a real
    restart. The missing predicate was an age floor: the query would take a gate
    born one second ago and call it abandoned by a previous session.
  */
  it('REFUSES to reap a gate younger than the approval window — a fresh gate is not an orphan', async () => {
    const mod = await import('../gate-persistence.js');
    await mod.initGatePersistence();
    await mod.cleanupStaleGates();

    const reap = fake.queryLog.find((sql) => /status = 'TIMED_OUT'/.test(sql));
    expect(reap, 'the reap query must have run').toBeTruthy();
    // The age floor is what makes "abandoned by a previous session" a true
    // statement rather than a guess. Without it the sweep is unbounded.
    expect(reap).toMatch(/created_at\s*<\s*NOW\(\)\s*-/);
  });

  it('does not assert a cause it never verified — no "Server restarted" in the rationale', async () => {
    const mod = await import('../gate-persistence.js');
    await mod.initGatePersistence();
    await mod.cleanupStaleGates();

    // This cleanup knows only that it is booting; it does not check whether a
    // restart occurred. The old text stated one as fact, and that false
    // rationale is what sent the 2026-07-26 investigation at the wrong container.
    const params = fake.pool.query.mock.calls
      .map((c: unknown[]) => c[1])
      .filter(Boolean)
      .flat() as string[];
    expect(params.join(' ')).not.toMatch(/Server restarted/i);
    expect(params.join(' ')).toMatch(/No decision recorded/i);
  });

  it('runs the stale-gate reap on the first call after init', async () => {
    const mod = await import('../gate-persistence.js');
    const ok = await mod.initGatePersistence();
    expect(ok).toBe(true);

    const count = await mod.cleanupStaleGates();
    expect(count).toBe(1);

    const reapCalls = fake.queryLog.filter((sql) => /status = 'TIMED_OUT'/.test(sql));
    expect(reapCalls).toHaveLength(1);
  });

  it('does NOT re-run the reap on a second call within the same process — this is the exact bug: a second GovernanceEngine construction in the same running process must never re-sweep and kill a sibling engine\'s live pending gate', async () => {
    const mod = await import('../gate-persistence.js');
    await mod.initGatePersistence();

    const first = await mod.cleanupStaleGates();
    const second = await mod.cleanupStaleGates();
    const third = await mod.cleanupStaleGates();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(third).toBe(0);

    const reapCalls = fake.queryLog.filter((sql) => /status = 'TIMED_OUT'/.test(sql));
    expect(reapCalls).toHaveLength(1); // the DB mutation itself only ever fired once
  });

  it('does not throw or double-reap under concurrent callers (simulates orchestrator + workers all connecting at once)', async () => {
    const mod = await import('../gate-persistence.js');
    await mod.initGatePersistence();

    const results = await Promise.all([
      mod.cleanupStaleGates(),
      mod.cleanupStaleGates(),
      mod.cleanupStaleGates(),
    ]);

    // Exactly one of the concurrent callers observes the real reap count;
    // the rest see 0 because the guard is set synchronously before any await.
    expect(results.filter((n) => n === 1)).toHaveLength(1);
    expect(results.filter((n) => n === 0)).toHaveLength(2);

    const reapCalls = fake.queryLog.filter((sql) => /status = 'TIMED_OUT'/.test(sql));
    expect(reapCalls).toHaveLength(1);
  });

  it('a fresh process (new module instance) reaps again — real restarts still clean up genuine orphans', async () => {
    const mod1 = await import('../gate-persistence.js');
    await mod1.initGatePersistence();
    expect(await mod1.cleanupStaleGates()).toBe(1);
    expect(await mod1.cleanupStaleGates()).toBe(0); // guarded within this "process"

    // Simulate a real container restart: fresh module graph, fresh pool.
    vi.resetModules();
    const fake2 = makeFakePool();
    vi.doMock('pg', () => ({ Pool: vi.fn(() => fake2.pool) }));
    const mod2 = await import('../gate-persistence.js');
    await mod2.initGatePersistence();
    expect(await mod2.cleanupStaleGates()).toBe(1); // fresh process, guard reset, real orphans still reaped
  });

  it('never runs the reap when persistence is disabled (no DATABASE_URL)', async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    const mod = await import('../gate-persistence.js');
    const ok = await mod.initGatePersistence();
    expect(ok).toBe(false);
    expect(await mod.cleanupStaleGates()).toBe(0);
    expect(await mod.cleanupStaleGates()).toBe(0);
  });
});
