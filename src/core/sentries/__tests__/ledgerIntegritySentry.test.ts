/**
 * @module    ledger-integrity-sentry.test
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Tests for the Ledger Integrity Sentry.
 *
 * Strategy: use a real GovernanceEngine (in-memory, no DATABASE_URL) so the
 * in-memory ForensicLedger is the actual store.  We await the async sentry
 * methods directly (no setImmediate needed — unlike fire-and-forget helpers,
 * runIncremental() and runFull() are awaitable).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { GovernanceEngine } from '../../governance.js';
import { EntryStatus, MaiClassification } from '../../../shared/types.js';
import { LedgerIntegritySentry } from '../ledgerIntegritySentry.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal GovernanceEngine with no DATABASE_URL so it runs
// fully in-memory (the persistence layer gracefully degrades).
// ---------------------------------------------------------------------------

async function makeEngine(): Promise<GovernanceEngine> {
  const engine = new GovernanceEngine();
  engine.enableAutoRun(); // auto-approve all gates so init doesn't block
  await engine.initialize();
  return engine;
}

// ============================================================================
// 1. runIncremental() on clean chain → NO LEDGER_INTEGRITY_BROKEN entry written
// ============================================================================

describe('LedgerIntegritySentry.runIncremental — clean chain', () => {
  let engine: GovernanceEngine;
  let sentry: LedgerIntegritySentry;

  beforeAll(async () => {
    engine = await makeEngine();
    sentry = new LedgerIntegritySentry(engine);
  });

  it('writes no LEDGER_INTEGRITY_BROKEN entry when chain is valid', async () => {
    const beforeCount = engine.ledger.queryByOperation('LEDGER_INTEGRITY_BROKEN').length;

    await sentry.runIncremental();

    const afterCount = engine.ledger.queryByOperation('LEDGER_INTEGRITY_BROKEN').length;
    expect(afterCount).toBe(beforeCount);
  });
});

// ============================================================================
// 2. runIncremental() with broken chain → LEDGER_INTEGRITY_BROKEN entry written
// ============================================================================

describe('LedgerIntegritySentry.runIncremental — broken chain', () => {
  let engine: GovernanceEngine;
  let sentry: LedgerIntegritySentry;

  beforeAll(async () => {
    engine = await makeEngine();
    sentry = new LedgerIntegritySentry(engine);
  });

  it('writes LEDGER_INTEGRITY_BROKEN with firstBrokenLink=40 when verifyChain returns invalid', async () => {
    vi.spyOn(engine.ledger, 'verifyChain').mockReturnValue({
      valid: false,
      firstBrokenLink: 40,
      headHash: 'abc',
      entriesVerified: 42,
      breakDetail: 'hash mismatch at 40',
      verifiedAt: new Date(),
      verificationDurationMs: 5,
    });

    try {
      await sentry.runIncremental();

      const entries = engine.ledger.queryByOperation('LEDGER_INTEGRITY_BROKEN');
      expect(entries.length).toBeGreaterThan(0);

      const entry = entries.find(
        (e) => e.metadata['firstBrokenLink'] === 40 && e.status === EntryStatus.COMPLETED
      );
      expect(entry).toBeDefined();
      expect(entry!.maiLevel).toBe(MaiClassification.MANDATORY);
      expect(entry!.metadata['firstBrokenLink']).toBe(40);
      expect(entry!.metadata['chainHead']).toBe('abc');
      expect(entry!.actor).toBe('system:ledger-integrity');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ============================================================================
// 3. runFull() on clean chain → LEDGER_INTEGRITY_CHECK / INTACT entry written
// ============================================================================

describe('LedgerIntegritySentry.runFull — clean chain', () => {
  let engine: GovernanceEngine;
  let sentry: LedgerIntegritySentry;

  beforeAll(async () => {
    engine = await makeEngine();
    sentry = new LedgerIntegritySentry(engine);
  });

  it('writes LEDGER_INTEGRITY_CHECK with result=INTACT when chain is valid', async () => {
    await sentry.runFull();

    const entries = engine.ledger.queryByOperation('LEDGER_INTEGRITY_CHECK');
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries.find(
      (e) => e.metadata['result'] === 'INTACT' && e.status === EntryStatus.COMPLETED
    );
    expect(entry).toBeDefined();
    expect(entry!.maiLevel).toBe(MaiClassification.INFORMATIONAL);
    expect(entry!.metadata['result']).toBe('INTACT');
    expect(entry!.actor).toBe('system:ledger-integrity');
  });
});

// ============================================================================
// 4. runIncremental() where verifyChain throws → SENTRY_ERROR entry written
// ============================================================================

describe('LedgerIntegritySentry.runIncremental — verifyChain throws', () => {
  let engine: GovernanceEngine;
  let sentry: LedgerIntegritySentry;

  beforeAll(async () => {
    engine = await makeEngine();
    sentry = new LedgerIntegritySentry(engine);
  });

  it('writes SENTRY_ERROR with sentry=ledger-integrity when verifyChain throws', async () => {
    vi.spyOn(engine.ledger, 'verifyChain').mockImplementation(() => {
      throw new Error('simulated verification failure');
    });

    try {
      await sentry.runIncremental();

      const entries = engine.ledger.queryByOperation('SENTRY_ERROR');
      expect(entries.length).toBeGreaterThan(0);

      const entry = entries.find(
        (e) => e.metadata['sentry'] === 'ledger-integrity' && e.status === EntryStatus.COMPLETED
      );
      expect(entry).toBeDefined();
      expect(entry!.metadata['sentry']).toBe('ledger-integrity');
      expect(entry!.metadata['error']).toBe('simulated verification failure');
      expect(entry!.maiLevel).toBe(MaiClassification.ADVISORY);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
