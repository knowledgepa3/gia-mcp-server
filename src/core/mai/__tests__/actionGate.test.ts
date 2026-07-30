import { describe, it, expect, vi } from 'vitest';
import { enforceActionGate } from '../actionGate.js';
import { MaiClassification } from '../../../shared/types.js';

function fakeEngine() {
  const entry = { id: 'audit-1', addMetadata: vi.fn(), complete: vi.fn(() => ({})) };
  return {
    ledger: { begin: vi.fn(() => entry), record: vi.fn() },
    gate: { enforce: vi.fn(() => Promise.resolve()), getPendingApprovals: vi.fn(() => []) },
  } as any;
}

describe('enforceActionGate — informational', () => {
  it('allows a read and does NOT register a gate', () => {
    const engine = fakeEngine();
    const res = enforceActionGate(engine, { actor: 'a', tool: 'system_status', verb: 'read' });
    expect(res.allowed).toBe(true);
    expect(res.classification).toBe(MaiClassification.INFORMATIONAL);
    expect(engine.gate.enforce).not.toHaveBeenCalled();
    expect(engine.ledger.record).toHaveBeenCalled();
  });
});

describe('enforceActionGate — mandatory', () => {
  it('blocks a ledger deletion and registers a gate via the proven fire-and-forget pattern', () => {
    const engine = fakeEngine();
    engine.gate.getPendingApprovals = vi.fn(() => [{ gateId: 'gate-xyz' }]);
    const res = enforceActionGate(engine, { actor: 'a', tool: 'db_exec', resource: 'forensic_ledger', verb: 'delete' });
    expect(res.allowed).toBe(false);
    expect(res.classification).toBe(MaiClassification.MANDATORY);
    expect(res.gateId).toBe('gate-xyz');
    expect(engine.gate.enforce).toHaveBeenCalledOnce();
  });
});
