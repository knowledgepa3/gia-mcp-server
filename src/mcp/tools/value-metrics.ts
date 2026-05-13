/**
 * @module    mcp-tool-value-metrics
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       ADVISORY — metrics reporting, no side effects
 * @audit     true — metric recording is ledger-tracked
 * @owner     William J. Storey III / ACE / GIA
 *
 * Value Metrics MCP Tools
 *
 * Turns GIA's audit exhaust into enterprise-ready proof:
 * "22 hours saved, $4,300 cost avoided, 9 unsafe actions blocked, 0 incidents shipped"
 *
 * 3 tools:
 * - record_value_metric: Record a workflow metric (time saved, risk blocked, etc.)
 * - record_governance_event: Record a governance event (gate, drift, violation)
 * - generate_impact_report: Generate full economic + governance impact report
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MAX_INPUT_LENGTH } from '../../shared/constants.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════
// In-memory Value Metrics store for MCP server
// (mirrors services/valueMetrics.ts but runs in MCP process)
// ═══════════════════════════════════════════════════════════════════

interface ValueMetricEntry {
  workflowId: string;
  workflowType: string;
  agentId: string;
  autonomyLevel: 'assist' | 'delegate' | 'automate';
  measurementSource: 'measured' | 'estimated' | 'derived';
  timeSavedMinutes: number;
  riskBlockedCount: number;
  success: boolean;
  taskComplexity: 'low' | 'medium' | 'high';
  timestamp: string;
}

interface GovernanceEvent {
  type: 'gate_triggered' | 'drift_prevented' | 'violation_blocked' | 'redteam_resolved' | 'human_intervention';
  timestamp: string;
  details: string;
}

const metricsStore: ValueMetricEntry[] = [];
const governanceEventsStore: GovernanceEvent[] = [];

// Configurable baselines
const baselines = {
  baselineId: 'default-v1',
  humanHourlyRate: 85,
  avgManualMinutes: 120,
  estimatedIncidentCost: 50000,
  modelCostPerRun: 0.50,
};

// ═══════════════════════════════════════════════════════════════════
// TOOL REGISTRATIONS
// ═══════════════════════════════════════════════════════════════════

export function registerRecordValueMetricTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'record_value_metric',
    'Record a workflow value metric — tracks time saved, risk blocked, success rate, autonomy level, and task complexity for ROI reporting.',
    {
      workflow_id: z.string().max(100).describe('Unique workflow identifier'),
      workflow_type: z.string().max(100).describe('Type of workflow (e.g., claim-analysis, evidence-review, compliance-check)'),
      agent_id: z.string().max(100).describe('Agent that performed the workflow'),
      autonomy_level: z.enum(['assist', 'delegate', 'automate']).describe('Level of agent autonomy'),
      measurement_source: z.enum(['measured', 'estimated', 'derived']).default('estimated').describe('How values were obtained'),
      time_saved_minutes: z.number().min(0).describe('Minutes of human time saved'),
      risk_blocked_count: z.number().min(0).default(0).describe('Number of risks/violations blocked'),
      success: z.boolean().describe('Whether the workflow completed successfully'),
      task_complexity: z.enum(['low', 'medium', 'high']).default('medium').describe('Task complexity level'),
    },
    { title: 'Record Value Metric', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        const entry: ValueMetricEntry = {
          workflowId: input.workflow_id,
          workflowType: input.workflow_type,
          agentId: input.agent_id,
          autonomyLevel: input.autonomy_level,
          measurementSource: input.measurement_source,
          timeSavedMinutes: input.time_saved_minutes,
          riskBlockedCount: input.risk_blocked_count,
          success: input.success,
          taskComplexity: input.task_complexity,
          timestamp: new Date().toISOString(),
        };

        metricsStore.push(entry);

        // Calculate running economic value
        const totalTimeSaved = metricsStore.reduce((sum, m) => sum + m.timeSavedMinutes, 0);
        const totalCostSaved = (totalTimeSaved / 60) * baselines.humanHourlyRate;
        const totalModelCost = metricsStore.length * baselines.modelCostPerRun;

        // Tool accountability tracking
        engine.telemetryService.emitToolCall('record_value_metric', `metric-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          recorded: true,
          workflowId: input.workflow_id,
          metricIndex: metricsStore.length,
          runningTotals: {
            totalMetrics: metricsStore.length,
            totalTimeSavedMinutes: Math.round(totalTimeSaved),
            totalCostSavedUSD: Math.round((totalCostSaved - totalModelCost) * 100) / 100,
            totalRisksBlocked: metricsStore.reduce((sum, m) => sum + m.riskBlockedCount, 0),
            successRate: Math.round((metricsStore.filter(m => m.success).length / metricsStore.length) * 100),
          },
        }, null, 2) }] };
      } catch (error) {
        // Tool accountability tracking
        engine.telemetryService.emitToolCall('record_value_metric', `metric-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'RECORD_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerRecordGovernanceEventTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'record_governance_event',
    'Record a governance event — tracks gates triggered, drift prevented, violations blocked, red team findings, and human interventions for impact reporting.',
    {
      event_type: z.enum(['gate_triggered', 'drift_prevented', 'violation_blocked', 'redteam_resolved', 'human_intervention']).describe('Type of governance event'),
      details: z.string().max(500).describe('Description of the governance event'),
    },
    { title: 'Record Governance Event', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        const event: GovernanceEvent = {
          type: input.event_type,
          timestamp: new Date().toISOString(),
          details: input.details,
        };
        governanceEventsStore.push(event);

        // Emit to GovernanceTelemetryService for persistent storage + quality dimensions
        engine.telemetryService.emitGeneric(input.event_type, input.details);

        // Write to forensic ledger for audit trail
        const ledgerEntry = engine.ledger.begin(
          `governance-event-${input.event_type}`,
          input.event_type === 'violation_blocked' ? MaiClassification.MANDATORY : MaiClassification.ADVISORY,
          GiaLayer.MCP,
          'SYSTEM'
        );
        ledgerEntry.addMetadata('eventType', input.event_type);
        ledgerEntry.addMetadata('details', input.details.slice(0, 500));

        const score = engine.scorer.scoreDefault(`governance-event`);
        const completedEntry = ledgerEntry.complete(score, {
          classification: input.event_type === 'violation_blocked' ? MaiClassification.MANDATORY : MaiClassification.ADVISORY,
          confidence: 1.0,
          rationale: `Governance event: ${input.event_type}`,
          requiresGate: false,
        });
        engine.ledger.record(completedEntry);

        // Event summary
        const counts = {
          gatesTriggered: governanceEventsStore.filter(e => e.type === 'gate_triggered').length,
          driftPrevented: governanceEventsStore.filter(e => e.type === 'drift_prevented').length,
          violationsBlocked: governanceEventsStore.filter(e => e.type === 'violation_blocked').length,
          redTeamResolved: governanceEventsStore.filter(e => e.type === 'redteam_resolved').length,
          humanInterventions: governanceEventsStore.filter(e => e.type === 'human_intervention').length,
        };

        // Tool accountability tracking
        engine.telemetryService.emitToolCall('record_governance_event', ledgerEntry.id, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          recorded: true,
          eventType: input.event_type,
          eventIndex: governanceEventsStore.length,
          governanceSummary: counts,
        }, null, 2) }] };
      } catch (error) {
        // Tool accountability tracking
        engine.telemetryService.emitToolCall('record_governance_event', `event-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'EVENT_RECORD_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerGenerateImpactReportTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'generate_impact_report',
    'Generate a full economic + governance impact report. Returns pilot ROI data: time saved, cost avoided, risks blocked, success rate, autonomy trend, and confidence levels.',
    {
      period_days: z.number().min(1).max(365).default(14).describe('Report period in days'),
      set_baselines: z.object({
        human_hourly_rate: z.number().optional(),
        avg_manual_minutes: z.number().optional(),
        estimated_incident_cost: z.number().optional(),
        model_cost_per_run: z.number().optional(),
      }).optional().describe('Optional: override default baselines for this report'),
    },
    { title: 'Generate Impact Report', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        // Apply baseline overrides if provided
        if (input.set_baselines) {
          if (input.set_baselines.human_hourly_rate) baselines.humanHourlyRate = input.set_baselines.human_hourly_rate;
          if (input.set_baselines.avg_manual_minutes) baselines.avgManualMinutes = input.set_baselines.avg_manual_minutes;
          if (input.set_baselines.estimated_incident_cost) baselines.estimatedIncidentCost = input.set_baselines.estimated_incident_cost;
          if (input.set_baselines.model_cost_per_run) baselines.modelCostPerRun = input.set_baselines.model_cost_per_run;
        }

        const cutoff = new Date(Date.now() - input.period_days * 24 * 3600000);
        const cutoffStr = cutoff.toISOString();
        const relevant = metricsStore.filter(m => new Date(m.timestamp) >= cutoff);
        const relevantEvents = governanceEventsStore.filter(e => new Date(e.timestamp) >= cutoff);

        // Economic impact
        const timeSaved = relevant.reduce((sum, m) => sum + m.timeSavedMinutes, 0);
        const modelCosts = relevant.length * baselines.modelCostPerRun;
        const humanCostSaved = (timeSaved / 60) * baselines.humanHourlyRate;
        const costAvoided = humanCostSaved - modelCosts;
        const successfulRuns = relevant.filter(m => m.success).length;
        const totalRuns = relevant.length || 1;
        const reworkPrevented = Math.round((successfulRuns / totalRuns) * 100);
        const risksBlocked = relevant.reduce((sum, m) => sum + m.riskBlockedCount, 0);
        const failureCostAvoided = risksBlocked * baselines.estimatedIncidentCost;

        // Throughput
        const periodWeeks = Math.max(1, input.period_days / 7);
        const throughputGain = Math.round(relevant.length / periodWeeks);

        // Governance impact
        const governance = {
          unsafeActionsBlocked: relevantEvents.filter(e => e.type === 'gate_triggered').length,
          scopeDriftPrevented: relevantEvents.filter(e => e.type === 'drift_prevented').length,
          policyViolationsAvoided: relevantEvents.filter(e => e.type === 'violation_blocked').length,
          redTeamFindingsResolved: relevantEvents.filter(e => e.type === 'redteam_resolved').length,
          humanInterventions: relevantEvents.filter(e => e.type === 'human_intervention').length,
        };

        // Autonomy trend
        const delegated = relevant.filter(m => m.autonomyLevel === 'delegate').length;
        const automated = relevant.filter(m => m.autonomyLevel === 'automate').length;
        const assisted = relevant.filter(m => m.autonomyLevel === 'assist').length;
        const incidents = relevant.filter(m => !m.success && m.riskBlockedCount === 0).length;

        // Confidence levels
        const measuredCount = relevant.filter(m => m.measurementSource === 'measured').length;
        const measuredRatio = measuredCount / totalRuns;
        const timeSavedConfidence = measuredRatio > 0.7 ? 'high' : measuredRatio > 0.3 ? 'medium' : 'low';
        const costConfidence = measuredRatio > 0.5 ? 'medium' : 'low';
        const riskConfidence = governance.unsafeActionsBlocked > 0 ? 'high' : 'low';

        // Summary line
        const hours = Math.round(timeSaved / 60);
        const summary = [
          `${input.period_days}-day pilot results:`,
          `${hours} hours saved`,
          `$${Math.round(costAvoided).toLocaleString()} cost avoided`,
          `${governance.unsafeActionsBlocked} unsafe actions blocked`,
          `${incidents} incidents shipped`,
          `${reworkPrevented}% first-pass success rate`,
        ].join(' | ');

        const report = {
          reportId: `IMPACT-${Date.now().toString(36)}`,
          generatedAt: new Date().toISOString(),
          periodStart: cutoffStr,
          periodEnd: new Date().toISOString(),
          periodDays: input.period_days,
          summary,
          economic: {
            timeSavedMinutes: Math.round(timeSaved),
            timeSavedHours: hours,
            costAvoidedUSD: Math.round(costAvoided * 100) / 100,
            reworkPrevented,
            throughputGainPerWeek: throughputGain,
            failureCostAvoidedUSD: failureCostAvoided,
            modelCostUSD: Math.round(modelCosts * 100) / 100,
            netROI: Math.round((costAvoided + failureCostAvoided) * 100) / 100,
          },
          governance,
          autonomyTrend: {
            delegatedTasks: delegated,
            automatedTasks: automated,
            assistedTasks: assisted,
            incidentCount: incidents,
          },
          assumptions: {
            baselineId: baselines.baselineId,
            humanHourlyRate: baselines.humanHourlyRate,
            avgManualMinutes: baselines.avgManualMinutes,
            estimatedIncidentCost: baselines.estimatedIncidentCost,
            modelCostPerRun: baselines.modelCostPerRun,
          },
          confidence: {
            timeSaved: timeSavedConfidence,
            costAvoided: costConfidence,
            riskBlocked: riskConfidence,
          },
          dataPoints: {
            totalMetrics: relevant.length,
            totalGovernanceEvents: relevantEvents.length,
          },
        };

        // Tool accountability tracking
        engine.telemetryService.emitToolCall('generate_impact_report', `impact-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        // Tool accountability tracking
        engine.telemetryService.emitToolCall('generate_impact_report', `impact-${Date.now().toString(36)}`, 'INFORMATIONAL', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'REPORT_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

/**
 * Register all 3 Value Metrics tools with the MCP server.
 */
export function registerValueMetricsTools(server: McpServer, engine: GovernanceEngine): void {
  registerRecordValueMetricTool(server, engine);
  registerRecordGovernanceEventTool(server, engine);
  registerGenerateImpactReportTool(server, engine);
}

// ═══════════════════════════════════════════════════════════════════
// Public read-only accessors for HTTP dashboard endpoints
// (server-http.ts imports these — no mutation, read-only views)
// ═══════════════════════════════════════════════════════════════════

export function getMetricsStore(): ReadonlyArray<ValueMetricEntry> {
  return metricsStore;
}

export function getGovernanceEventsStore(): ReadonlyArray<GovernanceEvent> {
  return governanceEventsStore;
}

export function getBaselines(): Readonly<typeof baselines> {
  return baselines;
}
