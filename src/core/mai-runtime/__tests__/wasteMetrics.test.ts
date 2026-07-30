import { describe, it, expect } from 'vitest';
import { summarizeWaste } from '../wasteMetrics.js';
import type { EvaluationResult } from '../types.js';

function result(partial: Partial<EvaluationResult> & Pick<EvaluationResult, 'gate' | 'verdict' | 'mai'>): EvaluationResult {
  return {
    rule: partial.rule,
    reason: partial.reason,
    ...partial,
    evidence: {
      actor: 'lane-e',
      actionType: partial.gate === 'delegation' ? 'spawn_subagent' : partial.gate === 'completion' ? 'complete' : 'model_invoke',
      gate: partial.gate,
      verdict: partial.verdict,
      mai: partial.mai,
      tokensEstimated: partial.evidence?.tokensEstimated,
    },
  } as EvaluationResult;
}

const deniedSpawn = result({ gate: 'delegation', verdict: 'DENY', mai: 'MANDATORY', evidence: { tokensEstimated: 60000 } as any });
const invalidCompletion = result({ gate: 'completion', verdict: 'DENY', mai: 'MANDATORY' });
const overBudget = result({ gate: 'budget', verdict: 'DENY', mai: 'MANDATORY', evidence: { tokensEstimated: 20000 } as any });
const advisory = result({ gate: 'budget', verdict: 'ALLOW', mai: 'ADVISORY' });
const allowed = result({ gate: 'budget', verdict: 'ALLOW', mai: 'INFORMATIONAL' });

describe('summarizeWaste — deterministic waste tally', () => {
  it('counts denied spawns, invalid completions, over-budget stops, and advisories', () => {
    const s = summarizeWaste([deniedSpawn, invalidCompletion, overBudget, advisory, allowed]);
    expect(s.deniedSpawns).toBe(1);
    expect(s.invalidCompletions).toBe(1);
    expect(s.overBudgetStops).toBe(1);
    expect(s.advisories).toBe(1);
    expect(s.totalDenied).toBe(3);
    expect(s.totalEvaluated).toBe(5);
  });

  it('estimates tokens saved as the sum of tokensEstimated on denied actions only', () => {
    const s = summarizeWaste([deniedSpawn, overBudget, advisory, allowed]);
    expect(s.tokensSavedEstimate).toBe(80000);
  });

  it('returns zeros for an empty run — no fabricated savings', () => {
    const s = summarizeWaste([]);
    expect(s.totalDenied).toBe(0);
    expect(s.tokensSavedEstimate).toBe(0);
    expect(s.totalEvaluated).toBe(0);
  });
});
