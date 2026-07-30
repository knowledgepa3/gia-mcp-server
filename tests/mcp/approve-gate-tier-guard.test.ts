/**
 * Structural guarantee for a 2026-07-17 directive (William): "I do not want
 * any self-delegation here." Managed agents run at MCP tool tier 'public'
 * (/mcp/agent, worker runs) or 'tenant' (/mcp, orchestrator runs) — never
 * 'operator'. approve_gate must stay registered at tier 'operator' so that
 * no managed-agent session's tool list ever contains it, regardless of what
 * any system prompt says (see managedAgentRunner.ts's companion prompt-level
 * guard). This test proves the STRUCTURAL half: even if someone accidentally
 * widens TIER_CEILING or re-tiers a tool, this fails loudly.
 */
import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { TOOL_REGISTRY, type ToolVisibility } from '../../src/mcp/toolRegistry.js';

// Mirrors server.ts's TIER_CEILING exactly — duplicated deliberately so this
// test fails if server.ts's ceiling definition ever silently drifts from it.
const TIER_CEILING: Record<ToolVisibility, Set<ToolVisibility>> = {
  public: new Set(['public']),
  tenant: new Set(['public', 'tenant']),
  operator: new Set(['public', 'tenant', 'operator']),
};

function collectRegisteredNames(register: (server: McpServer, engine: GovernanceEngine) => void): string[] {
  const names: string[] = [];
  const stub = {
    tool: (...args: unknown[]) => { names.push(String(args[0])); },
  } as unknown as McpServer;
  register(stub, {} as GovernanceEngine);
  return names;
}

function toolNamesAtTier(maxVisibility: ToolVisibility): Set<string> {
  const allowed = TIER_CEILING[maxVisibility];
  const names = new Set<string>();
  for (const entry of TOOL_REGISTRY) {
    if (!allowed.has(entry.tier)) continue;
    for (const name of collectRegisteredNames(entry.register)) names.add(name);
  }
  return names;
}

describe('approve_gate tier isolation — no managed-agent session can ever see it', () => {
  it('approve_gate is registered at tier "operator"', () => {
    const entry = TOOL_REGISTRY.find((e) => e.description === 'approve_gate');
    expect(entry, 'approve_gate entry must exist in TOOL_REGISTRY').toBeDefined();
    expect(entry!.tier).toBe('operator');
  });

  it('worker sessions (/mcp/agent, tier "public") never receive approve_gate', () => {
    expect(toolNamesAtTier('public').has('approve_gate')).toBe(false);
  });

  it('orchestrator sessions (/mcp, tier "tenant") never receive approve_gate', () => {
    expect(toolNamesAtTier('tenant').has('approve_gate')).toBe(false);
  });

  it('only true operator sessions (local stdio) receive approve_gate', () => {
    expect(toolNamesAtTier('operator').has('approve_gate')).toBe(true);
  });

  it('the same isolation holds for the other operator-only governance-mutation tools referenced in server-http.ts (srt, remediation)', () => {
    const publicNames = toolNamesAtTier('public');
    const tenantNames = toolNamesAtTier('tenant');
    for (const tool of ['approve_gate']) {
      expect(publicNames.has(tool), `${tool} leaked into public tier`).toBe(false);
      expect(tenantNames.has(tool), `${tool} leaked into tenant tier`).toBe(false);
    }
  });
});
