/**
 * @module    test-mai-gate
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MaiGate } from '../../src/core/mai/gate.js';
import { MaiClassification, GateStatus } from '../../src/shared/types.js';
import { GateRejectionError } from '../../src/shared/errors.js';

describe('MaiGate', () => {
  let gate: MaiGate;

  beforeEach(() => {
    gate = new MaiGate();
  });

  describe('INFORMATIONAL — no gate', () => {
    it('should auto-approve INFORMATIONAL without gate', async () => {
      const decision = await gate.enforce(MaiClassification.INFORMATIONAL, 'log-event', 'audit-123');
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.approvedBy).toBe('AUTO');
      expect(decision.autoRunMode).toBe(false);
    });
  });

  describe('ADVISORY — auto-continue after timeout', () => {
    it('should approve ADVISORY via timeout', async () => {
      // ADVISORY is a real pause-and-flag window (commit c1448321). The default
      // is 60s — far longer than vitest's 5s budget — so inject a short timeout
      // to exercise the auto-approve-after-timeout path. With persistence
      // disabled in tests, getAdvisoryTimeoutMs() returns this config value verbatim.
      const fastGate = new MaiGate({ advisoryTimeoutMs: 20 });
      const decision = await fastGate.enforce(MaiClassification.ADVISORY, 'draft-review', 'audit-456');
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.approvedBy).toBe('TIMEOUT');
    });
  });

  describe('MANDATORY — requires human approval', () => {
    it('should register pending approval for MANDATORY', async () => {
      // Start the enforce (it returns a pending promise)
      const enforcePromise = gate.enforce(MaiClassification.MANDATORY, 'critical-op', 'audit-789');

      // Check pending approvals
      const pending = gate.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].operation).toBe('critical-op');

      // Approve it
      const gateId = pending[0].gateId;
      const approved = gate.approve(gateId, 'ISSO-Storey', 'Reviewed and approved.');
      expect(approved).toBe(true);

      // Promise should resolve with approval
      const decision = await enforcePromise;
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.approvedBy).toBe('ISSO-Storey');
    });

    it('should reject MANDATORY when explicitly rejected', async () => {
      const enforcePromise = gate.enforce(MaiClassification.MANDATORY, 'risky-op', 'audit-000');

      const pending = gate.getPendingApprovals();
      const gateId = pending[0].gateId;
      gate.reject(gateId, 'reviewer', 'Insufficient evidence.');

      await expect(enforcePromise).rejects.toThrow(GateRejectionError);
    });

    it('should return false when approving non-existent gate', () => {
      expect(gate.approve('nonexistent-gate-id', 'someone')).toBe(false);
    });
  });

  describe('AUTO-RUN mode', () => {
    it('should auto-approve MANDATORY in auto-run mode', async () => {
      gate.setAutoRunMode(true);
      const decision = await gate.enforce(MaiClassification.MANDATORY, 'critical-op', 'audit-auto');
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.approvedBy).toBe('AUTO-RUN');
      expect(decision.autoRunMode).toBe(true);
    });

    it('should auto-approve ADVISORY in auto-run mode', async () => {
      gate.setAutoRunMode(true);
      const decision = await gate.enforce(MaiClassification.ADVISORY, 'draft', 'audit-auto');
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.autoRunMode).toBe(true);
    });

    it('should track auto-run mode state', () => {
      expect(gate.isAutoRunMode).toBe(false);
      gate.setAutoRunMode(true);
      expect(gate.isAutoRunMode).toBe(true);
      gate.setAutoRunMode(false);
      expect(gate.isAutoRunMode).toBe(false);
    });
  });
});
