import { describe, it, expect } from 'vitest';
import { classifyAction, type ActionDescriptor } from '../actionRules.js';
import { MaiClassification } from '../../../shared/types.js';

const base: ActionDescriptor = { actor: 'agent-x', tool: 'noop' };

describe('classifyAction — ledger protection', () => {
  it('flags any delete/update against forensic_ledger as MANDATORY', () => {
    const r = classifyAction({ ...base, tool: 'db_exec', resource: 'forensic_ledger', verb: 'delete' });
    expect(r.classification).toBe(MaiClassification.MANDATORY);
    expect(r.reason).toMatch(/forensic ledger/i);
  });

  it('does NOT depend on caller danger flags — the resource+verb alone decides', () => {
    const r = classifyAction({ actor: 'anyone', tool: 'anything', resource: 'forensic_ledger', verb: 'drop' });
    expect(r.classification).toBe(MaiClassification.MANDATORY);
  });
});

describe('classifyAction — high-impact actions', () => {
  it('self-repair execution is MANDATORY', () => {
    expect(classifyAction({ actor: 'srt', tool: 'srt_approve_repair', verb: 'execute' }).classification)
      .toBe(MaiClassification.MANDATORY);
  });
  it('deploy is MANDATORY', () => {
    expect(classifyAction({ actor: 'ci', tool: 'deploy', verb: 'deploy' }).classification)
      .toBe(MaiClassification.MANDATORY);
  });
  it('charter seal/modify is MANDATORY', () => {
    expect(classifyAction({ actor: 'a', tool: 'seal_memory_pack', resource: 'charter', verb: 'write' }).classification)
      .toBe(MaiClassification.MANDATORY);
  });
  it('unknown destructive tool falls back to ADVISORY, never INFORMATIONAL', () => {
    expect(classifyAction({ actor: 'a', tool: 'mystery', destructive: true }).classification)
      .toBe(MaiClassification.ADVISORY);
  });
  it('a plain read is INFORMATIONAL', () => {
    expect(classifyAction({ actor: 'a', tool: 'system_status', verb: 'read' }).classification)
      .toBe(MaiClassification.INFORMATIONAL);
  });
});
