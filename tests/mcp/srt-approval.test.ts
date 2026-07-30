/**
 * @module    test-srt-approval-honesty
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * H3 closure — srt_approve_repair must not fabricate a completed repair.
 *
 * The MCP srt_approve_repair tool is the MANDATORY human-in-the-loop gate. It approves
 * the repair plan but DOES NOT execute repair commands — real execution is server-side
 * (server/src/srt/srtCommandExecutor.executeRepairPlan). Before H3 the tool immediately
 * marked result:'SUCCESS', status:'REPAIR_COMPLETE', a future completedAt, and reported
 * commandsExecuted:N while running ZERO commands — false data persisted to the durable
 * incident store and fed into the postmortem.
 *
 * These tests pin the honest terminal state: approval ends at APPROVED / PENDING_EXECUTION
 * with no result. They are the negation of the old bug and guard against regressing to it.
 */

import { describe, it, expect } from 'vitest';
import { computeRepairApprovalState } from '../../src/mcp/tools/srt.js';

describe('computeRepairApprovalState (H3 honesty)', () => {
  it('records the human gate as approved', () => {
    expect(computeRepairApprovalState().gateStatus).toBe('APPROVED');
  });

  it('does NOT mark the repair complete or executing — only approved', () => {
    const s = computeRepairApprovalState();
    expect(s.incidentStatus).toBe('REPAIR_APPROVED');
    expect(s.incidentStatus).not.toBe('REPAIR_COMPLETE');
    expect(s.incidentStatus).not.toBe('REPAIR_EXECUTING');
  });

  it('produces NO result — the tool gates, it does not execute', () => {
    // The old bug set result:'SUCCESS' here without running any command.
    expect(computeRepairApprovalState().result).toBeNull();
  });

  it('marks execution as pending, not done', () => {
    expect(computeRepairApprovalState().executionStatus).toBe('PENDING_EXECUTION');
  });
});
