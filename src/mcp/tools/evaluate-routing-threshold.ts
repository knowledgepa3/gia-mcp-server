/**
 * @module    mcp-tool-evaluate-routing-threshold
 * @layer     TRANSPORT
 * @inherits  src/core/threshold/routing-monitor
 * @mai       A — exposes Advisory health assessments; CRITICAL elevates via core
 * @audit     false — CORE handles audit (one ledger entry per assessment)
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

/**
 * MCP tool: evaluate_routing_threshold
 *
 * Thin wrapper per the GIA standard: no business logic here. Validates input,
 * calls engine.assessRoutingHealth, returns the governed report. The core
 * monitor owns band math, theater detection, and ledger writes; the engine
 * owns CRITICAL → Mandatory gate elevation and the premium-routing halt.
 */
export function registerEvaluateRoutingThresholdTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'evaluate_routing_threshold',
    'Assess model routing health over a time window: safeguard fallback rate, ' +
    'prompt cache hit rate, batch utilization, and premium spend leakage. ' +
    'Returns banded status per metric (HEALTHY / WARNING / CRITICAL / ' +
    'INSUFFICIENT_DATA / UNVERIFIED) plus overall status. CRITICAL overall ' +
    'status opens a Mandatory gate and halts premium-tier routing until a ' +
    'human approves with rationale. Defaults to the last 24 hours.',
    {
      window_start: z.string().datetime().optional()
        .describe('ISO 8601 window start. Default: 24h before window_end.'),
      window_end: z.string().datetime().optional()
        .describe('ISO 8601 window end. Default: now.'),
    },
    { title: 'Evaluate Model Routing Threshold', readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async ({ window_start, window_end }) => {
      const end = window_end ? new Date(window_end) : new Date();
      const start = window_start ? new Date(window_start) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        throw new Error('GovernedError[evaluate_routing_threshold]: invalid time window');
      }

      const report = await engine.assessRoutingHealth(start, end);

      // Tool accountability tracking
      engine.telemetryService.emitToolCall(
        'evaluate_routing_threshold',
        `routing-${Date.now().toString(36)}`,
        report.overallStatus === 'CRITICAL' ? 'MANDATORY' : 'ADVISORY',
        true,
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          windowStart: report.windowStart.toISOString(),
          windowEnd: report.windowEnd.toISOString(),
          totalObservations: report.totalObservations,
          overallStatus: report.overallStatus,
          premiumRoutingHalted: engine.premiumRoutingHalted,
          bands: {
            fallbackRate: report.fallbackRate,
            cacheHitRate: report.cacheHitRate,
            batchUtilization: report.batchUtilization,
            premiumLeakage: report.premiumLeakage,
          },
          auditId: report.auditId,
          calibrationNote: 'Bands are initial hypotheses — recalibrate after 30 days of production observations.',
        }, null, 2) }],
      };
    }
  );
}
