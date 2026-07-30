// gia-mcp-server/tests/mcp/toolClassifications.test.ts
import { describe, it, expect } from 'vitest';
import { TOOL_CLASSIFICATIONS, resolveClassification, ToolClassificationEntry } from '../../src/mcp/toolClassifications.js';
import { MaiClassification } from '../../src/shared/types.js';

describe('TOOL_CLASSIFICATIONS', () => {
  it('has exactly 57 entries', () => {
    expect(Object.keys(TOOL_CLASSIFICATIONS)).toHaveLength(57);
  });

  it('promote_memory_pack is MANDATORY and selfEnforces', () => {
    expect(TOOL_CLASSIFICATIONS['promote_memory_pack']).toEqual({ mai: MaiClassification.MANDATORY, selfEnforces: true });
  });

  it('approve_gate is MANDATORY and isGateResolver (never wrapper-gated)', () => {
    expect(TOOL_CLASSIFICATIONS['approve_gate']).toEqual({ mai: MaiClassification.MANDATORY, isGateResolver: true });
  });

  it('classify_decision is INFORMATIONAL', () => {
    expect(TOOL_CLASSIFICATIONS['classify_decision']).toEqual({ mai: MaiClassification.INFORMATIONAL });
  });

  it('seal_memory_pack is CONDITIONAL and resolves MANDATORY at SYSTEM/ORG trust, ADVISORY otherwise', () => {
    const entry = TOOL_CLASSIFICATIONS['seal_memory_pack'];
    expect(entry.mai).toBe('CONDITIONAL');
    expect(resolveClassification(entry, { trust_level: 'SYSTEM' })).toBe(MaiClassification.MANDATORY);
    expect(resolveClassification(entry, { trust_level: 'ORG' })).toBe(MaiClassification.MANDATORY);
    expect(resolveClassification(entry, { trust_level: 'CASE' })).toBe(MaiClassification.ADVISORY);
    expect(resolveClassification(entry, { trust_level: 'EPHEMERAL' })).toBe(MaiClassification.ADVISORY);
  });

  it('a non-conditional entry resolves to its own mai regardless of input', () => {
    const entry = TOOL_CLASSIFICATIONS['system_status'];
    expect(resolveClassification(entry, {})).toBe(MaiClassification.INFORMATIONAL);
  });

  it('a CONDITIONAL entry with no resolve() throws', () => {
    const brokenEntry: ToolClassificationEntry = { mai: 'CONDITIONAL' };
    expect(() => resolveClassification(brokenEntry, {})).toThrow('CONDITIONAL classification entry missing resolve()');
  });
});
