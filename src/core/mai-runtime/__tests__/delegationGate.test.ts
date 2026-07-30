import { describe, it, expect } from 'vitest';
import { delegationGate } from '../delegationGate.js';
import type { LanePolicy } from '../types.js';

const denyPolicy: LanePolicy = {
  agentId: 'lane-e',
  mission: 'enumerate',
  delegation: { allowed: false, maxSubagents: 0 },
};

const allowPolicy: LanePolicy = {
  agentId: 'lane-x',
  mission: 'research',
  delegation: { allowed: true, maxSubagents: 3 },
};

describe('delegationGate — Gate #2, the Lane E incident', () => {
  it('DENIES spawn_subagent when the lane policy forbids delegation (authority laundering)', () => {
    const v = delegationGate({ type: 'spawn_subagent' }, denyPolicy, { subagentsSpawned: 0 });
    expect(v.verdict).toBe('DENY');
    expect(v.mai).toBe('MANDATORY');
    expect(v.rule).toBe('NO_DELEGATION_WITHOUT_AUTHORITY');
  });

  it('ALLOWS spawn_subagent when delegation is authorized and under the subagent cap', () => {
    const v = delegationGate({ type: 'spawn_subagent' }, allowPolicy, { subagentsSpawned: 0 });
    expect(v.verdict).toBe('ALLOW');
  });

  it('DENIES spawn_subagent when authorized but the subagent cap is already reached', () => {
    const v = delegationGate({ type: 'spawn_subagent' }, allowPolicy, { subagentsSpawned: 3 });
    expect(v.verdict).toBe('DENY');
    expect(v.mai).toBe('MANDATORY');
    expect(v.rule).toBe('SUBAGENT_CAP_REACHED');
  });

  it('ALLOWS a non-delegation action (tool_call) regardless of delegation policy', () => {
    const v = delegationGate({ type: 'tool_call' }, denyPolicy, { subagentsSpawned: 0 });
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('INFORMATIONAL');
  });

  it('treats a delegate action the same as spawn_subagent', () => {
    const v = delegationGate({ type: 'delegate' }, denyPolicy, { subagentsSpawned: 0 });
    expect(v.verdict).toBe('DENY');
  });
});
