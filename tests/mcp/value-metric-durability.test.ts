/**
 * @module    test-value-metric-durability
 * @layer     TEST
 * @owner     William J. Storey III / ACE / GIA
 *
 * Task #18 — record_value_metric was the only value tool NOT ledger-anchored,
 * and its store reset on restart. Verifies:
 *  - every metric anchors ADVISORY to the forensic ledger via the EXISTING
 *    engine.ledger writer (record_governance_event precedent — no new INSERT site)
 *  - the durable copy persists with the ledger anchor id (fire-and-forget)
 *  - emitToolCall correlates on the real ledger entry id
 *  - buildEstimationBasis stays honest: report window is STILL in-memory
 *    (persisted:false unchanged); durablyRecorded discloses the audit-trail copy
 *  - routing-threshold price pins (cross-package drift guard v1 — the server
 *    suite pins the SAME literals against costCalculator)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';

const persistMock = vi.fn();
let persistenceEnabled = false;
vi.mock('../../src/core/persistence/telemetry-persistence.js', () => ({
  persistValueMetric: (...a: unknown[]) => persistMock(...a),
  isTelemetryPersistenceEnabled: () => persistenceEnabled,
}));

import { registerRecordValueMetricTool, buildEstimationBasis, getBaselines } from '../../src/mcp/tools/value-metrics.js';
import { TIER_PRICING_USD_PER_MTOK } from '../../src/config/routing-threshold.config.js';

interface ServerStub {
  handler?: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  tool: (name: string, description: string, schema: unknown, ...rest: unknown[]) => void;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = {
    tool(_name, _description, _schema, ...rest) {
      const last = rest[rest.length - 1];
      if (typeof last === 'function') stub.handler = last as ServerStub['handler'];
    },
  };
  return stub;
}

function makeEngineStub() {
  const recorded: unknown[] = [];
  const entry = {
    id: 'ledger-vm-001',
    addMetadata: vi.fn(),
    complete: vi.fn().mockReturnValue({ id: 'ledger-vm-001', completed: true }),
  };
  return {
    engine: {
      ledger: { begin: vi.fn().mockReturnValue(entry), record: (e: unknown) => recorded.push(e) },
      scorer: { scoreDefault: vi.fn().mockReturnValue({ score: 1 }) },
      telemetryService: { emitToolCall: vi.fn(), emitGeneric: vi.fn() },
    } as unknown as GovernanceEngine,
    entry, recorded,
  };
}

const METRIC_INPUT = {
  workflow_id: 'wf-1', workflow_type: 'claim-analysis', agent_id: 'agent-1',
  autonomy_level: 'delegate', measurement_source: 'measured',
  time_saved_minutes: 45, risk_blocked_count: 2, success: true, task_complexity: 'medium',
};

describe('record_value_metric — ledger anchor + durable persistence', () => {
  beforeEach(() => { persistMock.mockReset(); persistenceEnabled = false; });

  it('anchors ADVISORY to the forensic ledger via engine.ledger and records the completed entry', async () => {
    const stub = makeServerStub();
    const { engine, entry, recorded } = makeEngineStub();
    registerRecordValueMetricTool(stub as unknown as McpServer, engine);
    const out = await stub.handler!(METRIC_INPUT);
    expect(out.isError).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(entry.complete).toHaveBeenCalledOnce();
    expect(entry.addMetadata).toHaveBeenCalledWith('workflowType', 'claim-analysis');
  });

  it('persists the durable copy carrying the ledger anchor id', async () => {
    const stub = makeServerStub();
    const { engine } = makeEngineStub();
    registerRecordValueMetricTool(stub as unknown as McpServer, engine);
    await stub.handler!(METRIC_INPUT);
    expect(persistMock).toHaveBeenCalledOnce();
    const rec = persistMock.mock.calls[0][0] as Record<string, unknown>;
    expect(rec.workflowId).toBe('wf-1');
    expect(rec.measurementSource).toBe('measured');
    expect(rec.ledgerEntryId).toBe('ledger-vm-001');
  });

  it('emitToolCall correlates on the REAL ledger entry id (not a synthetic timestamp id)', async () => {
    const stub = makeServerStub();
    const { engine } = makeEngineStub();
    registerRecordValueMetricTool(stub as unknown as McpServer, engine);
    await stub.handler!(METRIC_INPUT);
    const emit = (engine as unknown as { telemetryService: { emitToolCall: ReturnType<typeof vi.fn> } }).telemetryService.emitToolCall;
    expect(emit).toHaveBeenCalledWith('record_value_metric', 'ledger-vm-001', 'ADVISORY', true);
  });
});

describe('buildEstimationBasis — honest labeling preserved', () => {
  it('default (no flag): unchanged shape, report window in-memory, no durable claim', () => {
    const basis = buildEstimationBasis(getBaselines());
    expect(basis.dataProvenance.persisted).toBe(false);
    expect(basis.dataProvenance.resetsOnRestart).toBe(true);
    expect(basis.dataProvenance.durablyRecorded).toBe(false);
    expect(basis.disclaimer).not.toMatch(/audit trail/);
  });

  it('durablyRecorded=true discloses the audit-trail copy WITHOUT upgrading the report window claim', () => {
    const basis = buildEstimationBasis(getBaselines(), true);
    expect(basis.dataProvenance.persisted).toBe(false); // the WINDOW is still in-memory — honest
    expect(basis.dataProvenance.durablyRecorded).toBe(true);
    expect(basis.disclaimer).toMatch(/audit trail, not the report window/);
  });
});

describe('routing-threshold price pins (cross-package drift guard v1)', () => {
  it.each([
    ['claude-fable-5', 10, 50],
    ['claude-opus-4-8', 5, 25],
    ['claude-sonnet-4-6', 3, 15],
    ['claude-haiku-4-5', 1, 5],
  ])('%s = $%d/$%d per 1M (must match server costCalculator pins)', (id, input, output) => {
    const row = TIER_PRICING_USD_PER_MTOK[String(id)];
    expect(row, `missing ${id} in routing-threshold.config`).toBeTruthy();
    expect(row.input).toBe(input);
    expect(row.output).toBe(output);
  });
});
