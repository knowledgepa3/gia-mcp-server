import { describe, it, expect } from 'vitest';
import { budgetGate } from '../budgetGate.js';
import type { LanePolicy } from '../types.js';

const policy: LanePolicy = {
  agentId: 'lane-e',
  mission: 'enumerate',
  delegation: { allowed: true, maxSubagents: 4 },
  budget: { maxTokens: 100000, maxToolCalls: 10, maxSubagents: 2, advisoryThresholdPct: 0.8 },
};

describe('budgetGate — Gate #3: no unlimited spend without progress', () => {
  it('DENIES an action that would exceed the token cap (MANDATORY stop)', () => {
    const v = budgetGate({ type: 'model_invoke', tokensEstimated: 20000 }, policy, { subagentsSpawned: 0, tokensSpent: 90000 });
    expect(v.verdict).toBe('DENY');
    expect(v.mai).toBe('MANDATORY');
    expect(v.rule).toBe('TOKEN_BUDGET_EXCEEDED');
  });

  it('emits ADVISORY when projected spend crosses the threshold but stays under cap', () => {
    const v = budgetGate({ type: 'model_invoke', tokensEstimated: 5000 }, policy, { subagentsSpawned: 0, tokensSpent: 80000 });
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('ADVISORY');
  });

  it('allows (INFORMATIONAL) an action well under budget', () => {
    const v = budgetGate({ type: 'model_invoke', tokensEstimated: 5000 }, policy, { subagentsSpawned: 0, tokensSpent: 10000 });
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('INFORMATIONAL');
  });

  it('DENIES a tool_call that would exceed the tool-call cap', () => {
    const v = budgetGate({ type: 'tool_call' }, policy, { subagentsSpawned: 0, toolCallsMade: 10 });
    expect(v.verdict).toBe('DENY');
    expect(v.rule).toBe('TOOLCALL_BUDGET_EXCEEDED');
  });

  it('DENIES a spawn_subagent that would exceed the subagent budget cap', () => {
    const v = budgetGate({ type: 'spawn_subagent' }, policy, { subagentsSpawned: 2 });
    expect(v.verdict).toBe('DENY');
    expect(v.rule).toBe('SUBAGENT_BUDGET_EXCEEDED');
  });

  it('with no budget policy set, allows anything (nothing to enforce)', () => {
    const v = budgetGate(
      { type: 'model_invoke', tokensEstimated: 999999 },
      { agentId: 'lane-x', mission: 'x', delegation: { allowed: true, maxSubagents: 0 } },
      { subagentsSpawned: 0 },
    );
    expect(v.verdict).toBe('ALLOW');
  });
});
