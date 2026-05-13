/**
 * @module    mcp-tool-score-governance
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — transport only
 * @audit     true — writes to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { generateAuditId } from '../../shared/utils.js';
import { GovernedError } from '../../shared/errors.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';

export function registerScoreGovernanceTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'score_governance',
    'Compute weighted governance score from caller-provided Integrity, Accuracy, and Compliance values (0-1). Returns weighted composite and pass/fail against configured thresholds. Scores are caller-assessed — this tool applies weights and thresholds, not independent evaluation.',
    {
      operation: z.string().describe('Name of the operation being scored'),
      integrity: z.number().min(0).max(1).describe('Data integrity score (0.0-1.0)'),
      accuracy: z.number().min(0).max(1).describe('Factual accuracy score (0.0-1.0)'),
      compliance: z.number().min(0).max(1).describe('Regulatory compliance score (0.0-1.0)'),
    },
    { title: 'Score Governance', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      // Begin forensic ledger entry
      const entry = engine.ledger.begin(
        'score-governance',
        MaiClassification.ADVISORY,
        GiaLayer.MCP,
        'SYSTEM'
      );
      entry.addMetadata('operation', input.operation);

      try {
        const auditId = generateAuditId();
        const score = engine.scorer.score(
          { integrity: input.integrity, accuracy: input.accuracy, compliance: input.compliance },
          input.operation,
          auditId
        );

        // Record to forensic ledger
        entry.addMetadata('composite', score.composite);
        entry.addMetadata('meetsThreshold', engine.scorer.meetsThreshold(score));
        const completedEntry = entry.complete(score, {
          classification: MaiClassification.ADVISORY,
          confidence: score.composite >= 0.7 ? 0.95 : 0.70,
          rationale: `Governance score computed: ${score.composite.toFixed(3)}`,
          requiresGate: false,
        });
        engine.ledger.record(completedEntry);

        // Auto-emit governance telemetry
        engine.telemetryService.emitScoring(entry.id, input.operation, score.composite, engine.scorer.meetsThreshold(score));
        engine.telemetryService.emitToolCall('score_governance', entry.id, 'ADVISORY', true);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            composite: score.composite,
            integrity: score.integrity,
            accuracy: score.accuracy,
            compliance: score.compliance,
            weights: score.weights,
            meetsThreshold: engine.scorer.meetsThreshold(score),
            minimumThreshold: 0.70,
            auditId: entry.id,
          }, null, 2) }],
        };
      } catch (error) {
        // Record failure to forensic ledger
        engine.telemetryService.emitToolCall('score_governance', entry.id, 'MANDATORY', false);
        const failedEntry = entry.fail(error instanceof Error ? error : new Error('Scoring failed'), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);

        if (error instanceof GovernedError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(error.toPublicResponse()) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SCORING_FAILED' }) }], isError: true };
      }
    }
  );
}
