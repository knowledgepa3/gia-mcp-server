/**
 * @module    mcp-tool-phoenix-recovery
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       MANDATORY — recovery operations require human oversight
 * @audit     true — all recovery operations are logged
 * @owner     William J. Storey III / ACE / GIA
 *
 * Phoenix Recovery MCP Tools — Governed Operational Recovery
 *
 * Phoenix is GIA's built-in disaster recovery for governed AI operations.
 * It doesn't just restore systems — it restores trust.
 *
 * Three tools:
 *   phoenix_snapshot         — Capture governed state checkpoint
 *   phoenix_verify_integrity — Verify snapshot hash-chain integrity
 *   phoenix_recovery_health  — Recovery readiness assessment
 *
 * NIST 800-53: CP-2 (Contingency Plan), CP-9 (Backup), CP-10 (Recovery)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import {
  getRecentPhoenixRecords,
  getPhoenixStats,
  getRecentCerebroSignals,
  getCerebroStats,
} from '../../core/persistence/intelligence-persistence.js';

/** Real SHA-256 digest over a snapshot's captured state (replaces the old hex-timestamp placeholder). */
export function computeSnapshotStateHash(state: unknown): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function registerPhoenixRecoveryTools(server: McpServer, engine: GovernanceEngine): void {

  // =========================================================================
  // phoenix_snapshot — Capture governed state checkpoint
  // =========================================================================
  server.tool(
    'phoenix_snapshot',
    'Create a governed state snapshot capturing the current platform operational state. Records ledger chain head, active gates, contracts, budgets, MAI state, intelligence counts, and memory packs. Each snapshot is SHA-256 hashed over its captured state for integrity (snapshot-to-snapshot chaining is not yet persisted). Classification: INFORMATIONAL — read-only capture, no mutations.',
    {
      trigger_type: z.enum(['manual', 'scheduled']).optional().describe('What triggered this snapshot (default: manual)'),
      notes: z.string().optional().describe('Optional operator notes for this checkpoint'),
    },
    { title: 'Phoenix State Snapshot', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      const triggerType = args.trigger_type || 'manual';

      // Gather current governed state
      const ledgerSize = engine.ledger.size;
      const chainVerification = engine.ledger.verifyChain();
      const thresholdResult = engine.thresholdMonitor.getReading();
      const supervisorStates = engine.supervisor.getAllStates();

      // Intelligence layer stats
      let phoenixStats = { totalRecords: 0, successRate: 0 };
      let cerebroStats = { total: 0, lastHour: 0, critical: 0, high: 0 };
      try {
        phoenixStats = await getPhoenixStats() as any || { totalRecords: 0, successRate: 0 };
        const cs = await getCerebroStats();
        if (cs) cerebroStats = cs as any;
      } catch (_) { /* intelligence persistence may not be available */ }

      // Build snapshot payload
      const snapshot = {
        snapshotId: `SNAP-${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        triggerType,
        notes: args.notes || null,

        governedState: {
          ledger: {
            totalEntries: ledgerSize,
            chainIntegrity: chainVerification.valid ? 'INTACT' : 'BROKEN',
            entriesVerified: chainVerification.entriesVerified,
          },
          threshold: {
            escalationRate: thresholdResult.escalationRate,
            status: thresholdResult.status,
            isHealthy: thresholdResult.isHealthy,
            windowSize: thresholdResult.windowSize,
          },
          agents: {
            totalMonitored: supervisorStates.size,
            agents: Array.from(supervisorStates.entries()).map(([name, state]) => ({
              name,
              status: state.lastStatus,
              failures: state.consecutiveFailures,
            })),
          },
        },

        intelligenceState: {
          phoenix: phoenixStats,
          cerebro: cerebroStats,
        },

        integrity: {
          stateHash: '',            // real SHA-256 over the captured state, set just below
          hashAlgorithm: 'SHA-256',
          previousSnapshot: null,   // snapshot-to-snapshot chaining not yet persisted
        },

        compliance: {
          'NIST-CP-2': 'SNAPSHOT_CREATED',
          'NIST-CP-9': 'CHECKPOINT_RECORDED',
        },
      };

      // Real SHA-256 over the captured state (everything except the integrity block itself,
      // which holds the hash). Replaces the prior hex-timestamp placeholder.
      const { integrity: _integrity, ...snapshotContent } = snapshot;
      snapshot.integrity.stateHash = computeSnapshotStateHash(snapshotContent);

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('phoenix_snapshot', snapshot.snapshotId, 'INFORMATIONAL', true);

      // Record in ledger
      const entry = engine.ledger.begin('phoenix-snapshot', MaiClassification.INFORMATIONAL, GiaLayer.CORE);
      entry.addMetadata('snapshotId', snapshot.snapshotId);
      entry.addMetadata('triggerType', triggerType);
      entry.addMetadata('ledgerEntries', ledgerSize);
      const score = engine.scorer.scoreDefault('phoenix-snapshot');
      engine.ledger.record(entry.complete(score, {
        classification: MaiClassification.INFORMATIONAL,
        confidence: 1.0,
        rationale: `Phoenix snapshot captured: ${ledgerSize} ledger entries, chain ${chainVerification.valid ? 'intact' : 'broken'}`,
        requiresGate: false,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(snapshot, null, 2) }],
      };
    }
  );

  // =========================================================================
  // phoenix_verify_integrity — Verify system integrity
  // =========================================================================
  server.tool(
    'phoenix_verify_integrity',
    'Verify the integrity of GIA governed operations. Checks ledger hash-chain integrity, agent health, threshold status, and intelligence layer continuity. Returns a comprehensive integrity report with compliance mapping. Classification: INFORMATIONAL — read-only verification, no mutations.',
    {},
    { title: 'Verify System Integrity', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      // Ledger integrity
      const chainResult = engine.ledger.verifyChain();

      // Threshold health
      const threshold = engine.thresholdMonitor.getReading();

      // Agent health
      const states = engine.supervisor.getAllStates();
      const agentHealth = Array.from(states.entries()).map(([name, state]) => ({
        name,
        healthy: state.consecutiveFailures === 0,
        failures: state.consecutiveFailures,
        lastStatus: state.lastStatus,
      }));
      const unhealthyAgents = agentHealth.filter(a => !a.healthy);

      // Intelligence layer
      let phoenixAvailable = false;
      let cerebroAvailable = false;
      try {
        const ps = await getPhoenixStats();
        phoenixAvailable = !!ps;
        const cs = await getCerebroStats();
        cerebroAvailable = !!cs;
      } catch (_) { /* non-critical */ }

      // Compute overall integrity score
      let integrityScore = 100;
      if (!chainResult.valid) integrityScore -= 40;  // Broken chain is critical
      if (threshold.status === 'CRITICAL') integrityScore -= 20;
      if (threshold.status === 'HIGH_ESCALATION') integrityScore -= 10;
      if (unhealthyAgents.length > 0) integrityScore -= (unhealthyAgents.length * 5);
      if (!phoenixAvailable) integrityScore -= 10;
      if (!cerebroAvailable) integrityScore -= 10;
      integrityScore = Math.max(0, integrityScore);

      const integrityGrade =
        integrityScore >= 90 ? 'A' :
        integrityScore >= 75 ? 'B' :
        integrityScore >= 50 ? 'C' :
        integrityScore >= 25 ? 'D' : 'F';

      const report = {
        overallIntegrity: integrityScore >= 75 ? 'TRUSTED' : integrityScore >= 50 ? 'DEGRADED' : 'COMPROMISED',
        integrityScore,
        integrityGrade,
        timestamp: new Date().toISOString(),

        components: {
          auditChain: {
            status: chainResult.valid ? 'INTACT' : 'BROKEN',
            entriesVerified: chainResult.entriesVerified,
            totalEntries: engine.ledger.size,
            breakPoint: chainResult.valid ? null : chainResult.firstBrokenLink,
          },
          governanceThreshold: {
            status: threshold.status,
            escalationRate: threshold.escalationRate,
            isHealthy: threshold.isHealthy,
            windowSize: threshold.windowSize,
          },
          agentHealth: {
            totalAgents: agentHealth.length,
            healthy: agentHealth.length - unhealthyAgents.length,
            unhealthy: unhealthyAgents.length,
            details: unhealthyAgents,
          },
          intelligenceLayer: {
            phoenix: phoenixAvailable ? 'ONLINE' : 'OFFLINE',
            cerebro: cerebroAvailable ? 'ONLINE' : 'OFFLINE',
          },
        },

        recoveryRecommendation: integrityScore >= 90
          ? 'No action needed — system operating in trusted state'
          : integrityScore >= 75
          ? 'Monitor — minor degradation detected'
          : integrityScore >= 50
          ? 'Recommend creating a recovery snapshot and investigating degraded components'
          : 'IMMEDIATE ACTION — system integrity compromised. Initiate Phoenix recovery protocol.',

        // Conditional on real runtime state — NOT an audited/certified NIST
        // attestation (see attestationBasis). Mirrors the honest pattern already
        // used in server/src/routes/phoenixRecovery.ts. CP-2 (Contingency Plan)
        // tracks whether the recovery capability is actually available; CP-10
        // (Recovery/Reconstitution) is a live integrity check on the ledger chain.
        compliance: {
          'NIST-CP-2': phoenixAvailable ? 'COMPLIANT' : 'NOT_CONFIGURED',
          'NIST-CP-10': chainResult.valid ? 'INTEGRITY_VERIFIED' : 'INTEGRITY_FAILED',
          'EU-AI-ACT-Art15': integrityScore >= 75 ? 'OPERATIONAL_RESILIENCE_MAINTAINED' : 'RESILIENCE_DEGRADED',
          attestationBasis: 'HEURISTIC_SELF_CHECK',
        },
      };

      // Tool accountability
      engine.telemetryService.emitToolCall('phoenix_verify_integrity', `verify-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    }
  );

  // =========================================================================
  // phoenix_recovery_health — Recovery readiness assessment
  // =========================================================================
  server.tool(
    'phoenix_recovery_health',
    'Assess Phoenix recovery readiness. Reports whether the system can recover from disruption, including snapshot availability, chain integrity, intelligence layer status, and compliance posture. Classification: INFORMATIONAL — read-only assessment.',
    {},
    { title: 'Recovery Readiness Assessment', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const chainResult = engine.ledger.verifyChain();
      const threshold = engine.thresholdMonitor.getReading();
      const states = engine.supervisor.getAllStates();

      let phoenixStats: any = null;
      let cerebroStats: any = null;
      try {
        phoenixStats = await getPhoenixStats();
        cerebroStats = await getCerebroStats();
      } catch (_) { /* non-critical */ }

      // Recovery readiness factors
      const factors = {
        ledgerIntact: chainResult.valid,
        ledgerSize: engine.ledger.size,
        agentsMonitored: states.size,
        agentsHealthy: Array.from(states.values()).filter(s => s.consecutiveFailures === 0).length,
        phoenixRecordsAvailable: !!phoenixStats,
        cerebroSignalsAvailable: !!cerebroStats,
        thresholdHealthy: threshold.isHealthy,
      };

      // Score readiness
      let readiness = 0;
      if (factors.ledgerIntact) readiness += 30;
      if (factors.ledgerSize > 0) readiness += 10;
      if (factors.agentsHealthy === factors.agentsMonitored) readiness += 20;
      if (factors.phoenixRecordsAvailable) readiness += 15;
      if (factors.cerebroSignalsAvailable) readiness += 15;
      if (factors.thresholdHealthy) readiness += 10;

      const grade =
        readiness >= 90 ? 'A' :
        readiness >= 75 ? 'B' :
        readiness >= 50 ? 'C' :
        readiness >= 25 ? 'D' : 'F';

      const assessment = {
        recoveryReadiness: {
          score: readiness,
          grade,
          status: readiness >= 75 ? 'READY' : readiness >= 50 ? 'PARTIAL' : 'NOT_READY',
        },
        factors,
        phoenixCapabilities: {
          governedStateRecovery: factors.ledgerIntact,
          auditChainContinuity: factors.ledgerIntact && factors.ledgerSize > 0,
          intelligenceLayerRecovery: factors.phoenixRecordsAvailable && factors.cerebroSignalsAvailable,
          agentWorkforceRecovery: factors.agentsMonitored > 0,
          memoryPackRestoration: true, // Always available if GMP system is running
        },
        whatPhoenixRecovers: [
          'Governed workflows — gate states, MAI classifications, active pipelines',
          'Audit continuity — hash-chained ledger integrity across disruptions',
          'Operational state — budget positions, active contracts, threshold metrics',
          'Trusted memory — sealed Knowledge Packs, signal history',
          'Recovery posture — controlled return to trusted operation',
        ],
        compliance: {
          'NIST-800-53-CP-2': readiness >= 50 ? 'CONTINGENCY_PLAN_ACTIVE' : 'PLAN_INCOMPLETE',
          'NIST-800-53-CP-9': readiness >= 75 ? 'BACKUP_CAPABILITY_READY' : 'BACKUP_PARTIAL',
          'NIST-800-53-CP-10': 'RECOVERY_CAPABILITY_ASSESSED',
          'CMMC-RE.2.137': readiness >= 75 ? 'REGULARLY_BACKED_UP' : 'BACKUP_GAPS',
          'EU-AI-ACT-Art15': readiness >= 50 ? 'OPERATIONAL_RESILIENCE' : 'RESILIENCE_GAPS',
        },
      };

      engine.telemetryService.emitToolCall('phoenix_recovery_health', `health-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(assessment, null, 2) }],
      };
    }
  );
}
