/**
 * @module    test-transfer-memory-pack-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for a governance-integrity bug found during the
 * 2026-07-14 MCP enforcement audit: transfer_memory_pack's "MANDATORY gate"
 * was `if (!input.approved_by || input.approved_by === 'system') return error`
 * — any other caller-supplied string was treated as a valid human approval.
 * No real gate.enforce() call, no pending-gate workflow, nothing that
 * couldn't be spoofed by the caller itself. Fixed to use a real
 * engine.gate.enforce(MANDATORY, ...) call, checked before the transfer
 * mutation (create derived pack + persist + usage event).
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerSealMemoryPackTool, registerTransferMemoryPackTool } from '../../src/mcp/tools/memory-packs.js';

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

function transferInput(packId: string, approvedBy: string) {
  return {
    source_pack_id: packId,
    source_agent_id: 'agent-a',
    target_agent_id: 'agent-b',
    target_role: 'analyst',
    approved_by: approvedBy,
  };
}

describe('transfer_memory_pack — MANDATORY gate must be real, not a self-declared string', () => {
  it('a REJECTED gate blocks the transfer even though approved_by looks like a legitimate human name', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-rej', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'someone', timestamp: new Date(), rationale: 'not yet', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerTransferMemoryPackTool(stub as unknown as McpServer, engine);

    await stub.handlers['seal_memory_pack'](sealInput('transfer-gate-test-pack-1'));

    // Old buggy check would have accepted this string outright — it's not 'system' or empty.
    const result = await stub.handlers['transfer_memory_pack'](transferInput('transfer-gate-test-pack-1', 'plausible-human-name'));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/gate/i);
  });

  it('an APPROVED gate (real engine decision, not just a non-blocklisted string) allows the transfer', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-ok', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerTransferMemoryPackTool(stub as unknown as McpServer, engine);

    await stub.handlers['seal_memory_pack'](sealInput('transfer-gate-test-pack-2'));
    const result = await stub.handlers['transfer_memory_pack'](transferInput('transfer-gate-test-pack-2', 'william-storey'));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.transferred).toBe(true);
  });

  it('a thrown gate rejection (real MaiGate REJECTED/TIMED_OUT behavior) also blocks the transfer', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockRejectedValue(new Error('MANDATORY gate auto-denied (fail-closed) for transfer-memory-pack'));
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerTransferMemoryPackTool(stub as unknown as McpServer, engine);

    await stub.handlers['seal_memory_pack'](sealInput('transfer-gate-test-pack-3'));
    const result = await stub.handlers['transfer_memory_pack'](transferInput('transfer-gate-test-pack-3', 'plausible-human-name'));

    expect(result.isError).toBe(true);
  });
});
