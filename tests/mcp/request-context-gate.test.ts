/**
 * @module    test-request-context-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for a governance-integrity bug found during the
 * 2026-07-14 MCP fleet verification audit: request_context set a local
 * `maiLevel = MANDATORY` variable when a resolved memory pack had
 * `trustLevel === 'SYSTEM'`, but NEVER called engine.gate.enforce().
 * The MANDATORY label was only used to (a) write `requiresGate: true`
 * into the ledger completion metadata AFTER the fact, and (b) surface
 * `governance.maiClassification: "MANDATORY"` in the JSON response —
 * while the SYSTEM-trust pack CONTENT was already included in that same
 * response, unconditionally. Fixed to call a real
 * engine.gate.enforce(MANDATORY, ...) BEFORE SYSTEM-trust pack content
 * is added to the response envelope.
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerSealMemoryPackTool } from '../../src/mcp/tools/memory-packs.js';
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
      queryByTimeRange: vi.fn(() => []),
    },
    gate: { enforce: gateEnforce },
    scorer: { scoreDefault: vi.fn(() => ({ integrity: 1, accuracy: 1, compliance: 1, composite: 1 })) },
    telemetryService: { emitToolCall: vi.fn() },
    thresholdMonitor: { record: vi.fn() },
  } as unknown as GovernanceEngine;
}

function sealSystemPack(packId: string, domain: string) {
  return {
    pack_id: packId,
    version: '1.0.0',
    type: 'DOMAIN_SOP' as const,
    trust_level: 'SYSTEM' as const,
    domain,
    scope: ['test'],
    risk_level: 'ADVISORY' as const,
    ttl_hours: 24,
    created_by: 'isso-test',
    sealer_role: 'isso',
    principles: ['SECRET SYSTEM-TRUST PRINCIPLE — must never leak without a gate'],
    sop: ['SECRET SYSTEM-TRUST SOP'],
    heuristics: [],
    anti_patterns: [],
    allowed_roles: [],
  };
}

function requestContextInput(domain: string) {
  return {
    query: 'what is the SOP for this domain',
    context_class: 'policies_and_sops' as const,
    domain,
    agent_id: 'requesting-agent',
    operator_role: 'agent',
    max_results: 5,
    include_compliance: false,
  };
}

describe('request_context — SYSTEM-trust pack content must be gated by a real engine.gate.enforce() call', () => {
  it('a REJECTED gate blocks SYSTEM-trust content from reaching the response', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-rej', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'someone', timestamp: new Date(), rationale: 'not yet', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerContextAuthorityTool(stub as unknown as McpServer, engine);

    const domain = 'gate-test-domain-1';
    await stub.handlers['seal_memory_pack'](sealSystemPack('ctx-gate-test-pack-1', domain));

    const result = await stub.handlers['request_context'](requestContextInput(domain));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/gate/i);
    expect(result.content[0].text).not.toMatch(/SECRET SYSTEM-TRUST/);
  });

  it('an APPROVED gate (real engine decision) allows SYSTEM-trust content through normally', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-ok', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerContextAuthorityTool(stub as unknown as McpServer, engine);

    const domain = 'gate-test-domain-2';
    await stub.handlers['seal_memory_pack'](sealSystemPack('ctx-gate-test-pack-2', domain));

    const result = await stub.handlers['request_context'](requestContextInput(domain));

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/SECRET SYSTEM-TRUST/);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.governance.maiClassification).toBe('MANDATORY');
  });

  it('a thrown gate rejection (real MaiGate REJECTED/TIMED_OUT behavior) also blocks the content', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockRejectedValue(new Error('MANDATORY gate auto-denied (fail-closed) for request-context'));
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerContextAuthorityTool(stub as unknown as McpServer, engine);

    const domain = 'gate-test-domain-3';
    await stub.handlers['seal_memory_pack'](sealSystemPack('ctx-gate-test-pack-3', domain));

    const result = await stub.handlers['request_context'](requestContextInput(domain));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/SECRET SYSTEM-TRUST/);
  });

  it('non-SYSTEM-trust requests never call the gate (no regression to the common case)', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-should-not-be-called', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'x', timestamp: new Date(), rationale: '', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerSealMemoryPackTool(stub as unknown as McpServer, engine);
    registerContextAuthorityTool(stub as unknown as McpServer, engine);

    const domain = 'gate-test-domain-4';
    // CASE trust, not SYSTEM — no human approver role restriction.
    await stub.handlers['seal_memory_pack']({
      pack_id: 'ctx-gate-test-pack-4',
      version: '1.0.0',
      type: 'DOMAIN_SOP',
      trust_level: 'CASE',
      domain,
      scope: ['test'],
      risk_level: 'ADVISORY',
      ttl_hours: 24,
      created_by: 'agent-test',
      principles: ['ordinary CASE-trust principle'],
      sop: ['ordinary CASE-trust SOP'],
      heuristics: [],
      anti_patterns: [],
      allowed_roles: [],
    });

    const result = await stub.handlers['request_context'](requestContextInput(domain));

    expect(gateEnforce).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ordinary CASE-trust principle/);
  });
});
