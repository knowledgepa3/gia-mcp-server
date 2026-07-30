import { describe, it, expect, vi } from 'vitest';
import { registerGovernedTool } from '../registerGovernedTool.js';

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    tool: vi.fn((name: string, _d: string, _s: any, _a: any, handler: Function) => { handlers[name] = handler; }),
  } as any;
}

describe('registerGovernedTool', () => {
  it('blocks the handler when the action gate denies (destructive tool)', async () => {
    const server = fakeServer();
    const engine = {} as any;
    const gate = vi.fn(() => ({ allowed: false, classification: 'MANDATORY', gateId: 'g1', reason: 'r', auditId: 'a' }));
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'did it' }] }));

    registerGovernedTool(server, engine, {
      name: 'srt_approve_repair', description: 'd', schema: {},
      annotations: { destructiveHint: true }, resourceOf: () => 'system', verbOf: () => 'execute',
    }, handler, gate);

    const res = await server.handlers['srt_approve_repair']({});
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/GATE HOLD|g1/);
  });

  it('passes through to the handler when the gate allows (read-only tool)', async () => {
    const server = fakeServer();
    const gate = vi.fn(() => ({ allowed: true, classification: 'INFORMATIONAL', reason: 'r', auditId: 'a' }));
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    registerGovernedTool(server, {} as any, {
      name: 'system_status', description: 'd', schema: {},
      annotations: { readOnlyHint: true },
    }, handler, gate);
    const res = await server.handlers['system_status']({});
    expect(handler).toHaveBeenCalledOnce();
    expect(res.content[0].text).toBe('ok');
  });
});
