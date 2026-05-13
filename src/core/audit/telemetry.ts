/**
 * @module    telemetry
 * @layer     GOVERNANCE
 * @inherits  forensic-ledger
 * @mai       I — telemetry collection is INFORMATIONAL
 * @audit     true — telemetry events recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * TELEMETRY COLLECTOR
 *
 * Collects operational snapshots from the forensic ledger AND governance
 * telemetry service. Computes quality dimensions and evidence penalties
 * for generate_report.
 *
 * Quality Dimensions:
 * - Corrective Action Review: % of operations with governance scores
 * - Oversight Review: mandatory gates triggered vs mandatory operations
 * - Adversarial Defense Summary: probes executed, pass rate
 *
 * Evidence Penalties:
 * - No probe activity in 7 days → -15% Adversarial
 * - No MAI gate activity in period → -20% Oversight
 * - No scoring events in period → -10% Corrective
 * - No human intervention in 14 days → -5% Oversight
 * - No delegation trail when sub-agents exist → -20% Accountability
 */

import { ForensicLedger } from './ledger.js';
import { EntryStatus, MaiClassification } from '../../shared/types.js';
import { GovernanceTelemetryService } from '../telemetry/governance-telemetry-service.js';

export interface ITelemetrySnapshot {
  timestamp: Date;
  totalOperations: number;
  completedOperations: number;
  failedOperations: number;
  escalatedOperations: number;
  activeOperations: number;
  maiBreakdown: Record<string, number>;
  avgDurationMs: number;
  /** SHA-256 hash of the most recent entry in the forensic ledger chain. */
  chainHead: string;
  /** Whether the hash chain is intact (no tamper evidence detected). */
  chainIntact: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// QUALITY DIMENSION TYPES
// ═══════════════════════════════════════════════════════════════════

export type QualityStatus = 'STRONG' | 'ADEQUATE' | 'INSUFFICIENT' | 'UNTESTED';

export interface ICorrectiveActionReview {
  /** % of operations that have governance scores */
  coveragePct: number;
  /** Average composite governance score */
  avgComposite: number;
  /** Count of scores below threshold */
  belowThresholdCount: number;
  /** Total scoring events in period */
  totalScoringEvents: number;
  status: QualityStatus;
}

export interface IOversightReview {
  /** Mandatory gates triggered in period */
  gatesTriggered: number;
  /** Human interventions in period */
  humanInterventions: number;
  /** Total mandatory operations */
  mandatoryOperations: number;
  /** % coverage: gates triggered / mandatory operations */
  coveragePct: number;
  status: QualityStatus;
}

export interface IAdversarialDefenseSummary {
  /** Total probes executed in period */
  probesExecuted: number;
  /** Probes that passed */
  probesPassed: number;
  /** Pass rate as percentage */
  passRatePct: number;
  /** Last probe timestamp */
  lastProbeAt: Date | null;
  status: QualityStatus;
}

export interface IDelegationAccountability {
  /** Total delegations in period */
  totalDelegations: number;
  /** Delegations with drift detected */
  driftCount: number;
  /** Active (unresolved) delegations */
  activeDelegations: number;
  /** Unique parent agents delegating */
  uniqueParentAgents: number;
  /** Unique sub-agents receiving work */
  uniqueSubAgents: number;
  status: QualityStatus;
}

export interface IEvidencePenalty {
  dimension: string;
  penalty: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════
// TOOL ACCOUNTABILITY TYPES
// ═══════════════════════════════════════════════════════════════════

export type ToolClass = 'read' | 'write' | 'external' | 'admin' | 'gate';
export type ToolRiskTier = 'low' | 'moderate' | 'high' | 'critical';

export interface IToolAccountabilityProfile {
  toolName: string;
  toolClass: ToolClass;
  riskTier: ToolRiskTier;
  maiDefault: 'INFORMATIONAL' | 'ADVISORY' | 'MANDATORY';
  requiresHumanApproval: boolean;
  category: string;
}

export interface IToolAccountabilityMetrics {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastCalledAt: string | null;
  callers: string[];
}

export interface IToolAccountability {
  /** Total unique tools invoked in period */
  activeToolCount: number;
  /** Total tool invocations in period */
  totalInvocations: number;
  /** Registered tools in the governed tool registry */
  registeredTools: number;
  /** Tools invoked without accountability tracking */
  untrackedTools: string[];
  /** Per-tool usage breakdown (top tools by invocation count) */
  toolUsage: Record<string, number>;
  /** Per-tool performance metrics (success rate, duration, callers) */
  toolPerformance: Record<string, IToolAccountabilityMetrics>;
  /** Tool class breakdown */
  toolClassBreakdown: Record<string, number>;
  /** Tool risk tier breakdown */
  riskTierBreakdown: Record<string, number>;
  status: QualityStatus;
}

/**
 * GOVERNED TOOL REGISTRY
 * Every MCP tool treated as a governed workforce unit with risk class,
 * MAI baseline, and accountability profile.
 */
export const GOVERNED_TOOL_REGISTRY: IToolAccountabilityProfile[] = [
  // ── Core Governance (10 tools) ──
  { toolName: 'classify_decision',   toolClass: 'read',     riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'governance' },
  { toolName: 'score_governance',    toolClass: 'read',     riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'governance' },
  { toolName: 'evaluate_threshold',  toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'governance' },
  { toolName: 'assess_risk_tier',    toolClass: 'read',     riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'governance' },
  { toolName: 'map_compliance',      toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'governance' },
  { toolName: 'audit_pipeline',      toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'forensics' },
  { toolName: 'approve_gate',        toolClass: 'gate',     riskTier: 'critical', maiDefault: 'MANDATORY',      requiresHumanApproval: true,  category: 'governance' },
  { toolName: 'monitor_agents',      toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'operations' },
  { toolName: 'generate_report',     toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'reporting' },
  { toolName: 'system_status',       toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'operations' },

  // ── Knowledge Packs (6 tools) ──
  { toolName: 'seal_memory_pack',     toolClass: 'write',    riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'knowledge' },
  { toolName: 'load_memory_pack',     toolClass: 'read',     riskTier: 'low',      maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'knowledge' },
  { toolName: 'transfer_memory_pack', toolClass: 'write',    riskTier: 'high',     maiDefault: 'MANDATORY',      requiresHumanApproval: true,  category: 'knowledge' },
  { toolName: 'compose_memory_packs', toolClass: 'write',    riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'knowledge' },
  { toolName: 'distill_memory_pack',  toolClass: 'write',    riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'knowledge' },
  { toolName: 'promote_memory_pack',  toolClass: 'admin',    riskTier: 'high',     maiDefault: 'MANDATORY',      requiresHumanApproval: true,  category: 'knowledge' },

  // ── SRT (4 tools) ──
  { toolName: 'srt_run_watchdog',       toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'srt' },
  { toolName: 'srt_diagnose',           toolClass: 'read',     riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'srt' },
  { toolName: 'srt_approve_repair',     toolClass: 'gate',     riskTier: 'critical', maiDefault: 'MANDATORY',      requiresHumanApproval: true,  category: 'srt' },
  { toolName: 'srt_generate_postmortem', toolClass: 'read',    riskTier: 'low',      maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'srt' },

  // ── Value Metrics (3 tools) ──
  { toolName: 'record_value_metric',    toolClass: 'write',    riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'metrics' },
  { toolName: 'record_governance_event', toolClass: 'write',   riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'metrics' },
  { toolName: 'generate_impact_report', toolClass: 'read',     riskTier: 'low',      maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'metrics' },

  // ── Remediation & Operations (5 tools) ──
  { toolName: 'gia_scan_environment',  toolClass: 'external', riskTier: 'moderate', maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'operations' },
  { toolName: 'gia_list_packs',        toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'operations' },
  { toolName: 'gia_dry_run_pack',      toolClass: 'read',     riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'operations' },
  { toolName: 'gia_apply_pack',        toolClass: 'external', riskTier: 'critical', maiDefault: 'MANDATORY',      requiresHumanApproval: true,  category: 'operations' },
  { toolName: 'gia_run_patrol',        toolClass: 'external', riskTier: 'moderate', maiDefault: 'ADVISORY',       requiresHumanApproval: false, category: 'operations' },

  // ── Forensics (1 tool) ──
  { toolName: 'verify_ledger',         toolClass: 'read',     riskTier: 'low',      maiDefault: 'INFORMATIONAL',  requiresHumanApproval: false, category: 'forensics' },
];

export interface IQualityDimensions {
  correctiveActionReview: ICorrectiveActionReview;
  oversightReview: IOversightReview;
  adversarialDefenseSummary: IAdversarialDefenseSummary;
  delegationAccountability: IDelegationAccountability;
  toolAccountability: IToolAccountability;
  evidencePenalties: IEvidencePenalty[];
  governanceQualityScore: {
    frameworkScore: number;     // Always 100 — framework is complete
    evidenceScore: number;      // 100 - sum(penalties)
    compositeQuality: number;   // average of framework + evidence
  };
}

export class TelemetryCollector {
  private telemetryService: GovernanceTelemetryService | null = null;

  constructor(private readonly ledger: ForensicLedger) {}

  /**
   * Wire the GovernanceTelemetryService for quality dimension queries.
   * Called after GovernanceEngine constructs the service.
   */
  setTelemetryService(service: GovernanceTelemetryService): void {
    this.telemetryService = service;
  }

  snapshot(): ITelemetrySnapshot {
    const completed = this.ledger.countByStatus(EntryStatus.COMPLETED);
    const failed = this.ledger.countByStatus(EntryStatus.FAILED);
    const escalated = this.ledger.countByStatus(EntryStatus.ESCALATED);
    const active = this.ledger.getActiveOperations().length;

    const mandatoryCount = this.ledger.queryByMaiLevel(MaiClassification.MANDATORY).length;
    const advisoryCount = this.ledger.queryByMaiLevel(MaiClassification.ADVISORY).length;
    const informationalCount = this.ledger.queryByMaiLevel(MaiClassification.INFORMATIONAL).length;

    const allCompleted = this.ledger.queryCompleted();
    const avgDuration = allCompleted.length > 0
      ? allCompleted.reduce((sum, e) => sum + (e.duration ?? 0), 0) / allCompleted.length
      : 0;

    // Chain integrity check — lightweight O(n) verification
    const chainVerification = this.ledger.verifyChain();

    return {
      timestamp: new Date(),
      totalOperations: this.ledger.size,
      completedOperations: completed,
      failedOperations: failed,
      escalatedOperations: escalated,
      activeOperations: active,
      maiBreakdown: {
        MANDATORY: mandatoryCount,
        ADVISORY: advisoryCount,
        INFORMATIONAL: informationalCount,
      },
      avgDurationMs: Math.round(avgDuration),
      chainHead: this.ledger.chainHead,
      chainIntact: chainVerification.valid,
    };
  }

  /**
   * Compute quality dimensions from governance telemetry data.
   * Returns real percentages based on actual tool activity.
   */
  getQualityDimensions(periodDays: number = 14): IQualityDimensions {
    const since = new Date(Date.now() - periodDays * 24 * 3600_000);
    const eventCounts = this.telemetryService
      ? this.telemetryService.getEventCounts(since)
      : {};
    const delegationStats = this.telemetryService
      ? this.telemetryService.getDelegationStats(since)
      : { totalDelegations: 0, activeDelegations: 0, completedDelegations: 0, driftCount: 0, uniqueParentAgents: 0, uniqueSubAgents: 0 };

    // ── Corrective Action Review ──
    const scoringEvents = eventCounts['scoring_executed'] || 0;
    const totalOps = this.ledger.size || 1;
    const scoringCoverage = Math.min(100, Math.round((scoringEvents / totalOps) * 100));

    // Extract avg composite from recent scoring events
    let avgComposite = 0;
    let belowThreshold = 0;
    if (this.telemetryService) {
      const recentScoring = this.telemetryService.getRecentEvents(200)
        .filter(e => e.eventType === 'scoring_executed' && e.timestamp >= since);
      if (recentScoring.length > 0) {
        let compositeSum = 0;
        for (const evt of recentScoring) {
          const comp = (evt.metadata as any)?.composite ?? 0.85;
          compositeSum += comp;
          if (comp < 0.7) belowThreshold++;
        }
        avgComposite = Math.round((compositeSum / recentScoring.length) * 1000) / 1000;
      }
    }

    const correctiveStatus: QualityStatus =
      scoringCoverage >= 70 ? 'STRONG' :
      scoringCoverage >= 30 ? 'ADEQUATE' :
      scoringEvents > 0 ? 'INSUFFICIENT' : 'UNTESTED';

    const correctiveActionReview: ICorrectiveActionReview = {
      coveragePct: scoringCoverage,
      avgComposite,
      belowThresholdCount: belowThreshold,
      totalScoringEvents: scoringEvents,
      status: correctiveStatus,
    };

    // ── Oversight Review ──
    const gatesTriggered = eventCounts['gate_triggered'] || 0;
    const humanInterventions = eventCounts['human_intervention'] || 0;
    const mandatoryOps = this.ledger.queryByMaiLevel(MaiClassification.MANDATORY).length || 1;
    const oversightCoverage = Math.min(100, Math.round((gatesTriggered / mandatoryOps) * 100));

    const oversightStatus: QualityStatus =
      oversightCoverage >= 70 ? 'STRONG' :
      oversightCoverage >= 30 ? 'ADEQUATE' :
      gatesTriggered > 0 ? 'INSUFFICIENT' : 'UNTESTED';

    const oversightReview: IOversightReview = {
      gatesTriggered,
      humanInterventions,
      mandatoryOperations: mandatoryOps,
      coveragePct: oversightCoverage,
      status: oversightStatus,
    };

    // ── Adversarial Defense Summary ──
    const probeEvents = eventCounts['probe_completed'] || 0;
    let probesPassed = 0;
    let lastProbeAt: Date | null = null;
    if (this.telemetryService) {
      const recentProbes = this.telemetryService.getRecentEvents(200)
        .filter(e => e.eventType === 'probe_completed' && e.timestamp >= since);
      probesPassed = recentProbes.filter(e => (e.metadata as any)?.passed === true).length;
      lastProbeAt = this.telemetryService.getLastEventTimestamp('probe_completed');
    }
    const passRate = probeEvents > 0 ? Math.round((probesPassed / probeEvents) * 100) : 0;

    const adversarialStatus: QualityStatus =
      probeEvents >= 5 && passRate >= 80 ? 'STRONG' :
      probeEvents >= 1 ? 'ADEQUATE' : 'UNTESTED';

    const adversarialDefenseSummary: IAdversarialDefenseSummary = {
      probesExecuted: probeEvents,
      probesPassed,
      passRatePct: passRate,
      lastProbeAt,
      status: adversarialStatus,
    };

    // ── Delegation Accountability ──
    const delegationStatus: QualityStatus =
      delegationStats.totalDelegations > 0 && delegationStats.driftCount === 0 ? 'STRONG' :
      delegationStats.totalDelegations > 0 ? 'ADEQUATE' : 'UNTESTED';

    const delegationAccountability: IDelegationAccountability = {
      totalDelegations: delegationStats.totalDelegations,
      driftCount: delegationStats.driftCount,
      activeDelegations: delegationStats.activeDelegations,
      uniqueParentAgents: delegationStats.uniqueParentAgents,
      uniqueSubAgents: delegationStats.uniqueSubAgents,
      status: delegationStatus,
    };

    // ── Tool Accountability ──
    const toolAccountability = this.getToolAccountability(since);

    // ── Evidence Penalties ──
    const penalties: IEvidencePenalty[] = [];

    // No probe activity in 7 days → -15% Adversarial
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    if (!lastProbeAt || lastProbeAt < sevenDaysAgo) {
      penalties.push({
        dimension: 'Adversarial Defense',
        penalty: 15,
        reason: 'No probe activity in the last 7 days',
      });
    }

    // No MAI gate activity in period → -20% Oversight
    if (gatesTriggered === 0) {
      penalties.push({
        dimension: 'Oversight',
        penalty: 20,
        reason: `No MAI gate activity in the last ${periodDays} days`,
      });
    }

    // No scoring events in period → -10% Corrective
    if (scoringEvents === 0) {
      penalties.push({
        dimension: 'Corrective Action',
        penalty: 10,
        reason: `No governance scoring events in the last ${periodDays} days`,
      });
    }

    // No human intervention in 14 days → -5% Oversight
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600_000);
    const lastHumanIntervention = this.telemetryService
      ? this.telemetryService.getLastEventTimestamp('human_intervention')
      : null;
    if (!lastHumanIntervention || lastHumanIntervention < fourteenDaysAgo) {
      penalties.push({
        dimension: 'Oversight',
        penalty: 5,
        reason: 'No human intervention in the last 14 days',
      });
    }

    // No delegation trail when sub-agents exist → -20% Accountability
    // (sub-agents exist if we have any MAI classifications with agent names)
    const classificationEvents = eventCounts['mai_classification'] || 0;
    if (classificationEvents > 5 && delegationStats.totalDelegations === 0) {
      penalties.push({
        dimension: 'Accountability',
        penalty: 20,
        reason: 'Multiple agent classifications but no delegation tracking',
      });
    }

    // No tool accountability tracking → -15% Tool Governance
    const toolInvocations = eventCounts['tool_invocation'] || 0;
    if (toolInvocations === 0 && totalOps > 5) {
      penalties.push({
        dimension: 'Tool Governance',
        penalty: 15,
        reason: 'Tool invocations not tracked — no tool accountability evidence',
      });
    }

    // Compute governance quality score
    const totalPenalty = penalties.reduce((sum, p) => sum + p.penalty, 0);
    const frameworkScore = 100;
    const evidenceScore = Math.max(0, 100 - totalPenalty);
    const compositeQuality = Math.round((frameworkScore + evidenceScore) / 2);

    return {
      correctiveActionReview,
      oversightReview,
      adversarialDefenseSummary,
      delegationAccountability,
      toolAccountability,
      evidencePenalties: penalties,
      governanceQualityScore: {
        frameworkScore,
        evidenceScore,
        compositeQuality,
      },
    };
  }

  /**
   * Compute tool accountability metrics.
   * Treats every MCP tool as a governed workforce unit with risk class,
   * MAI baseline, and accountability profile.
   */
  private getToolAccountability(since: Date): IToolAccountability {
    if (!this.telemetryService) {
      return {
        activeToolCount: 0,
        totalInvocations: 0,
        registeredTools: GOVERNED_TOOL_REGISTRY.length,
        untrackedTools: [],
        toolUsage: {},
        toolPerformance: {},
        toolClassBreakdown: {},
        riskTierBreakdown: {},
        status: 'UNTESTED',
      };
    }

    const toolUsage = this.telemetryService.getToolUsageCounts(since);
    const toolPerf = this.telemetryService.getToolPerformanceMetrics(since);
    const activeToolCount = this.telemetryService.getActiveToolCount(since);

    // Compute total invocations from tool_invocation events specifically
    const toolInvocationCounts = Object.entries(toolUsage);
    const totalInvocations = toolInvocationCounts.reduce((sum, [, count]) => sum + count, 0);

    // Find tools invoked that aren't in the registry
    const registeredNames = new Set(GOVERNED_TOOL_REGISTRY.map(t => t.toolName));
    const untrackedTools = Object.keys(toolUsage).filter(t => !registeredNames.has(t));

    // Tool class breakdown from registry
    const toolClassBreakdown: Record<string, number> = {};
    const riskTierBreakdown: Record<string, number> = {};
    for (const profile of GOVERNED_TOOL_REGISTRY) {
      toolClassBreakdown[profile.toolClass] = (toolClassBreakdown[profile.toolClass] || 0) + 1;
      riskTierBreakdown[profile.riskTier] = (riskTierBreakdown[profile.riskTier] || 0) + 1;
    }

    // Format performance metrics for output
    const toolPerformance: Record<string, IToolAccountabilityMetrics> = {};
    for (const [tool, metrics] of Object.entries(toolPerf)) {
      toolPerformance[tool] = {
        totalCalls: metrics.totalCalls,
        successCount: metrics.successCount,
        failureCount: metrics.failureCount,
        successRate: metrics.successRate,
        avgDurationMs: metrics.avgDurationMs,
        lastCalledAt: metrics.lastCalledAt?.toISOString() || null,
        callers: metrics.callers,
      };
    }

    // Status determination
    const status: QualityStatus =
      totalInvocations >= 10 && untrackedTools.length === 0 ? 'STRONG' :
      totalInvocations >= 1 ? 'ADEQUATE' : 'UNTESTED';

    return {
      activeToolCount,
      totalInvocations,
      registeredTools: GOVERNED_TOOL_REGISTRY.length,
      untrackedTools,
      toolUsage,
      toolPerformance,
      toolClassBreakdown,
      riskTierBreakdown,
      status,
    };
  }
}
