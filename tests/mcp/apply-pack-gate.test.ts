/**
 * @module    test-apply-pack-gate
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression coverage for a governance-integrity bug found during the
 * 2026-07-14 MCP enforcement audit: gia_apply_pack's "MANDATORY GATE" was
 * `if (!approved_by || BLOCKED_APPROVERS.includes(approverLower)) reject` —
 * any caller-supplied identity not literally in {system, auto, agent, bot,
 * ai, ''} was treated as a valid human approval for executing a real
 * remediation/hardening command plan on the target host. No real
 * gate.enforce() call, no pending-approval workflow. Fixed to require a
 * real engine.gate.enforce(MANDATORY, ...) APPROVED decision before the
 * approval token / execution plan is created.
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { registerDryRunPackTool, registerApplyPackTool } from '../../src/mcp/tools/remediation-packs.js';

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

async function getRealInputsHash(stub: ServerStub, packId: string): Promise<string> {
  const dryRun = await stub.handlers['gia_dry_run_pack']({ pack_id: packId });
  const parsed = JSON.parse(dryRun.content[0].text);
  return parsed.dryRun.inputsHash;
}

describe('gia_apply_pack — MANDATORY gate must be real, not a blocklist of banned strings', () => {
  const PACK_ID = 'rpack-nginx-502-v1'; // real seeded remediation pack, no variables required

  it('a REJECTED gate blocks execution even though approved_by is a plausible human name (not in the string blocklist)', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-rej', classification: 'MANDATORY', status: 'REJECTED', approvedBy: 'someone', timestamp: new Date(), rationale: 'not yet', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerDryRunPackTool(stub as unknown as McpServer, engine);
    registerApplyPackTool(stub as unknown as McpServer, engine);

    const inputsHash = await getRealInputsHash(stub, PACK_ID);
    const result = await stub.handlers['gia_apply_pack']({
      pack_id: PACK_ID,
      approved_by: 'plausible-human-name', // old blocklist check would have accepted this
      approver_role: 'isso',
      inputs_hash: inputsHash,
      tenant_id: 'ace-platform',
    });

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/gate/i);
  });

  it('an APPROVED gate (real engine decision) allows execution plan creation', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockResolvedValue({ gateId: 'g-ok', classification: 'MANDATORY', status: 'APPROVED', approvedBy: 'william-storey', timestamp: new Date(), rationale: 'approved', autoRunMode: false });
    const engine = makeFakeEngine(gateEnforce);
    registerDryRunPackTool(stub as unknown as McpServer, engine);
    registerApplyPackTool(stub as unknown as McpServer, engine);

    const inputsHash = await getRealInputsHash(stub, PACK_ID);
    const result = await stub.handlers['gia_apply_pack']({
      pack_id: PACK_ID,
      approved_by: 'william-storey',
      approver_role: 'isso',
      inputs_hash: inputsHash,
      tenant_id: 'ace-platform',
    });

    expect(gateEnforce).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.approved).toBe(true);
  });

  it('a thrown gate rejection also blocks execution', async () => {
    const stub = makeServerStub();
    const gateEnforce = vi.fn().mockRejectedValue(new Error('MANDATORY gate auto-denied (fail-closed) for gia_apply_pack'));
    const engine = makeFakeEngine(gateEnforce);
    registerDryRunPackTool(stub as unknown as McpServer, engine);
    registerApplyPackTool(stub as unknown as McpServer, engine);

    const inputsHash = await getRealInputsHash(stub, PACK_ID);
    const result = await stub.handlers['gia_apply_pack']({
      pack_id: PACK_ID,
      approved_by: 'plausible-human-name',
      approver_role: 'isso',
      inputs_hash: inputsHash,
      tenant_id: 'ace-platform',
    });

    expect(result.isError).toBe(true);
  });
});
