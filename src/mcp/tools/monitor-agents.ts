/**
 * @module    mcp-tool-monitor-agents
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { getRecentPhoenixRecords, getPhoenixStats, getRecentCerebroSignals } from '../../core/persistence/intelligence-persistence.js';

export function registerMonitorAgentsTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'monitor_agents',
    'Monitor the status and health of all governed AI agents. Returns supervisor state, repair history, and failure counts.',
    {},
    { title: 'Monitor Agent Health', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const states = engine.supervisor.getAllStates();
      const agentData = Array.from(states.entries()).map(([name, state]) => ({
        name,
        lastStatus: state.lastStatus,
        repairAttempts: state.repairAttempts,
        consecutiveFailures: state.consecutiveFailures,
        lastScore: state.lastScore?.composite,
      }));

      // Phoenix lifecycle data — recent agent runs from PostgreSQL
      const [recentRuns, phoenixStats, recentSignals] = await Promise.all([
        getRecentPhoenixRecords(10),
        getPhoenixStats(),
        getRecentCerebroSignals(10),
      ]);

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('monitor_agents', `monitor-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      // Derive historical agent count from Phoenix workforce breakdown
      const historicalWorkforces = Object.keys(phoenixStats.workforceBreakdown || {});
      const hasHistory = phoenixStats.totalRecords > 0;
      const agentStatus = agentData.length > 0
        ? `${agentData.length} agent(s) currently supervised.`
        : hasHistory
          ? `No agents currently supervised. ${phoenixStats.totalRecords} historical governed runs recorded across ${historicalWorkforces.length} workforce type(s).`
          : 'No agents supervised and no historical runs recorded.';

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          activeSupervisedAgents: agentData.length,
          totalHistoricalRuns: phoenixStats.totalRecords,
          agentStatus,
          agents: agentData,
          phoenixLifecycle: {
            totalRecordedRuns: phoenixStats.totalRecords,
            last24hRuns: phoenixStats.last24hRecords,
            successRate: phoenixStats.totalRecords > 0
              ? `${Math.round((phoenixStats.successCount / phoenixStats.totalRecords) * 100)}%`
              : 'N/A',
            avgTokenEfficiency: phoenixStats.avgTokenEfficiency,
            workforceBreakdown: phoenixStats.workforceBreakdown,
            recentRuns: recentRuns.map(r => ({
              runId: r.runId,
              caseId: r.caseId,
              workforce: r.workforceType,
              status: r.finalStatus,
              lineageDepth: r.lineageDepth,
              tokenEfficiency: r.tokenEfficiency,
              completedAt: r.completedAt,
            })),
          },
          cerebroAlerts: {
            recentSignals: recentSignals.map(s => ({
              signalId: s.signalId,
              severity: s.severity,
              type: s.signalType,
              title: s.title,
              confidence: s.confidence,
              timestamp: s.timestamp,
            })),
          },
        }, null, 2) }],
      };
    }
  );
}
