/**
 * @module    test-promote-memory-pack-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for a governance-integrity bug found during the
 * 2026-07-14 MCP enforcement audit: promote_memory_pack persisted its
 * mutation (revoke old pack + write promoted pack) BEFORE awaiting the
 * MANDATORY gate decision. A rejected/timed-out gate returned isError to
 * the caller but never undid the write — a MANDATORY-labeled gate that
 * didn't actually gate anything.
 *
 * These tests prove the invariant from the caller's observable surface
 * only (seal + promote), not by poking internal module state: a gate
 * that does not resolve APPROVED must leave the original pack fully
 * promotable on a later, actually-approved attempt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerSealMemoryPackTool, registerPromoteMemoryPackTool } from '../../src/mcp/tools/memory-packs.js';

interface ServerStub {
  handlers: Record<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>;
  tool: (name: string, description: string, schema: unknown, ...rest: unknown[]) => void;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = {
    handlers: {},
    tool(name, _description, _schema, ...rest) {
      const last = rest[rest.length - 1];
      if (typeof last === 'function') stub.handlers[name] = last as ServerStub['handlers'][string];
    },
  };
  return stub;
}

function makeFakeEngine(gateEnforce: ReturnType<typeof vi.fn>) {
  return {
    ledger: {
      begin: vi.fn(() => ({
        id: 'entry-1',
        addMetadata: vi.fn(),
        fail: vi.fn(() => ({ id: 'entry-1', status: 'FAILED' })),
        complete: vi.fn(() => ({ id: 'entry-1', status: 'COMPLETED' })),
      })),
      record: vi.fn(),
    },
    gate: { enforce: gateEnforce },
    scorer: { scoreDefault: vi.fn(() => ({ integrity: 1, accuracy: 1, compliance: 1, composite: 1 })) },
    telemetryService: { emitToolCall: vi.fn() },
  } as unknown as GovernanceEngine;
}

function sealInput(packId: string) {
  return {
    pack_id: packId,
    version: '1.0.0',
    type: 'DOMAIN_SOP' as const,
    trust_level: 'CASE' as const,
    domain: 'test-domain',
    scope: ['test'],
    risk_level: 'ADVISORY' as const,
    ttl_hours: 24,
    created_by: 'test-agent',
    principles: ['test principle'],
    sop: ['test sop'],
    heuristics: ['test heuristic'],
    anti_patterns: ['test anti-pattern'],
    allowed_roles: [],
  };
}

function promoteInput(packId: string) {
  return {
    pack_id: packId,
    target_trust: 'ORG' as const,
    approved_by: 'william-storey',
    approver_role: 'isso',
  };
}

function sealEphemeralInput(packId: string) {
  return {
    pack_id: packId,
    version: '1.0.0',
    type: 'HEURISTIC' as const,
    trust_level: 'EPHEMERAL' as const,
    domain: 'test-domain',
    scope: ['test'],
    risk_level: 'ADVISORY' as const,
    ttl_hours: 4,
    created_by: 'test-agent',
    principles: ['test principle'],
    sop: ['test sop'],
    heuristics: ['test heuristic'],
    anti_patterns: ['test anti-pattern'],
    allowed_roles: [],
  };
}

function promoteToCaseInput(packId: string) {
  return {
    pack_id: packId,
    target_trust: 'CASE' as const,
    // approver_role 'agent' is self-reported and, per TRUST_SEAL_ROLES.CASE,
    // is a permitted sealer role for CASE — the gate is the only real backstop.
    approved_by: 'self-reported-agent',
    approver_role: 'agent',
  };
}

describe('promote_memory_pack — CASE-trust promotions must also require the MANDATORY gate', () => {
  let stub: ServerStub;
  let gateEnforce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stub = makeServerStub();
    gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerPromoteMemoryPackTool(stub as unknown as McpServer, engine);
  });

  it('a REJECTED gate blocks promotion to CASE trust even with self-reported approver_role "agent" (fleet verification finding — CASE previously skipped the gate entirely)', async () => {
    const packId = 'gate-test-case-rejected';
    await stub.handlers['seal_memory_pack'](sealEphemeralInput(packId));

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-case-rej', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'self-reported-agent', timestamp: new Date(), rationale: 'not yet', autoRunMode: false });
    const result = await stub.handlers['promote_memory_pack'](promoteToCaseInput(packId));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GATE_REQUIRED');
  });

  it('an APPROVED gate still allows CASE promotion to succeed normally (no regression)', async () => {
    const packId = 'gate-test-case-approved';
    await stub.handlers['seal_memory_pack'](sealEphemeralInput(packId));

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-case-ok', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'self-reported-agent', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const result = await stub.handlers['promote_memory_pack'](promoteToCaseInput(packId));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.promoted).toBe(true);
    expect(parsed.newTrust).toBe('CASE');
  });
});

describe('promote_memory_pack — MANDATORY gate must block the write, not just the response', () => {
  let stub: ServerStub;
  let gateEnforce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stub = makeServerStub();
    gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerPromoteMemoryPackTool(stub as unknown as McpServer, engine);
  });

  it('a REJECTED gate leaves the pack un-promoted — a later APPROVED attempt on the same pack still succeeds', async () => {
    const packId = 'gate-test-pack-rejected-status';
    await stub.handlers['seal_memory_pack'](sealInput(packId));

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-rej', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'not yet', autoRunMode: false });
    const firstAttempt = await stub.handlers['promote_memory_pack'](promoteInput(packId));
    expect(firstAttempt.isError).toBe(true);
    expect(firstAttempt.content[0].text).toContain('GATE_REQUIRED');

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-app', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const secondAttempt = await stub.handlers['promote_memory_pack'](promoteInput(packId));
    expect(secondAttempt.isError).toBeUndefined();
    const parsed = JSON.parse(secondAttempt.content[0].text);
    expect(parsed.promoted).toBe(true);
    expect(parsed.newTrust).toBe('ORG');
  });

  it('a thrown gate rejection (real MaiGate REJECTED/TIMED_OUT behavior) also leaves the pack un-promoted', async () => {
    const packId = 'gate-test-pack-thrown';
    await stub.handlers['seal_memory_pack'](sealInput(packId));

    gateEnforce.mockRejectedValueOnce(new Error('MANDATORY gate auto-denied (fail-closed) for promote-memory-pack'));
    const firstAttempt = await stub.handlers['promote_memory_pack'](promoteInput(packId));
    expect(firstAttempt.isError).toBe(true);

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-app-2', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const secondAttempt = await stub.handlers['promote_memory_pack'](promoteInput(packId));
    expect(secondAttempt.isError).toBeUndefined();
    const parsed = JSON.parse(secondAttempt.content[0].text);
    expect(parsed.promoted).toBe(true);
  });

  it('an APPROVED gate promotes normally in a single call (happy path unaffected)', async () => {
    const packId = 'gate-test-pack-approved';
    await stub.handlers['seal_memory_pack'](sealInput(packId));

    gateEnforce.mockResolvedValueOnce({ gateId: 'g-ok', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const result = await stub.handlers['promote_memory_pack'](promoteInput(packId));
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.promoted).toBe(true);
    expect(parsed.oldPackStatus).toBe('REVOKED');
  });
});
