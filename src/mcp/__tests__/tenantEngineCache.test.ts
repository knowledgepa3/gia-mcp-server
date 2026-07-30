import { describe, it, expect, vi } from 'vitest';
import { getOrCreateTenantEngine } from '../tenantEngineCache.js';

/**
 * ONE GovernanceEngine per tenant, shared by BOTH MCP tiers.
 *
 * Every GovernanceEngine builds its own ForensicLedger and hydrates the whole
 * chain into its own heap, so the previous split (one cache per tier) made a
 * single tenant pay the ledger TWICE — 216-248MiB of a 256MiB cap, observed on
 * prod 2026-07-29.
 *
 * The per-tenant KEY is a governance boundary, not an optimisation (William's
 * call, 2026-07-29). Test 3 exists to stop a future refactor widening it.
 */
describe('tenantEngineCache', () => {
  // Note: the cache is a module-level singleton with no reset export (by
  // design — see test 5), so each test below uses its OWN tenant id to stay
  // isolated from other tests' cache entries.

  it('constructs the engine once and shares it across both tiers', async () => {
    const engine = { id: 'engine-shared' } as any;
    const factory = vi.fn(async () => engine);

    const first = await getOrCreateTenantEngine('tenant-shared', factory);
    const second = await getOrCreateTenantEngine('tenant-shared', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('coalesces concurrent requests for the same tenant onto one construction', async () => {
    let resolveFactory!: (engine: any) => void;
    const engine = { id: 'engine-concurrent' } as any;
    const factory = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveFactory = resolve;
        }),
    );

    // Fire both without awaiting the first.
    const p1 = getOrCreateTenantEngine('tenant-concurrent', factory);
    const p2 = getOrCreateTenantEngine('tenant-concurrent', factory);

    expect(factory).toHaveBeenCalledTimes(1);

    resolveFactory(engine);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  // THE GOVERNANCE BOUNDARY: a process-wide engine would seed one tenant's
  // StoreyThresholdMonitor from another tenant's classifications — leakage,
  // and corruption of the Chain of Reasoning as an audit identity. A refactor
  // that keys the cache by a constant instead of tenantId must turn this red.
  it('isolates engines per tenant — t1 and t2 never share an engine', async () => {
    const engineT1 = { id: 'engine-isolate-t1' } as any;
    const engineT2 = { id: 'engine-isolate-t2' } as any;
    const factory1 = vi.fn(async () => engineT1);
    const factory2 = vi.fn(async () => engineT2);

    const t1 = await getOrCreateTenantEngine('tenant-isolate-1', factory1);
    const t2 = await getOrCreateTenantEngine('tenant-isolate-2', factory2);

    expect(t1).not.toBe(t2);
  });

  it('does not cache a rejected construction, so the next call retries and can succeed', async () => {
    const engine = { id: 'engine-retry' } as any;
    const failingFactory = vi.fn(async () => {
      throw new Error('construction failed');
    });
    const succeedingFactory = vi.fn(async () => engine);

    await expect(getOrCreateTenantEngine('tenant-retry', failingFactory)).rejects.toThrow(
      'construction failed',
    );

    const result = await getOrCreateTenantEngine('tenant-retry', succeedingFactory);

    expect(succeedingFactory).toHaveBeenCalledTimes(1);
    expect(result).toBe(engine);
  });

  // Guards the 2026-07-17 gate-reaping incident: a per-reconnect engine once
  // reaped a customer's live MANDATORY gate. The engine must survive
  // session/transport churn — the cache module exposes no session-scoped
  // eviction hook at all, only per-tenant get-or-create.
  it('exposes no per-session eviction — the engine is never torn down on session close', async () => {
    const cacheModule = await import('../tenantEngineCache.js');
    const exportNames = Object.keys(cacheModule);

    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toMatch(/delete|evict|remove|close|teardown/);
    }
  });
});
