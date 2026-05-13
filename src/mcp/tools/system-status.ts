/**
 * @module    mcp-tool-system-status
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { GIA_VERSION, GIA_AUTHOR, GIA_DESCRIPTION } from '../../shared/constants.js';
import { getIntelligenceStats, getIntelligencePersistenceReason } from '../../core/persistence/intelligence-persistence.js';

export function registerSystemStatusTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'system_status',
    `Returns a comprehensive read-only snapshot of the GIA governance engine's current state. No parameters required.

RETURNS (JSON object):
- version: server version string (e.g. "0.3.5")
- engine.health: "healthy" | "degraded" | "failed"
- engine.uptimeMs: milliseconds since server start
- governance.totalDecisions: lifetime decision count
- governance.mandatoryCount: decisions classified MANDATORY
- governance.pendingGates: gates awaiting human approval
- storey_threshold.escalationRatePct: MANDATORY rate as percentage (healthy band: 10–18%)
- storey_threshold.status: "HEALTHY" | "DEGRADED" | "CRITICAL"
- ledger.totalEntries: forensic audit trail entry count
- ledger.chainIntegrity: true if hash chain is unbroken
- intelligence.phoenixSnapshots: context recovery snapshots
- intelligence.memoryPacks: sealed memory packs count
- runtimeAccountability.activeSessions: live MCP sessions
- thresholdDetail.interpretation: plain-English health summary

USE WHEN:
- Verifying the governance engine is healthy before dispatching agents
- Checking if mandatory gate backlog is blocking workflow progression
- Auditing Storey Threshold compliance (MANDATORY gate rate ceiling)
- Confirming ledger chain integrity before exporting audit evidence

READ-ONLY: No side effects. Safe to call at any frequency.`,
    {},
    { title: 'Get System Status', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false, _meta: { ui: { resourceUri: 'ui://system-status' }, outputSchema: { type: 'object', properties: { version: { type: 'string' }, engine: { type: 'object' }, governance: { type: 'object' }, storey_threshold: { type: 'object' }, ledger: { type: 'object' }, intelligence: { type: 'object' }, runtimeAccountability: { type: 'object' }, thresholdDetail: { type: 'object' } } } } } as any,
    async () => {
      const status = engine.getStatus();
      const intelligence = await getIntelligenceStats();

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('system_status', `status-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      const runtimeContext = engine.runtimeService.getInstanceContext();
      const runtimeStats = engine.runtimeService.getStats();

      // Full threshold reading — rate + window context so auditors see the
      // denominator, not just a health flag. A "1% / 47 decisions over 2h"
      // reading tells a completely different story than "CRITICAL" alone.
      const thresholdReading = engine.thresholdMonitor.getReading();
      const thresholdBreakdown = engine.thresholdMonitor.getBreakdown();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          server: GIA_DESCRIPTION,
          version: GIA_VERSION,
          author: GIA_AUTHOR,
          ...status,
          kernelBoot: {
            configFingerprint: runtimeContext.configFingerprint,
            instanceId: runtimeContext.instanceId,
            environment: runtimeContext.environment,
            bootedAt: runtimeContext.bootedAt,
            uptimeMs: runtimeContext.uptimeMs,
          },
          thresholdDetail: {
            escalationRate: thresholdReading.escalationRate,
            escalationRatePct: `${(thresholdReading.escalationRate * 100).toFixed(1)}%`,
            status: thresholdReading.status,
            isHealthy: thresholdReading.isHealthy,
            windowSize: thresholdReading.windowSize,
            windowStart: thresholdReading.windowStart,
            windowEnd: thresholdReading.windowEnd,
            windowSpanMs: thresholdReading.windowEnd
              ? thresholdReading.windowEnd.getTime() - thresholdReading.windowStart.getTime()
              : 0,
            breakdown: thresholdBreakdown,
            healthBand: { min: '10%', max: '18%', criticalBelow: '5%', criticalAbove: '25%' },
            interpretation: thresholdReading.escalationRate < 0.05
              ? 'Under-escalating: fewer than 1-in-20 decisions are MANDATORY. Review whether high-impact operations are correctly classified.'
              : thresholdReading.escalationRate > 0.25
              ? 'Over-escalating: more than 1-in-4 decisions are MANDATORY. Governance friction may be excessive.'
              : thresholdReading.isHealthy
              ? 'Healthy: escalation rate is within the 10–18% Storey Threshold band.'
              : 'Outside healthy band but not critical. Monitor trend.',
          },
          runtimeAccountability: {
            ...runtimeContext,
            activeSessions: runtimeStats.activeSessions,
            completedSessions: runtimeStats.completedSessions,
            failedSessions: runtimeStats.failedSessions,
            totalTokens: runtimeStats.totalTokens,
            breakGlassCount: runtimeStats.breakGlassCount,
          },
          intelligence: {
            ...intelligence,
            persistenceReason: getIntelligencePersistenceReason(),
          },
        }, null, 2) }],
      };
    }
  );
}
