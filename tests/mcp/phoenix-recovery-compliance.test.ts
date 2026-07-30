import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';

// Control the intelligence-layer availability so we can assert CP-2 both ways.
vi.mock('../../src/core/persistence/intelligence-persistence.js', () => ({
  getRecentPhoenixRecords: vi.fn(async () => []),
  getPhoenixStats: vi.fn(async () => ({ totalSnapshots: 3 })),
  getRecentCerebroSignals: vi.fn(async () => []),
  getCerebroStats: vi.fn(async () => ({ totalSignals: 1 })),
}));

import { registerPhoenixRecoveryTools } from '../../src/mcp/tools/phoenix-recovery.js';
import * as intel from '../../src/core/persistence/intelligence-persistence.js';

interface ServerStub {
  handlers: Record<string, (...args: unknown[]) => Promise<unknown>>;
  tool: (...args: unknown[]) => void;
  registerTool: (...args: unknown[]) => void;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = { handlers: {}, tool: () => {}, registerTool: () => {} };
  const capture = (...args: unknown[]) => {
    const name = String(args[0]);
    stub.handlers[name] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
  };
  stub.tool = capture;
  stub.registerTool = capture;
  return stub;
}

function makeEngine(chainValid: boolean): GovernanceEngine {
  return {
    ledger: {
      verifyChain: () => ({
        valid: chainValid,
        entriesVerified: chainValid ? 5 : 2,
        firstBrokenLink: chainValid ? null : 3,
      }),
      size: 5,
    },
    thresholdMonitor: { getReading: () => ({ status: 'NORMAL', escalationRate: 0.12, isHealthy: true, windowSize: 20 }) },
    supervisor: { getAllStates: () => new Map() },
    telemetryService: { emitToolCall: vi.fn() },
  } as unknown as GovernanceEngine;
}

async function runVerify(chainValid: boolean): Promise<Record<string, any>> {
  const stub = makeServerStub();
  registerPhoenixRecoveryTools(stub as unknown as McpServer, makeEngine(chainValid));
  const res = await stub.handlers['phoenix_verify_integrity']({});
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

describe('phoenix_verify_integrity — NIST compliance fields must reflect real state', () => {
  it('a BROKEN chain must NOT report a NIST-CP-10 pass value', async () => {
    const report = await runVerify(false);
    expect(report.components.auditChain.status).toBe('BROKEN');
    // The exact fabrication the 2026-06-29 truth map (#1) flagged:
    expect(report.compliance['NIST-CP-10']).not.toBe('INTEGRITY_CHECKED');
    expect(report.compliance['NIST-CP-10']).toBe('INTEGRITY_FAILED');
  });

  it('an INTACT chain reports NIST-CP-10 as verified', async () => {
    const report = await runVerify(true);
    expect(report.components.auditChain.status).toBe('INTACT');
    expect(report.compliance['NIST-CP-10']).toBe('INTEGRITY_VERIFIED');
  });

  it('NIST-CP-2 reflects recovery capability availability, not a constant', async () => {
    // Intelligence layer available (mocked) → capability configured.
    const available = await runVerify(true);
    expect(available.compliance['NIST-CP-2']).toBe('COMPLIANT');
    expect(available.compliance['NIST-CP-2']).not.toBe('VERIFIED'); // old fabricated literal

    // Recovery capability offline → NOT_CONFIGURED, never a pass.
    vi.mocked(intel.getPhoenixStats).mockResolvedValueOnce(null as never);
    const offline = await runVerify(true);
    expect(offline.compliance['NIST-CP-2']).toBe('NOT_CONFIGURED');
  });

  it('compliance block declares its attestation basis is a heuristic self-check, not certification', async () => {
    const report = await runVerify(true);
    expect(report.compliance.attestationBasis).toBe('HEURISTIC_SELF_CHECK');
  });
});
