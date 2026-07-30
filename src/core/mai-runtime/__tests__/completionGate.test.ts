import { describe, it, expect } from 'vitest';
import { completionGate } from '../completionGate.js';
import type { LanePolicy } from '../types.js';

const policy: LanePolicy = {
  agentId: 'lane-e',
  mission: 'enumerate',
  delegation: { allowed: false, maxSubagents: 0 },
  completion: { requiredArtifactFields: ['findings', 'sources', 'openQuestions'] },
};

describe('completionGate — Gate #6: status is not completion', () => {
  it('rejects a status-only completion that claims delegated work (PREMATURE_DELEGATION_STOP)', () => {
    const v = completionGate(
      { type: 'complete', text: "I've kicked off a background research agent and will report the full table when it completes." },
      policy,
    );
    expect(v.verdict).toBe('DENY');
    expect(v.mai).toBe('MANDATORY');
    expect(v.rule).toBe('PREMATURE_DELEGATION_STOP');
  });

  it('rejects an artifact missing a required field (INCOMPLETE_ARTIFACT)', () => {
    const v = completionGate(
      { type: 'complete', artifact: { findings: ['a'], sources: ['b'] } }, // no openQuestions
      policy,
    );
    expect(v.verdict).toBe('DENY');
    expect(v.rule).toBe('INCOMPLETE_ARTIFACT');
  });

  it('rejects an artifact whose required field is present but empty', () => {
    const v = completionGate(
      { type: 'complete', artifact: { findings: [], sources: ['b'], openQuestions: ['c'] } },
      policy,
    );
    expect(v.verdict).toBe('DENY');
    expect(v.rule).toBe('INCOMPLETE_ARTIFACT');
  });

  it('accepts an artifact that satisfies every required field', () => {
    const v = completionGate(
      { type: 'complete', artifact: { findings: ['a'], sources: ['b'], openQuestions: ['none'] } },
      policy,
    );
    expect(v.verdict).toBe('ALLOW');
    expect(v.mai).toBe('INFORMATIONAL');
  });

  it('ALLOWS a non-complete action (that is another gate’s concern)', () => {
    const v = completionGate({ type: 'tool_call' }, policy);
    expect(v.verdict).toBe('ALLOW');
  });

  it('with no completion policy set, accepts any completion (nothing to enforce)', () => {
    const v = completionGate(
      { type: 'complete', artifact: {} },
      { agentId: 'lane-x', mission: 'x', delegation: { allowed: true, maxSubagents: 2 } },
    );
    expect(v.verdict).toBe('ALLOW');
  });
});
