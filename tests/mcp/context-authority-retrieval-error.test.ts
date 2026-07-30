/**
 * @module    test-context-authority-retrieval-error
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for the 2026-07-15 service-role 403 investigation:
 * request_context's retrieveDocuments() helper swallowed ANY non-ok response
 * from POST /api/retrieval/search (incl. the 14 real strict-mode 403s of role
 * `service`, 2026-06-17→07-02) and returned { chunks: [] } — the envelope
 * reported "0 documents" as if nothing matched, indistinguishable from an
 * empty corpus. A governed context authority must not silently degrade:
 * an upstream retrieval failure must surface in governance.denials.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerContextAuthorityTool } from '../../src/mcp/tools/context-authority.js';

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

function makeFakeEngine() {
  return {
    ledger: {
      begin: vi.fn(() => ({
        id: 'entry-1',
        addMetadata: vi.fn(),
        fail: vi.fn(() => ({ id: 'entry-1', status: 'FAILED' })),
        complete: vi.fn(() => ({ id: 'entry-1', status: 'COMPLETED' })),
      })),
      record: vi.fn(),
      queryByTimeRange: vi.fn(() => []),
    },
    gate: { enforce: vi.fn() },
    scorer: { scoreDefault: vi.fn(() => ({ integrity: 1, accuracy: 1, compliance: 1, composite: 1 })) },
    telemetryService: { emitToolCall: vi.fn() },
    thresholdMonitor: { record: vi.fn() },
  } as unknown as GovernanceEngine;
}

// context_class with non-empty retrievalDomains → retrieveDocuments IS called
function requestContextInput() {
  return {
    query: 'how is the kernel proxy wired',
    context_class: 'architecture_and_systems' as const,
    domain: 'architecture',
    agent_id: 'requesting-agent',
    operator_role: 'agent',
    max_results: 5,
    include_compliance: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request_context — an upstream retrieval API failure must surface, never silently return empty context', () => {
  it('a 403 from /api/retrieval/search appears in governance.denials as RETRIEVAL_API_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden', code: 'ROUTE_AUTHZ_DENIED' }),
      text: async () => 'Forbidden',
    }));

    const stub = makeServerStub();
    registerContextAuthorityTool(stub as unknown as McpServer, makeFakeEngine());

    const result = await stub.handlers['request_context'](requestContextInput());
    const parsed = JSON.parse(result.content[0].text);

    const denials: Array<{ source: string; reason: string; detail: string }> =
      parsed.governance?.denials ?? [];
    const apiErrorDenial = denials.find(d => d.reason === 'RETRIEVAL_API_ERROR');
    expect(apiErrorDenial, 'retrieval API failure must be recorded as a denial, not swallowed').toBeDefined();
    expect(apiErrorDenial!.source).toBe('governed_retrieval');
    expect(apiErrorDenial!.detail).toMatch(/403/);
  });

  it('a network-level failure also surfaces in governance.denials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3001')));

    const stub = makeServerStub();
    registerContextAuthorityTool(stub as unknown as McpServer, makeFakeEngine());

    const result = await stub.handlers['request_context'](requestContextInput());
    const parsed = JSON.parse(result.content[0].text);

    const denials: Array<{ source: string; reason: string; detail: string }> =
      parsed.governance?.denials ?? [];
    expect(denials.some(d => d.reason === 'RETRIEVAL_API_ERROR')).toBe(true);
  });

  it('a healthy retrieval response records NO RETRIEVAL_API_ERROR denial (no false alarms)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], denied: [], stats: { totalSearched: 0 } }),
    }));

    const stub = makeServerStub();
    registerContextAuthorityTool(stub as unknown as McpServer, makeFakeEngine());

    const result = await stub.handlers['request_context'](requestContextInput());
    const parsed = JSON.parse(result.content[0].text);

    const denials: Array<{ source: string; reason: string }> = parsed.governance?.denials ?? [];
    expect(denials.some(d => d.reason === 'RETRIEVAL_API_ERROR')).toBe(false);
  });
});
