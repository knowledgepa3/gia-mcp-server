import { describe, it, expect } from 'vitest';
import { evaluateAction } from '../evaluator.js';
import type { LanePolicy } from '../types.js';

const lockedDown: LanePolicy = {
  agentId: 'lane-e',
  mission: 'enumerate',
  delegation: { allowed: false, maxSubagents: 0 },
  budget: { maxTokens: 100000, maxToolCalls: 60, advisoryThresholdPct: 0.8 },
  completion: { requiredArtifactFields: ['findings'] },
};

const permissive: LanePolicy = {
  ...lockedDown,
  delegation: { allowed: true, maxSubagents: 2 },
};

describe('evaluateAction — orders the gates and emits evidence', () => {
  it('blocks an unauthorized spawn at the delegation gate (before budget)', () => {
    const v = evaluateAction({ type: 'spawn_subagent' }, lockedDown, { subagentsSpawned: 0 });
    expect(v.verdict).toBe('DENY');
    expect(v.gate).toBe('delegation');
    expect(v.mai).toBe('MANDATORY');
  });

  it('blocks a status-only completion at the completion gate', () => {
    const v = evaluateAction(
      { type: 'complete', text: "I've kicked off a background research agent" },
      lockedDown,
      { subagentsSpawned: 0 },
    );
    expect(v.verdict).toBe('DENY');
    expect(v.gate).toBe('completion');
    expect(v.rule).toBe('PREMATURE_DELEGATION_STOP');
  });

  it('allows an authorized tool_call under budget as INFORMATIONAL', () => {
    const v = evaluateAction({ type: 'tool_call', tokensEstimated: 1000 }, permissive, { subagentsSpawned: 0, tokensSpent: 0, toolCallsMade: 0 });
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('INFORMATIONAL');
  });

  it('surfaces a budget ADVISORY when a permitted action nears the cap', () => {
    const v = evaluateAction({ type: 'model_invoke', tokensEstimated: 5000 }, permissive, { subagentsSpawned: 0, tokensSpent: 80000 });
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('ADVISORY');
    expect(v.gate).toBe('budget');
  });

  it('emits an evidence record with actor, action, gate, verdict, and MAI', () => {
    const v = evaluateAction({ type: 'spawn_subagent' }, lockedDown, { subagentsSpawned: 0 });
    expect(v.evidence).toMatchObject({
      actor: 'lane-e',
      actionType: 'spawn_subagent',
      gate: 'delegation',
      verdict: 'DENY',
      mai: 'MANDATORY',
      rule: 'NO_DELEGATION_WITHOUT_AUTHORITY',
    });
  });
});
