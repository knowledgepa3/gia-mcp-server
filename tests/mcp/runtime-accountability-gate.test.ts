import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { wrapServerWithRuntimeAccountability } from '../../src/mcp/runtime-accountability-wrapper.js';

interface ServerStub {
  handlers: Record<string, (...args: unknown[]) => Promise<unknown>>;
  tool: (...args: unknown[]) => void;
  registerTool: (...args: unknown[]) => void;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = { handlers: {}, tool: () => {}, registerTool: () => {} };
  const capture = (...args: unknown[]) => {
    const name = String(args[0]);
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    stub.handlers[name] = handler;
  };
  stub.tool = capture;
  stub.registerTool = capture;
  return stub;
}

function makeFakeEngine(gateEnforce: ReturnType<typeof vi.fn>) {
  return {
    runtimeService: { startSession: vi.fn(() => ({ runtimeId: 'r1' })), endSession: vi.fn() },
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
  } as unknown as GovernanceEngine;
}

describe('runtime-accountability-wrapper — MANDATORY gating for seal_memory_pack', () => {
  it('blocks seal_memory_pack at SYSTEM trust when the gate is REJECTED', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g1', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'x', timestamp: new Date(), rationale: 'no', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'sealed' }] }));
    wrapped.tool('seal_memory_pack', 'desc', {}, { title: 't' }, handler);

    const result = await stub.handlers['seal_memory_pack']({ trust_level: 'SYSTEM' });

    expect(gateEnforce).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('allows seal_memory_pack at SYSTEM trust when the gate is APPROVED', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g2', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'x', timestamp: new Date(), rationale: 'ok', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'sealed' }] }));
    wrapped.tool('seal_memory_pack', 'desc', {}, { title: 't' }, handler);

    const result = await stub.handlers['seal_memory_pack']({ trust_level: 'SYSTEM' });

    expect(gateEnforce).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('does NOT gate seal_memory_pack at CASE trust (ADVISORY branch) — handler runs, gate never consulted', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'sealed' }] }));
    wrapped.tool('seal_memory_pack', 'desc', {}, { title: 't' }, handler);

    await stub.handlers['seal_memory_pack']({ trust_level: 'CASE' });

    expect(gateEnforce).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does NOT gate a selfEnforces tool (promote_memory_pack) — no double-gating', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'promoted' }] }));
    wrapped.tool('promote_memory_pack', 'desc', {}, { title: 't' }, handler);

    await stub.handlers['promote_memory_pack']({ target_trust: 'ORG' });

    expect(gateEnforce).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does NOT gate an isGateResolver tool (approve_gate)', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'approved' }] }));
    wrapped.tool('approve_gate', 'desc', {}, { title: 't' }, handler);

    await stub.handlers['approve_gate']({ gate_id: 'g1' });

    expect(gateEnforce).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('an unclassified tool name is a hard error at registration time, not a silent pass-through', () => {
    const stub = makeServerStub();
    const engine = makeFakeEngine(vi.fn());
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);
    const handler = vi.fn(async () => ({ content: [] }));

    expect(() => wrapped.tool('totally_new_unclassified_tool', 'desc', {}, { title: 't' }, handler)).toThrow(/not classified/i);
  });
});

describe('runtime-accountability-wrapper — registerTool() must not bypass governance', () => {
  const config = { description: 'desc', inputSchema: {}, annotations: { title: 't' } };

  it('an unclassified tool registered via registerTool is a hard error at registration time', () => {
    const stub = makeServerStub();
    const engine = makeFakeEngine(vi.fn());
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);
    const handler = vi.fn(async () => ({ content: [] }));

    expect(() => wrapped.registerTool('totally_new_unclassified_tool', config, handler)).toThrow(/not classified/i);
  });

  it('blocks a MANDATORY tool registered via registerTool when the gate is REJECTED', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g3', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'x', timestamp: new Date(), rationale: 'no', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'sealed' }] }));
    wrapped.registerTool('seal_memory_pack', config, handler);

    const result = await stub.handlers['seal_memory_pack']({ trust_level: 'SYSTEM' });

    expect(gateEnforce).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('allows a MANDATORY tool registered via registerTool when the gate is APPROVED, with runtime session bookends', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g4', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'x', timestamp: new Date(), rationale: 'ok', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'sealed' }] }));
    wrapped.registerTool('seal_memory_pack', config, handler);

    const result = await stub.handlers['seal_memory_pack']({ trust_level: 'SYSTEM' });

    expect(gateEnforce).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect((engine as unknown as { runtimeService: { startSession: ReturnType<typeof vi.fn>; endSession: ReturnType<typeof vi.fn> } }).runtimeService.startSession).toHaveBeenCalled();
    expect((engine as unknown as { runtimeService: { startSession: ReturnType<typeof vi.fn>; endSession: ReturnType<typeof vi.fn> } }).runtimeService.endSession).toHaveBeenCalledWith('r1', 'completed');
  });

  it('does NOT gate an isGateResolver tool registered via registerTool (approve_gate)', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn();
    const engine = makeFakeEngine(gateEnforce);
    const wrapped = wrapServerWithRuntimeAccountability(stub as unknown as McpServer, engine);

    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'approved' }] }));
    wrapped.registerTool('approve_gate', config, handler);

    await stub.handlers['approve_gate']({ gate_id: 'g1' });

    expect(gateEnforce).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });
});
