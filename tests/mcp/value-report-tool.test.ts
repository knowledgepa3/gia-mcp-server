/**
 * @module    test-value-report-tool
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Task #16 — generate_value_report thin wrapper:
 *  - registers ONLY the draft-generation tool (no release/revoke capability, ever)
 *  - maps snake_case MCP input → camelCase Express payload, with the internal bearer
 *  - surfaces HTTP errors and network failures as structured isError results
 *  - stamps the DRAFT / human-release-only note on every success
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerValueReportTools } from '../../src/mcp/tools/value-report.js';

interface ServerStub {
  registeredNames: string[];
  handlers: Record<string, (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>;
  tool: (name: string, description: string, schema: unknown, ...rest: unknown[]) => void;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = {
    registeredNames: [],
    handlers: {},
    tool(name, _description, _schema, ...rest) {
      stub.registeredNames.push(name);
      const last = rest[rest.length - 1];
      if (typeof last === 'function') stub.handlers[name] = last as ServerStub['handlers'][string];
    },
  };
  return stub;
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const OK_BODY = {
  reportId: 'rep-1', verifyCode: 'vc-1', reportHash: 'b'.repeat(64),
  result: {
    assumptionSetVersion: '1.1.0+bls-oes', assumptionSetHash: 'c'.repeat(64),
    totals: { conservative: 1, moderate: 2, aggressive: 3 },
    measurementCoverage: 93.4, sessionsConsidered: 100, sessionsValued: 93,
    disclosures: ['All dollar figures are MODELED'],
  },
};

function stubResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('generate_value_report MCP thin wrapper', () => {
  let stub: ServerStub;

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.GIA_API_URL = 'http://gia-test:3001';
    process.env.GIA_INTERNAL_API_KEY = 'internal-key-test';
    stub = makeServerStub();
    registerValueReportTools(stub as unknown as McpServer, {} as GovernanceEngine);
  });

  it('registers ONLY generate_value_report — no release/revoke capability exists on the MCP surface', () => {
    expect(stub.registeredNames).toEqual(['generate_value_report']);
  });

  it('maps snake_case input to the camelCase Express payload with the internal bearer', async () => {
    fetchMock.mockResolvedValueOnce(stubResponse(201, OK_BODY));
    await stub.handlers['generate_value_report']({
      period_start: '2026-06-10T00:00:00.000Z',
      period_end: '2026-07-10T00:00:00.000Z',
      client_facing: true,
      rate_basis: 'bls_oes',
      rate_overrides: [{ role_key: 'paralegal', hourly_base: 38, source: 'Acme legal ops declaration 2026-07-01' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('http://gia-test:3001/api/economics/reports');
    expect(init.headers.Authorization).toBe('Bearer internal-key-test');
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      periodStart: '2026-06-10T00:00:00.000Z',
      periodEnd: '2026-07-10T00:00:00.000Z',
      clientFacing: true,
      rateBasis: 'bls_oes',
      rateOverrides: [{ roleKey: 'paralegal', hourlyBase: 38, source: 'Acme legal ops declaration 2026-07-01' }],
      requestedVia: 'mcp:generate_value_report', // ledger attribution stamped on every MCP-originated draft
    });
  });

  it('success output carries the DRAFT note, verify path, hashes, and disclosures — never a release claim', async () => {
    fetchMock.mockResolvedValueOnce(stubResponse(201, OK_BODY));
    const out = await stub.handlers['generate_value_report']({
      period_start: '2026-06-10T00:00:00.000Z', period_end: '2026-07-10T00:00:00.000Z',
    });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.status).toMatch(/DRAFT/);
    expect(parsed.status).toMatch(/human ISSO/i);
    expect(parsed.verifyPath).toBe('/api/economics/verify/vc-1');
    expect(parsed.reportHash).toBe('b'.repeat(64));
    expect(parsed.assumptionSetVersion).toBe('1.1.0+bls-oes');
    expect(parsed.disclosures).toContain('All dollar figures are MODELED');
  });

  it('surfaces the citation-gate refusal (HTTP 400) as isError with the server message', async () => {
    fetchMock.mockResolvedValueOnce(stubResponse(400, { error: 'Client-facing report refused (fail-closed): uncited rate row(s) [knowledge_worker_generalist].' }));
    const out = await stub.handlers['generate_value_report']({
      period_start: '2026-06-10T00:00:00.000Z', period_end: '2026-07-10T00:00:00.000Z', client_facing: true,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/fail-closed/);
  });

  it('network failure returns a structured error, never fabricated output', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const out = await stub.handlers['generate_value_report']({
      period_start: '2026-06-10T00:00:00.000Z', period_end: '2026-07-10T00:00:00.000Z',
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/GIA API unreachable/);
    expect(out.content[0].text).toMatch(/ECONNREFUSED/);
  });
});
