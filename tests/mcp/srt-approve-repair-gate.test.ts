/**
 * @module    test-srt-approve-repair-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for a governance-integrity bug found during the
 * 2026-07-14 MCP enforcement audit (same self-report-trust bypass class as
 * gia_apply_pack / transfer_memory_pack / gia_run_patrol): srt_approve_repair's
 * "MANDATORY GATE" was
 *   if (!approved_by || approved_by === 'system' || approved_by === 'auto'
 *       || approved_by === 'agent') reject
 * — any caller-supplied identity NOT literally in that four-item denylist was
 * treated as valid human approval for a real infrastructure repair, even
 * though srt_approve_repair was classified `isGateResolver: true` (a tool
 * that is supposedly trusted like approve_gate/board_approve_gate, which call
 * the REAL GateManager/engine.gate.approve() machinery). srt_approve_repair
 * never called gate.enforce() at all.
 *
 * Fixed to require a real engine.gate.enforce(MANDATORY, ...) APPROVED
 * decision before the repair-approval gate is marked APPROVED and
 * server-side execution is attempted. toolClassifications.ts changed from
 * `isGateResolver: true` to `selfEnforces: true` to match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';

// ── Force all watchdog probes to fail fast and deterministically, with no
// real network calls, so we can seed a real incident + repair plan through
// the actual srt_run_watchdog -> srt_diagnose flow. ──
vi.mock('tls', () => ({
  connect: vi.fn((_port: number, _host: string, _opts: unknown) => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const socket = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
        return socket;
      },
      setTimeout: () => socket,
      destroy: () => {},
      getPeerCertificate: () => ({}),
    };
    setTimeout(() => listeners['error']?.(new Error('mock TLS unreachable')), 0);
    return socket;
  }),
}));

vi.mock('dns', () => ({
  promises: {
    resolve4: vi.fn().mockRejectedValue(new Error('mock DNS unreachable')),
  },
}));

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
    telemetryService: {
      emitToolCall: vi.fn(),
      emitProbeResult: vi.fn(),
    },
  } as unknown as GovernanceEngine;
}

/**
 * Seed a real DIAGNOSED incident with a PENDING repair plan by driving the
 * actual srt_run_watchdog -> srt_diagnose flow (network calls are mocked to
 * fail fast above, and global.fetch is stubbed to reject so every probe
 * reports CRITICAL/ERROR — guaranteeing a finding + incident are created).
 */
async function seedIncidentWithPendingRepair(engine: GovernanceEngine): Promise<string> {
  const stub = makeServerStub();
  const { registerSRTRunWatchdogTool } = await import('../../src/mcp/tools/srt.js');
  const { registerSRTDiagnoseTool } = await import('../../src/mcp/tools/srt.js');
  registerSRTRunWatchdogTool(stub as unknown as McpServer, engine);
  registerSRTDiagnoseTool(stub as unknown as McpServer, engine);

  const watchdogResult = await stub.handlers['srt_run_watchdog']({});
  const watchdogParsed = JSON.parse(watchdogResult.content[0].text);
  expect(watchdogParsed.incidentCreated).toBe(true);
  const incidentId: string = watchdogParsed.incidentId;

  const diagResult = await stub.handlers['srt_diagnose']({ incident_id: incidentId });
  const diagParsed = JSON.parse(diagResult.content[0].text);
  expect(diagParsed.diagnosed).toBe(true);

  return incidentId;
}

describe('srt_approve_repair — MANDATORY gate must be real, not a 4-string denylist', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Every probe that uses fetch() reports CRITICAL/ERROR — no real network.
    global.fetch = vi.fn().mockRejectedValue(new Error('mock network unreachable')) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('a REJECTED gate blocks repair approval even though approved_by is a plausible human name (not in the old string denylist)', async () => {
    const gateEnforce = vi.fn().mockResolvedValue({
      gateId: 'g-rej', classification: 'MANDATORY', status: 'REJECTED',
      approvedBy: 'someone', timestamp: new Date(), rationale: 'not yet', autoRunMode: false,
    });
    const engine = makeFakeEngine(gateEnforce);

    const incidentId = await seedIncidentWithPendingRepair(engine);

    const stub = makeServerStub();
    const { registerSRTApproveRepairTool } = await import('../../src/mcp/tools/srt.js');
    registerSRTApproveRepairTool(stub as unknown as McpServer, engine);

    const result = await stub.handlers['srt_approve_repair']({
      incident_id: incidentId,
      action: 'approve',
      approved_by: 'plausible-human-name', // old denylist check would have accepted this
    });

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/gate/i);
  });

  it('an APPROVED gate (real engine decision) allows repair approval to proceed', async () => {
    const gateEnforce = vi.fn().mockResolvedValue({
      gateId: 'g-ok', classification: 'MANDATORY', status: 'APPROVED',
      approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false,
    });
    const engine = makeFakeEngine(gateEnforce);

    const incidentId = await seedIncidentWithPendingRepair(engine);

    const stub = makeServerStub();
    const { registerSRTApproveRepairTool } = await import('../../src/mcp/tools/srt.js');
    registerSRTApproveRepairTool(stub as unknown as McpServer, engine);

    const result = await stub.handlers['srt_approve_repair']({
      incident_id: incidentId,
      action: 'approve',
      approved_by: 'william-storey',
    });

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.approved).toBe(true);
  });

  it('a thrown gate rejection (fail-closed timeout) also blocks repair approval', async () => {
    const gateEnforce = vi.fn().mockRejectedValue(new Error('MANDATORY gate auto-denied (fail-closed) for srt_approve_repair'));
    const engine = makeFakeEngine(gateEnforce);

    const incidentId = await seedIncidentWithPendingRepair(engine);

    const stub = makeServerStub();
    const { registerSRTApproveRepairTool } = await import('../../src/mcp/tools/srt.js');
    registerSRTApproveRepairTool(stub as unknown as McpServer, engine);

    const result = await stub.handlers['srt_approve_repair']({
      incident_id: incidentId,
      action: 'approve',
      approved_by: 'plausible-human-name',
    });

    expect(result.isError).toBe(true);
  });
});
