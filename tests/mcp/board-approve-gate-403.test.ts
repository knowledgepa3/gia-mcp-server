/**
 * @module    test-board-approve-gate-403
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for the 2026-07-15 service-role 403 investigation:
 * board_approve_gate POSTs /api/reasoning-board/gate/:id/approve with the MCP
 * internal service key. Under GIA_ROUTE_AUTHZ_MODE=strict the reasoning-board
 * family correctly excludes `service` from writes (separation of duties — a
 * service identity must not approve a MANDATORY gate), so the call 403s.
 * The map is RIGHT; the tool's failure must be HONEST: explain that human
 * approval is required and where to give it, instead of a generic
 * "Board API returned 403".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInstitutionTools } from '../../src/mcp/tools/institution.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('board_approve_gate — a 403 (service identity denied) must return honest human-approval guidance', () => {
  it('maps a 403 to HUMAN_APPROVAL_REQUIRED with console/mobile guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'Forbidden', code: 'ROUTE_AUTHZ_DENIED' }),
    }));

    const stub = makeServerStub();
    registerInstitutionTools(stub as unknown as McpServer);

    const result = await stub.handlers['board_approve_gate']({
      gate_id: 'gate-rb-test-1',
      approved_by: 'william.storey',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(parsed.gate_id).toBe('gate-rb-test-1');
    expect(parsed.message).toMatch(/human/i);
    expect(parsed.message).toMatch(/Sanity Check|console|mobile/i);
  });

  it('non-403 failures keep the generic BOARD_API_ERROR shape (no over-mapping)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    const stub = makeServerStub();
    registerInstitutionTools(stub as unknown as McpServer);

    const result = await stub.handlers['board_approve_gate']({
      gate_id: 'gate-rb-test-2',
      approved_by: 'william.storey',
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('BOARD_API_ERROR');
    expect(parsed.statusCode).toBe(503);
  });
});
