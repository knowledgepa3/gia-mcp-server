/**
 * @module    mcp-tool-evaluate-threshold
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — transport only
 * @audit     false — CORE handles audit
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

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

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('evaluate_threshold', `threshold-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

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
