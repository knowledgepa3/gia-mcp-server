/**
 * @module    mcp-tool-evaluate-threshold
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       INFORMATIONAL — records a threshold reading, non-blocking (no gate)
 * @audit     true — appends an 'evaluate-threshold' entry to the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';

/** Minimal shape of a Storey Threshold reading needed for the ledger record. */
interface ThresholdReadingLike {
  escalationRate: number;
  status: string;
  isHealthy: boolean;
  windowSize: number;
}

/**
 * Anchor a Storey Threshold evaluation in the immutable forensic ledger as an
 * 'evaluate-threshold' entry. INFORMATIONAL + requiresGate:false, and it does
 * NOT feed engine.thresholdMonitor — so reading the threshold never perturbs
 * the metric it reports (the monitor is fed only by govern() and by restart
 * seeding, not by ledger.record()). No PII — governance metrics only.
 */
export function recordThresholdEvaluation(
  engine: GovernanceEngine,
  reading: ThresholdReadingLike,
): string {
  const entry = engine.ledger.begin('evaluate-threshold', MaiClassification.INFORMATIONAL, GiaLayer.CORE, 'SYSTEM');
  entry.addMetadata('escalationRate', `${(reading.escalationRate * 100).toFixed(1)}%`);
  entry.addMetadata('status', reading.status);
  entry.addMetadata('isHealthy', reading.isHealthy);
  entry.addMetadata('windowSize', reading.windowSize);

  const score = engine.scorer.scoreDefault('evaluate-threshold');
  const completedEntry = entry.complete(score, {
    classification: MaiClassification.INFORMATIONAL,
    confidence: 0.85,
    rationale: `Storey Threshold evaluated: ${(reading.escalationRate * 100).toFixed(1)}% (${reading.status})`,
    requiresGate: false,
  });
  engine.ledger.record(completedEntry);
  return entry.id;
}

export function registerEvaluateThresholdTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'evaluate_threshold',
    'Compute the Storey Threshold — escalation rate (gates required / total operations). Returns current rate, status, and recommendations. Healthy band 10-18% is a design heuristic, not empirically validated.',
    {},
    { title: 'Evaluate Storey Threshold', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const reading = engine.thresholdMonitor.getReading();
      const health = engine.healthAssessor.assess();
      const breakdown = engine.thresholdMonitor.getBreakdown();

      // Anchor the reading in the immutable forensic ledger (durable, tamper-evident).
      const auditId = recordThresholdEvaluation(engine, reading);

      // Tool accountability tracking — correlated to the ledger entry via auditId.
      engine.telemetryService.emitToolCall('evaluate_threshold', auditId, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          escalationRate: `${(reading.escalationRate * 100).toFixed(1)}%`,
          healthyBand: '10-18%',
          status: reading.status,
          isHealthy: reading.isHealthy,
          windowSize: reading.windowSize,
          breakdown,
          recommendation: health.recommendation,
          actionRequired: health.actionRequired,
          severity: health.severity,
        }, null, 2) }],
      };
    }
  );
}
