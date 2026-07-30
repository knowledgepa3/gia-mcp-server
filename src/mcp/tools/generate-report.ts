/**
 * @module    mcp-tool-generate-report
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — records a report summary, non-blocking (no gate)
 * @audit     true — appends a 'generate-report' entry to the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { GIA_VERSION, GIA_AUTHOR } from '../../shared/constants.js';
import { EntryStatus, MaiClassification, GiaLayer } from '../../shared/types.js';

/** Lean summary of a generated report — what gets anchored (not the full body). */
export interface GovernanceReportSummary {
  systemHealthStatus: string;
  thresholdRate: string;
  thresholdStatus: string;
  auditChainIntegrity: string;
  totalOperations: number;
}

/**
 * Anchor a governance report in the immutable forensic ledger as a
 * 'generate-report' entry. Records a LEAN summary (health, threshold, chain
 * integrity, op count) — never the full multi-KB report body, keeping ledger
 * metadata compact. INFORMATIONAL + requiresGate:false. No PII — aggregate
 * governance metrics only.
 */
export function recordGovernanceReport(
  engine: GovernanceEngine,
  format: string,
  summary: GovernanceReportSummary,
): string {
  const entry = engine.ledger.begin('generate-report', MaiClassification.INFORMATIONAL, GiaLayer.CORE, 'SYSTEM');
  entry.addMetadata('format', format);
  entry.addMetadata('systemHealthStatus', summary.systemHealthStatus);
  entry.addMetadata('thresholdRate', summary.thresholdRate);
  entry.addMetadata('thresholdStatus', summary.thresholdStatus);
  entry.addMetadata('auditChainIntegrity', summary.auditChainIntegrity);
  entry.addMetadata('totalOperations', summary.totalOperations);

  const score = engine.scorer.scoreDefault('generate-report');
  const completedEntry = entry.complete(score, {
    classification: MaiClassification.INFORMATIONAL,
    confidence: 0.85,
    rationale: `Governance report generated (${format}): health=${summary.systemHealthStatus}, chain=${summary.auditChainIntegrity}`,
    requiresGate: false,
  });
  engine.ledger.record(completedEntry);
  return entry.id;
}
import { getIntelligenceStats } from '../../core/persistence/intelligence-persistence.js';
import { getDroppedCounts, getDroppedValueMetricCount } from '../../core/persistence/telemetry-persistence.js';
import { getDroppedSessionCount } from '../../core/persistence/runtime-persistence.js';

export function registerGenerateReportTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'generate_report',
    'Generate a governance status report. Includes system health, threshold status, compliance coverage, and operational metrics.',
    {
      format: z.enum(['summary', 'detailed', 'executive']).default('summary').describe('Report format'),
    },
    { title: 'Generate Governance Report', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const status = engine.getStatus();
      const health = engine.healthAssessor.assess();
      const telemetry = engine.telemetry.snapshot();
      const threshold = engine.thresholdMonitor.getReading();
      const breakdown = engine.thresholdMonitor.getBreakdown();

      // Verify hash chain integrity — compliance evidence for every report
      const chainVerification = engine.ledger.verifyChain();

      // Intelligence data from PostgreSQL (Phoenix + Cerebro)
      const intelligence = await getIntelligenceStats();

      // Quality dimensions from governance telemetry
      const qualityDimensions = engine.telemetry.getQualityDimensions(14);

      const report: Record<string, unknown> = {
        reportType: `GIA Governance Report (${input.format})`,
        generatedAt: new Date().toISOString(),
        version: GIA_VERSION,
        author: GIA_AUTHOR,
        systemHealth: {
          status: health.severity,
          thresholdRate: `${(threshold.escalationRate * 100).toFixed(1)}%`,
          thresholdStatus: threshold.status,
          isHealthy: threshold.isHealthy,
          recommendation: health.recommendation,
        },
        auditChain: {
          integrity: chainVerification.valid ? 'INTACT' : 'BROKEN',
          entriesVerified: chainVerification.entriesVerified,
          chainHead: chainVerification.headHash,
          verificationDurationMs: chainVerification.verificationDurationMs,
          ...(chainVerification.valid ? {} : {
            firstBrokenLink: chainVerification.firstBrokenLink,
            breakDetail: chainVerification.breakDetail,
          }),
        },
        operations: {
          total: telemetry.totalOperations,
          completed: telemetry.completedOperations,
          failed: telemetry.failedOperations,
          escalated: telemetry.escalatedOperations,
          active: telemetry.activeOperations,
          avgDurationMs: telemetry.avgDurationMs,
        },
        // Recent failures with identifiable details — operators can diagnose what went wrong
        recentFailures: (() => {
          const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
          const failures = engine.ledger.queryByTimeRange(fourteenDaysAgo, new Date())
            .filter(e => e.status === EntryStatus.FAILED)
            .slice(-10);
          return failures.length > 0
            ? failures.map(f => ({
                auditId: f.id,
                operation: f.operation,
                timestamp: f.timestamp.toISOString(),
                errorCode: f.errorCode ?? 'UNKNOWN',
                errorSummary: f.errorMessage ?? 'No error message recorded',
                maiLevel: f.maiLevel,
                actor: f.actor,
                durationMs: f.duration,
              }))
            : 'No failures in the last 14 days';
        })(),
        maiBreakdown: {
          mandatory: breakdown.MANDATORY,
          advisory: breakdown.ADVISORY,
          informational: breakdown.INFORMATIONAL,
        },
        autoRunMode: engine.gate.isAutoRunMode,

        // ── QUALITY DIMENSIONS (evidence-completeness) ──
        correctiveActionReview: {
          coveragePct: `${qualityDimensions.correctiveActionReview.coveragePct}%`,
          avgComposite: qualityDimensions.correctiveActionReview.avgComposite,
          belowThresholdCount: qualityDimensions.correctiveActionReview.belowThresholdCount,
          totalScoringEvents: qualityDimensions.correctiveActionReview.totalScoringEvents,
          status: qualityDimensions.correctiveActionReview.status,
        },
        oversightReview: {
          gatesTriggered: qualityDimensions.oversightReview.gatesTriggered,
          humanInterventions: qualityDimensions.oversightReview.humanInterventions,
          mandatoryOperations: qualityDimensions.oversightReview.mandatoryOperations,
          coveragePct: `${qualityDimensions.oversightReview.coveragePct}%`,
          status: qualityDimensions.oversightReview.status,
        },
        adversarialDefenseSummary: {
          probesExecuted: qualityDimensions.adversarialDefenseSummary.probesExecuted,
          probesPassed: qualityDimensions.adversarialDefenseSummary.probesPassed,
          passRatePct: `${qualityDimensions.adversarialDefenseSummary.passRatePct}%`,
          lastProbeAt: qualityDimensions.adversarialDefenseSummary.lastProbeAt?.toISOString() || null,
          status: qualityDimensions.adversarialDefenseSummary.status,
        },
        delegationAccountability: {
          totalDelegations: qualityDimensions.delegationAccountability.totalDelegations,
          driftCount: qualityDimensions.delegationAccountability.driftCount,
          activeDelegations: qualityDimensions.delegationAccountability.activeDelegations,
          uniqueParentAgents: qualityDimensions.delegationAccountability.uniqueParentAgents,
          uniqueSubAgents: qualityDimensions.delegationAccountability.uniqueSubAgents,
          status: qualityDimensions.delegationAccountability.status,
        },
        evidencePenalties: qualityDimensions.evidencePenalties.length > 0
          ? qualityDimensions.evidencePenalties.map(p => ({
              dimension: p.dimension,
              penalty: `-${p.penalty}%`,
              reason: p.reason,
            }))
          : 'No penalties — full evidence coverage',
        governanceQualityScore: {
          frameworkScore: qualityDimensions.governanceQualityScore.frameworkScore,
          evidenceScore: qualityDimensions.governanceQualityScore.evidenceScore,
          compositeQuality: `${qualityDimensions.governanceQualityScore.compositeQuality}%`,
          assessment: qualityDimensions.governanceQualityScore.compositeQuality >= 90
            ? 'EXCELLENT — framework and evidence fully aligned'
            : qualityDimensions.governanceQualityScore.compositeQuality >= 70
            ? 'GOOD — evidence mostly complete, minor gaps'
            : qualityDimensions.governanceQualityScore.compositeQuality >= 50
            ? 'ADEQUATE — significant evidence gaps need attention'
            : 'INSUFFICIENT — governance evidence critically incomplete',
        },
        toolAccountability: {
          activeToolCount: qualityDimensions.toolAccountability.activeToolCount,
          totalInvocations: qualityDimensions.toolAccountability.totalInvocations,
          registeredTools: qualityDimensions.toolAccountability.registeredTools,
          untrackedTools: qualityDimensions.toolAccountability.untrackedTools.length > 0
            ? qualityDimensions.toolAccountability.untrackedTools
            : 'All tools governed',
          toolUsage: qualityDimensions.toolAccountability.toolUsage,
          toolPerformance: Object.keys(qualityDimensions.toolAccountability.toolPerformance).length > 0
            ? qualityDimensions.toolAccountability.toolPerformance
            : 'No tool performance data — invoke tools to generate metrics',
          toolClassBreakdown: qualityDimensions.toolAccountability.toolClassBreakdown,
          riskTierBreakdown: qualityDimensions.toolAccountability.riskTierBreakdown,
          status: qualityDimensions.toolAccountability.status,
          governedToolRegistry: `${qualityDimensions.toolAccountability.registeredTools} tools with risk class, MAI baseline, and accountability profile`,
        },
        persistenceMode: {
          strategy: 'fire-and-forget',
          description: 'Ledger entries are recorded in-memory synchronously and persisted to PostgreSQL asynchronously. DB writes never block pipeline execution.',
          crashRecovery: 'On restart, entries are recovered from PostgreSQL. Entries written to memory but not yet persisted at crash time are lost (typically <100ms window).',
          recommendation: 'For zero-loss guarantee, enable WAL-based PostgreSQL replication.',
        },
        telemetryPipeline: {
          bufferSize: engine.telemetryService.bufferSize,
          droppedEvents: getDroppedCounts(),
          droppedSessions: getDroppedSessionCount(),
          droppedValueMetrics: getDroppedValueMetricCount(),
          status: 'ACTIVE',
        },
        runtimeAccountability: (() => {
          const runtimeStats = engine.runtimeService.getStats();
          const instanceCtx = engine.runtimeService.getInstanceContext();
          return {
            instanceId: instanceCtx.instanceId,
            environment: instanceCtx.environment,
            configFingerprint: instanceCtx.configFingerprint,
            bootedAt: instanceCtx.bootedAt,
            uptimeMs: instanceCtx.uptimeMs,
            totalSessionsStarted: instanceCtx.totalSessionsStarted,
            activeSessions: runtimeStats.activeSessions,
            completedSessions: runtimeStats.completedSessions,
            failedSessions: runtimeStats.failedSessions,
            avgLatencyMs: runtimeStats.avgLatencyMs,
            totalTokens: runtimeStats.totalTokens,
            totalCostUsd: runtimeStats.totalCostUsd,
            uniqueAgents: runtimeStats.uniqueAgents,
            breakGlassCount: runtimeStats.breakGlassCount,
            retryTotal: runtimeStats.retryTotal,
            fallbackTotal: runtimeStats.fallbackTotal,
            recentSessions: engine.runtimeService.getRecentSessions(10),
            status: runtimeStats.activeSessions > 0 ? 'SESSIONS_ACTIVE' : 'IDLE',
          };
        })(),

        intelligence: {
          phoenix: {
            totalRuns: intelligence.phoenix.totalRecords,
            last24h: intelligence.phoenix.last24hRecords,
            successRate: intelligence.phoenix.totalRecords > 0
              ? `${Math.round((intelligence.phoenix.successCount / intelligence.phoenix.totalRecords) * 100)}%`
              : 'N/A',
            avgTokenEfficiency: intelligence.phoenix.avgTokenEfficiency,
            workforceBreakdown: intelligence.phoenix.workforceBreakdown,
            topGatePatterns: intelligence.phoenix.topGatePatterns,
          },
          cerebro: {
            totalSignals: intelligence.cerebro.totalSignals,
            last24h: intelligence.cerebro.last24hSignals,
            lastHour: intelligence.cerebro.lastHourSignals,
            severityBreakdown: {
              critical: intelligence.cerebro.criticalCount,
              high: intelligence.cerebro.highCount,
              medium: intelligence.cerebro.mediumCount,
              low: intelligence.cerebro.lowCount,
            },
            typeBreakdown: intelligence.cerebro.typeBreakdown,
            avgConfidence: intelligence.cerebro.avgConfidence,
          },
          persistenceActive: intelligence.persistenceEnabled,
        },
        aiManagementSystem: {
          standard: 'ISO/IEC 42001:2023',
          scope: 'AI Workforce Governance — Operational Intelligence',
          frameworksCovered: [
            'NIST AI RMF',
            'EU AI Act',
            'ISO 42001',
            'NIST 800-53',
            'LINDDUN (Privacy Threat Modeling)',
            'MITRE ATLAS (AI Threat Modeling)',
          ],
          coreCapabilities: {
            decisionControls: 'MAI Classification (Mandatory/Advisory/Informational)',
            cryptographicGovernance: 'Rolling Code Gate — tamper-proof stage verification',
            auditChain: 'SHA-256 hash-chained forensic ledger',
            knowledgePacks: 'Sealed, TTL-bound institutional knowledge artifacts',
            continuousValidation: 'Autonomous adversarial boundary testing (26 probes, 10 categories)',
            signalIntelligence: 'Cross-run anomaly detection and signal correlation',
            workforceContracts: 'Executable governance specifications for AI agent teams',
          },
        },
      };

      // Anchor a lean summary of the report in the immutable forensic ledger.
      const auditId = recordGovernanceReport(engine, input.format, {
        systemHealthStatus: health.severity,
        thresholdRate: `${(threshold.escalationRate * 100).toFixed(1)}%`,
        thresholdStatus: threshold.status,
        auditChainIntegrity: chainVerification.valid ? 'INTACT' : 'BROKEN',
        totalOperations: telemetry.totalOperations,
      });

      // Tool accountability tracking — correlated to the ledger entry via auditId.
      engine.telemetryService.emitToolCall('generate_report', auditId, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    }
  );
}
