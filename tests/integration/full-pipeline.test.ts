/**
 * @module    test-integration-full-pipeline
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * INTEGRATION TEST: Full GIA Pipeline
 *
 * This test stands up a real GovernanceEngine and exercises
 * every component through the same code paths the MCP tools use.
 * This is the closest thing to a live server test without stdio.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GovernanceEngine } from '../../src/core/governance.js';
import { MaiClassification, GiaLayer, EntryStatus, GateStatus } from '../../src/shared/types.js';
import { ACE_MAI_CONFIG, GOVERNANCE_CONFIG } from '../../config/governance.config.js';
import { sanitize, detectPii, generateAuditId } from '../../src/shared/utils.js';
import { type IClassificationContext } from '../../src/core/mai/types.js';
import { GateRejectionError, ScoreFailureError } from '../../src/shared/errors.js';

describe('GIA Integration: Full Pipeline', () => {
  let engine: GovernanceEngine;

  beforeAll(() => {
    engine = new GovernanceEngine();
    engine.classifier.registerVertical(ACE_MAI_CONFIG);
    engine.enableAutoRun(); // auto-run for testing
    engine.initialize();
  });

  // ═══════════════════════════════════════════════
  // 1. ENGINE INITIALIZATION
  // ═══════════════════════════════════════════════
  describe('1. Engine Initialization', () => {
    it('should initialize successfully', () => {
      expect(engine.isHealthy()).toBe(true);
    });

    it('should record initialization in forensic ledger', () => {
      const initEntries = engine.ledger.queryByOperation('governance-engine-init');
      expect(initEntries.length).toBeGreaterThan(0);
      expect(initEntries[0].status).toBe(EntryStatus.COMPLETED);
    });

    it('should record auto-run enable in forensic ledger', () => {
      const autoRunEntries = engine.ledger.queryByOperation('auto-run-enabled');
      expect(autoRunEntries.length).toBeGreaterThan(0);
      expect(autoRunEntries[0].status).toBe(EntryStatus.COMPLETED);
    });

    it('should prevent double initialization', async () => {
      // initialize() is async — the guard rejects, it does not throw synchronously
      await expect(engine.initialize()).rejects.toThrow(/already initialized/);
    });

    it('should report full status', () => {
      const status = engine.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.autoRunMode).toBe(true);
      expect(status.ledgerSize).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 2. TOOL: classify_decision
  // ═══════════════════════════════════════════════
  describe('2. classify_decision (MAI Classifier)', () => {
    it('should classify a simple internal operation as INFORMATIONAL', () => {
      const context: IClassificationContext = {
        operation: 'status-check',
        inputSensitivity: 'PUBLIC',
        outputAudience: 'INTERNAL',
        hasFinancialImpact: false,
        hasLegalImpact: false,
        piiDetected: false,
      };
      const result = engine.classifier.classify('status-check', MaiClassification.INFORMATIONAL, context);

      expect(result.classification).toBe(MaiClassification.INFORMATIONAL);
      expect(result.requiresGate).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);

      // Record to threshold monitor
      engine.thresholdMonitor.record(result);
    });

    it('should elevate client-facing VA claims output to MANDATORY', () => {
      const context: IClassificationContext = {
        operation: 'generate-ecv-report',
        agentName: 'report-generator',
        vertical: 'ace',
        inputSensitivity: 'SOVEREIGN',
        outputAudience: 'CLIENT',
        hasFinancialImpact: false,
        hasLegalImpact: true,
        piiDetected: true,
      };
      const result = engine.classifier.classify(
        sanitize('Generate final ECV report for veteran claim'),
        MaiClassification.INFORMATIONAL,
        context
      );

      expect(result.classification).toBe(MaiClassification.MANDATORY);
      expect(result.requiresGate).toBe(true);
      expect(result.elevatedFrom).toBeDefined();

      engine.thresholdMonitor.record(result);
    });

    it('should use ACE vertical agent classification', () => {
      const context: IClassificationContext = {
        operation: 'intake-analysis',
        agentName: 'evidence-validator',
        vertical: 'ace',
        inputSensitivity: 'CONTROLLED',
        outputAudience: 'INTERNAL',
        hasFinancialImpact: false,
        hasLegalImpact: false,
        piiDetected: false,
      };
      const result = engine.classifier.classify('intake-analysis', MaiClassification.INFORMATIONAL, context);

      // evidence-validator is configured as ADVISORY in ACE_MAI_CONFIG
      expect(result.classification).toBe(MaiClassification.ADVISORY);
      engine.thresholdMonitor.record(result);
    });
  });

  // ═══════════════════════════════════════════════
  // 3. TOOL: approve_gate (MAI Gate)
  // ═══════════════════════════════════════════════
  describe('3. approve_gate (MAI Gate)', () => {
    it('should auto-approve in auto-run mode', async () => {
      const decision = await engine.gate.enforce(
        MaiClassification.MANDATORY, 'test-mandatory-op', 'audit-test-1'
      );
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.autoRunMode).toBe(true);
    });

    it('should list empty pending approvals in auto-run mode', () => {
      const pending = engine.gate.getPendingApprovals();
      expect(pending.length).toBe(0);
    });

    it('should require approval when auto-run disabled', async () => {
      engine.gate.setAutoRunMode(false);

      // Start enforce (returns pending promise)
      const enforcePromise = engine.gate.enforce(
        MaiClassification.MANDATORY, 'manual-approval-test', 'audit-manual-1'
      );

      // Verify pending
      const pending = engine.gate.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].operation).toBe('manual-approval-test');

      // Approve via gate API
      const gateId = pending[0].gateId;
      engine.gate.approve(gateId, 'ISSO-Storey', 'Integration test approval.');

      const decision = await enforcePromise;
      expect(decision.status).toBe(GateStatus.APPROVED);
      expect(decision.approvedBy).toBe('ISSO-Storey');

      // Re-enable auto-run for remaining tests
      engine.gate.setAutoRunMode(true);
    });
  });

  // ═══════════════════════════════════════════════
  // 4. TOOL: score_governance
  // ═══════════════════════════════════════════════
  describe('4. score_governance (Governance Scorer)', () => {
    it('should score a high-quality output', () => {
      const auditId = generateAuditId();
      const score = engine.scorer.score(
        { integrity: 0.95, accuracy: 0.90, compliance: 0.92 },
        'ecv-report-output', auditId
      );

      expect(score.composite).toBeGreaterThan(0.70);
      expect(engine.scorer.meetsThreshold(score)).toBe(true);
      expect(score.weights.integrity).toBe(0.40);
      expect(score.weights.accuracy).toBe(0.35);
      expect(score.weights.compliance).toBe(0.25);
    });

    it('should halt on critically low score', () => {
      expect(() => {
        engine.scorer.score(
          { integrity: 0.2, accuracy: 0.2, compliance: 0.2 },
          'garbage-output', generateAuditId()
        );
      }).toThrow(ScoreFailureError);
    });

    it('should flag mediocre output as below release threshold', () => {
      const score = engine.scorer.score(
        { integrity: 0.60, accuracy: 0.60, compliance: 0.60 },
        'mediocre-output', generateAuditId()
      );
      expect(engine.scorer.meetsThreshold(score)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  // 5. TOOL: evaluate_threshold (Storey Threshold)
  // ═══════════════════════════════════════════════
  describe('5. evaluate_threshold (Storey Threshold)', () => {
    it('should return a threshold reading', () => {
      const reading = engine.thresholdMonitor.getReading();

      expect(reading).toHaveProperty('escalationRate');
      expect(reading).toHaveProperty('status');
      expect(reading).toHaveProperty('isHealthy');
      expect(reading).toHaveProperty('windowSize');
      expect(reading.escalationRate).toBeGreaterThanOrEqual(0);
      expect(reading.escalationRate).toBeLessThanOrEqual(1);
    });

    it('should return a breakdown by classification', () => {
      const breakdown = engine.thresholdMonitor.getBreakdown();

      expect(breakdown).toHaveProperty('MANDATORY');
      expect(breakdown).toHaveProperty('ADVISORY');
      expect(breakdown).toHaveProperty('INFORMATIONAL');
      expect(breakdown.MANDATORY + breakdown.ADVISORY + breakdown.INFORMATIONAL).toBeGreaterThan(0);
    });

    it('should produce a health assessment', () => {
      const health = engine.healthAssessor.assess();

      expect(health).toHaveProperty('recommendation');
      expect(health).toHaveProperty('severity');
      expect(health).toHaveProperty('actionRequired');
    });
  });

  // ═══════════════════════════════════════════════
  // 6. TOOL: audit_pipeline (Forensic Ledger)
  // ═══════════════════════════════════════════════
  describe('6. audit_pipeline (Forensic Ledger)', () => {
    it('should have entries from initialization and operations', () => {
      expect(engine.ledger.size).toBeGreaterThan(0);
    });

    it('should preserve full state-transition history (append-only proof)', () => {
      // Create a new operation and complete it
      const entry = engine.ledger.begin('audit-test-op', MaiClassification.ADVISORY, GiaLayer.CORE, 'test-actor');
      const score = engine.scorer.scoreDefault('audit-test-op');
      const completed = entry.complete(score, {
        classification: MaiClassification.ADVISORY,
        confidence: 0.9,
        rationale: 'Integration test.',
        requiresGate: false,
      });
      engine.ledger.record(completed);

      // Verify both STARTED and COMPLETED exist
      const history = engine.ledger.getEntryHistory(entry.id);
      expect(history.length).toBe(2);
      expect(history[0].status).toBe(EntryStatus.STARTED);
      expect(history[1].status).toBe(EntryStatus.COMPLETED);
      expect(history[1].governanceScore).toBeDefined();
    });

    it('should query by operation name', () => {
      const results = engine.ledger.queryByOperation('governance-engine-init');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should query by time range', () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const results = engine.ledger.queryByTimeRange(hourAgo, now);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 7. TOOL: monitor_agents (Supervisor)
  // ═══════════════════════════════════════════════
  describe('7. monitor_agents (Supervisor)', () => {
    it('should evaluate agent output and track state', () => {
      const score = engine.scorer.score(
        { integrity: 0.88, accuracy: 0.85, compliance: 0.90 },
        'agent-eval', generateAuditId()
      );

      engine.supervisor.evaluate('test-agent', score, EntryStatus.COMPLETED, generateAuditId());

      const states = engine.supervisor.getAllStates();
      expect(states.has('test-agent')).toBe(true);

      const state = states.get('test-agent')!;
      expect(state.lastStatus).toBe(EntryStatus.COMPLETED);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('should track consecutive failures', () => {
      const lowScore = engine.scorer.score(
        { integrity: 0.55, accuracy: 0.55, compliance: 0.55 },
        'failing-agent-eval', generateAuditId()
      );

      // Pass FAILED status to increment consecutive failures
      engine.supervisor.evaluate('failing-agent', lowScore, EntryStatus.FAILED, generateAuditId());
      engine.supervisor.evaluate('failing-agent', lowScore, EntryStatus.FAILED, generateAuditId());

      const states = engine.supervisor.getAllStates();
      const state = states.get('failing-agent')!;
      expect(state.consecutiveFailures).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 8. TOOL: map_compliance
  // ═══════════════════════════════════════════════
  describe('8. map_compliance', () => {
    // This tool uses static data, but we verify it's accessible
    it('should map to NIST AI RMF controls', () => {
      // The compliance mappings are in the tool file, but we can verify
      // the engine's components exist for each mapped control
      expect(engine.classifier).toBeDefined();    // GOVERN 1.1, MAP 1.1
      expect(engine.scorer).toBeDefined();         // MEASURE 2.1
      expect(engine.thresholdMonitor).toBeDefined(); // MANAGE 1.1
      expect(engine.gate).toBeDefined();           // Art. 14
      expect(engine.ledger).toBeDefined();         // Art. 12, AU-2
    });
  });

  // ═══════════════════════════════════════════════
  // 9. TOOL: assess_risk_tier
  // ═══════════════════════════════════════════════
  describe('9. assess_risk_tier', () => {
    it('should detect PII in input', () => {
      expect(detectPii('John Smith, SSN 123-45-6789')).toBe(true);
      expect(detectPii('generic system status check')).toBe(false);
    });

    it('should sanitize input strings', () => {
      const dirty = '<script>alert("xss")</script>Hello';
      const clean = sanitize(dirty);
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Hello');
    });
  });

  // ═══════════════════════════════════════════════
  // 10. TOOL: generate_report
  // ═══════════════════════════════════════════════
  describe('10. generate_report', () => {
    it('should produce a complete status snapshot', () => {
      const status = engine.getStatus();
      const health = engine.healthAssessor.assess();
      const telemetry = engine.telemetry.snapshot();
      const threshold = engine.thresholdMonitor.getReading();
      const breakdown = engine.thresholdMonitor.getBreakdown();

      // Verify all report data sources are available
      expect(status.initialized).toBe(true);
      expect(health).toHaveProperty('severity');
      expect(telemetry).toHaveProperty('totalOperations');
      expect(threshold).toHaveProperty('escalationRate');
      expect(breakdown).toHaveProperty('MANDATORY');

      // Verify telemetry tracks operations
      expect(telemetry.totalOperations).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 11. TOOL: system_status
  // ═══════════════════════════════════════════════
  describe('11. system_status', () => {
    it('should return complete system status', () => {
      const status = engine.getStatus();

      expect(status).toHaveProperty('initialized');
      expect(status).toHaveProperty('startedAt');
      expect(status).toHaveProperty('uptime');
      expect(status).toHaveProperty('ledgerSize');
      expect(status).toHaveProperty('thresholdHealth');
      expect(status).toHaveProperty('telemetry');
      expect(status).toHaveProperty('autoRunMode');

      expect(status.initialized).toBe(true);
      expect(status.autoRunMode).toBe(true);
      expect(typeof status.uptime).toBe('number');
      expect((status.uptime as number)).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 12. FULL PIPELINE FLOW: End-to-End
  // ═══════════════════════════════════════════════
  describe('12. Full Pipeline Flow: Classify → Gate → Execute → Score → Audit', () => {
    it('should complete a full governed operation lifecycle', async () => {
      // Step 1: Begin audit
      const entry = engine.ledger.begin(
        'full-pipeline-test', MaiClassification.ADVISORY, GiaLayer.CORE, 'integration-test'
      );

      // Step 2: Classify
      const context: IClassificationContext = {
        operation: 'full-pipeline-test',
        agentName: 'evidence-validator',
        vertical: 'ace',
        inputSensitivity: 'CONTROLLED',
        outputAudience: 'INTERNAL',
        hasFinancialImpact: false,
        hasLegalImpact: false,
        piiDetected: false,
      };
      const classification = engine.classifier.classify('full-pipeline-test', MaiClassification.INFORMATIONAL, context);
      expect(classification.classification).toBe(MaiClassification.ADVISORY); // ACE intake is ADVISORY

      // Step 3: Enforce gate
      const gateDecision = await engine.gate.enforce(classification.classification, 'full-pipeline-test', entry.id);
      expect(gateDecision.status).toBe(GateStatus.APPROVED); // auto-run mode

      // Step 4: "Execute" operation (simulated)
      const operationResult = { analysis: 'Veteran records reviewed. 3 conditions identified.' };

      // Step 5: Score output
      const score = engine.scorer.score(
        { integrity: 0.92, accuracy: 0.88, compliance: 0.95 },
        'full-pipeline-test', entry.id
      );
      expect(engine.scorer.meetsThreshold(score)).toBe(true);

      // Step 6: Supervisor evaluation
      engine.supervisor.evaluate('evidence-validator', score, EntryStatus.COMPLETED, entry.id);
      const agentState = engine.supervisor.getAllStates().get('evidence-validator');
      expect(agentState?.lastStatus).toBe(EntryStatus.COMPLETED);

      // Step 7: Record threshold
      engine.thresholdMonitor.record(classification);

      // Step 8: Complete audit
      const completed = entry.complete(score, classification, gateDecision);
      engine.ledger.record(completed);

      // Step 9: Verify full audit trail
      const history = engine.ledger.getEntryHistory(entry.id);
      expect(history.length).toBe(2); // STARTED + COMPLETED
      expect(history[0].status).toBe(EntryStatus.STARTED);
      expect(history[1].status).toBe(EntryStatus.COMPLETED);
      expect(history[1].governanceScore?.composite).toBeGreaterThan(0.70);
      expect(history[1].gateDecision?.status).toBe(GateStatus.APPROVED);

      // The pipeline is COMPLETE. Every governance checkpoint passed.
    });

    it('should halt pipeline on critically low score', () => {
      const entry = engine.ledger.begin(
        'halt-pipeline-test', MaiClassification.MANDATORY, GiaLayer.CORE, 'integration-test'
      );

      // Attempt to score garbage output → should throw
      expect(() => {
        engine.scorer.score(
          { integrity: 0.1, accuracy: 0.1, compliance: 0.1 },
          'halt-pipeline-test', entry.id
        );
      }).toThrow(ScoreFailureError);

      // Record the failure
      const failed = entry.fail(new Error('Score below halt threshold'), MaiClassification.MANDATORY);
      engine.ledger.record(failed);

      // Verify failure is in audit trail
      const latest = engine.ledger.getEntry(entry.id);
      expect(latest?.status).toBe(EntryStatus.FAILED);
    });
  });

  // ═══════════════════════════════════════════════
  // 13. GOVERNANCE INHERITANCE VERIFICATION
  // ═══════════════════════════════════════════════
  describe('13. Governance Inheritance Verification', () => {
    it('all CORE components should be accessible from engine', () => {
      expect(engine.ledger).toBeDefined();
      expect(engine.classifier).toBeDefined();
      expect(engine.gate).toBeDefined();
      expect(engine.scorer).toBeDefined();
      expect(engine.thresholdMonitor).toBeDefined();
      expect(engine.healthAssessor).toBeDefined();
      expect(engine.supervisor).toBeDefined();
      expect(engine.telemetry).toBeDefined();
    });

    it('engine should track creation time', () => {
      expect(engine.startedAt).toBeInstanceOf(Date);
      expect(engine.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
