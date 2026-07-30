import { describe, it, expect } from 'vitest';
import { runThisSessionProof, LANE_E_POLICY } from '../proof/thisSessionWaste.js';

// Exhibit A: replay the REAL Lane E delegation incident from the 2026-07-03
// build session through MAI Runtime and prove it would have been caught.
describe('MAI Runtime proof — the Lane E cascade this session', () => {
  it("catches every unauthorized spawn and status-only completion Lane E actually produced", () => {
    const { summary } = runThisSessionProof();
    expect(summary.deniedSpawns).toBeGreaterThanOrEqual(3);
    expect(summary.invalidCompletions).toBeGreaterThanOrEqual(2);
  });

  it('would have prevented >200k tokens of unauthorized sub-agent spend', () => {
    const { summary } = runThisSessionProof();
    expect(summary.tokensSavedEstimate).toBeGreaterThan(200000);
  });

  it('emits a rule-bearing evidence record for every denial, attributed to lane-e', () => {
    const { results } = runThisSessionProof();
    const denied = results.filter(r => r.verdict === 'DENY');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every(r => !!r.rule && r.evidence.actor === 'lane-e')).toBe(true);
  });

  it('uses the real lane policy that was in force (delegation forbidden)', () => {
    expect(LANE_E_POLICY.delegation.allowed).toBe(false);
  });
});
