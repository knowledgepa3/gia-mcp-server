/**
 * @module    governance-telemetry-service
 * @layer     GOVERNANCE
 * @mai       M — governance telemetry is MANDATORY for evidence completeness
 * @audit     true — all emitted events feed into quality scoring
 * @owner     William J. Storey III / ACE / GIA
 *
 * GOVERNANCE TELEMETRY SERVICE
 *
 * Central service for auto-emitting governance events from MCP tool handlers.
 * Dual write-through: bounded in-memory circular buffer + PostgreSQL.
 *
 * Design:
 * - Fire-and-forget: every emit is non-blocking
 * - Write-through: in-memory always populated, DB write is .catch() guarded
 * - Bounded memory: 10K max circular buffer (4GB droplet safety)
 * - Convenience emitters: one call from each tool handler
 * - Accessors: getEventCounts(), getDelegationStats() for reports
 *
 * Wired into GovernanceEngine lifecycle (init/shutdown).
 */

import {
  persistGovernanceEvent,
  persistDelegation,
  updateDelegationDisposition,
  getGovernanceEventCounts as dbGetEventCounts,
  getDelegationStats as dbGetDelegationStats,
  type GovernanceEventRecord,
  type DelegationRecord,
} from '../persistence/telemetry-persistence.js';

// ═══════════════════════════════════════════════════════════════════
// IN-MEMORY CIRCULAR BUFFER
// ═══════════════════════════════════════════════════════════════════

const MAX_BUFFER_SIZE = 10_000;

interface BufferedEvent {
  eventType: string;
  sourceTool: string;
  sourceAuditId?: string;
  maiLevel?: string;
  details: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

interface BufferedDelegation {
  id: string; // synthetic ID for in-memory tracking
  parentAgentId: string;
  subAgentId: string;
  task: string;
  authorityScope: string;
  policyPack?: string;
  approvalOwner?: string;
  accountableOwner?: string;
  parentAuditId?: string;
  disposition?: string;
  driftFlag: boolean;
  remediationLink?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export class GovernanceTelemetryService {
  private readonly eventBuffer: BufferedEvent[] = [];
  private readonly delegationBuffer: BufferedDelegation[] = [];
  private delegationCounter = 0;

  // ═════════════════════════════════════════════════════════════════
  // CONVENIENCE EMITTERS — one call from each tool handler
  // ═════════════════════════════════════════════════════════════════

  /**
   * Emit after classify_decision completes.
   */
  emitClassification(
    auditId: string,
    classification: string,
    operation: string,
    agentName?: string
  ): void {
    this.emit({
      eventType: 'mai_classification',
      sourceTool: 'classify_decision',
      sourceAuditId: auditId,
      maiLevel: classification,
      details: `MAI classification: ${classification} for "${operation}"`,
      metadata: { operation, agentName: agentName || 'SYSTEM', classification },
    });
  }

  /**
   * Emit after approve_gate action (approve/reject/break_glass).
   */
  emitGateAction(
    auditId: string,
    action: string,
    gateId: string,
    approvedBy: string
  ): void {
    this.emit({
      eventType: 'gate_triggered',
      sourceTool: 'approve_gate',
      sourceAuditId: auditId,
      maiLevel: 'MANDATORY',
      details: `Gate ${action}: ${gateId} by ${approvedBy}`,
      metadata: { action, gateId, approvedBy },
    });
  }

  /**
   * Emit after score_governance completes.
   */
  emitScoring(
    auditId: string,
    operation: string,
    composite: number,
    meetsThreshold: boolean
  ): void {
    this.emit({
      eventType: 'scoring_executed',
      sourceTool: 'score_governance',
      sourceAuditId: auditId,
      maiLevel: 'ADVISORY',
      details: `Governance score: ${composite.toFixed(3)} for "${operation}" (${meetsThreshold ? 'PASS' : 'FAIL'})`,
      metadata: { operation, composite, meetsThreshold },
    });
  }

  /**
   * Emit after SRT watchdog/diagnose completes.
   */
  emitProbeResult(
    auditId: string,
    category: string,
    passed: boolean,
    probeCount: number
  ): void {
    this.emit({
      eventType: 'probe_completed',
      sourceTool: 'srt_run_watchdog',
      sourceAuditId: auditId,
      maiLevel: 'INFORMATIONAL',
      details: `SRT probe: ${category} — ${passed ? 'PASS' : 'FAIL'} (${probeCount} checks)`,
      metadata: { category, passed, probeCount },
    });
  }

  /**
   * Emit a generic governance event (used by record_governance_event tool).
   */
  emitGeneric(
    eventType: string,
    details: string,
    sourceTool?: string,
    sourceAuditId?: string,
    maiLevel?: string,
    metadata?: Record<string, unknown>
  ): void {
    this.emit({
      eventType,
      sourceTool: sourceTool || 'record_governance_event',
      sourceAuditId,
      maiLevel,
      details,
      metadata,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // DELEGATION TRACKING
  // ═════════════════════════════════════════════════════════════════

  /**
   * Record a new delegation. Returns synthetic delegation ID.
   */
  emitDelegation(
    parentAgentId: string,
    subAgentId: string,
    task: string,
    policyPack?: string,
    authorityScope?: string,
    approvalOwner?: string,
    accountableOwner?: string,
    parentAuditId?: string
  ): string {
    const id = `deleg-${++this.delegationCounter}-${Date.now().toString(36)}`;
    const scope = authorityScope || 'read-only';

    // In-memory
    const buffered: BufferedDelegation = {
      id,
      parentAgentId,
      subAgentId,
      task,
      authorityScope: scope,
      policyPack,
      approvalOwner,
      accountableOwner,
      parentAuditId,
      driftFlag: false,
      createdAt: new Date(),
    };

    if (this.delegationBuffer.length >= MAX_BUFFER_SIZE) {
      const evictCount = Math.max(1, Math.floor(MAX_BUFFER_SIZE * 0.05));
      this.delegationBuffer.splice(0, evictCount);
    }
    this.delegationBuffer.push(buffered);

    // PostgreSQL — fire-and-forget
    const record: DelegationRecord = {
      parentAgentId,
      subAgentId,
      task,
      authorityScope: scope,
      policyPack,
      approvalOwner,
      accountableOwner,
      parentAuditId,
      metadata: { syntheticId: id },
    };
    persistDelegation(record);

    // Also emit as governance event
    this.emit({
      eventType: 'delegation_started',
      sourceTool: 'governance_engine',
      sourceAuditId: parentAuditId,
      maiLevel: 'ADVISORY',
      details: `Delegation: ${parentAgentId} → ${subAgentId} for "${task}"`,
      metadata: { delegationId: id, parentAgentId, subAgentId, task, authorityScope: scope, policyPack },
    });

    return id;
  }

  /**
   * Resolve a delegation (completed, failed, escalated, recalled).
   */
  resolveDelegation(
    delegationId: string,
    disposition: string,
    driftFlag: boolean,
    remediationLink?: string,
    subAuditId?: string
  ): void {
    // Update in-memory
    const buffered = this.delegationBuffer.find(d => d.id === delegationId);
    if (buffered) {
      buffered.disposition = disposition;
      buffered.driftFlag = driftFlag;
      buffered.remediationLink = remediationLink;
      buffered.resolvedAt = new Date();

      // Update PostgreSQL — fire-and-forget
      updateDelegationDisposition(
        buffered.parentAgentId,
        buffered.subAgentId,
        disposition,
        driftFlag,
        remediationLink,
        subAuditId
      );
    }

    // Emit resolution event
    this.emit({
      eventType: 'delegation_resolved',
      sourceTool: 'governance_engine',
      sourceAuditId: subAuditId,
      maiLevel: driftFlag ? 'MANDATORY' : 'ADVISORY',
      details: `Delegation resolved: ${delegationId} — ${disposition}${driftFlag ? ' [DRIFT DETECTED]' : ''}`,
      metadata: { delegationId, disposition, driftFlag, remediationLink },
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // TOOL ACCOUNTABILITY — per-tool usage tracking
  // ═════════════════════════════════════════════════════════════════

  /**
   * Emit a tool invocation event. Called by every MCP tool handler.
   * Captures tool name, caller identity, MAI level, and outcome.
   */
  emitToolCall(
    toolName: string,
    auditId: string,
    maiLevel: string,
    success: boolean,
    durationMs?: number,
    callerAgent?: string,
    callerRole?: string
  ): void {
    this.emit({
      eventType: 'tool_invocation',
      sourceTool: toolName,
      sourceAuditId: auditId,
      maiLevel,
      details: `Tool ${toolName}: ${success ? 'SUCCESS' : 'FAILURE'}${durationMs ? ` (${durationMs}ms)` : ''}`,
      metadata: {
        toolName,
        success,
        durationMs: durationMs || 0,
        callerAgent: callerAgent || 'SYSTEM',
        callerRole: callerRole || 'unknown',
      },
    });
  }

  /**
   * Get tool usage counts grouped by tool name.
   * Returns { toolName: invocationCount } for accountability reporting.
   */
  getToolUsageCounts(since?: Date): Record<string, number> {
    const filtered = since
      ? this.eventBuffer.filter(e => e.timestamp >= since)
      : this.eventBuffer;

    const counts: Record<string, number> = {};
    for (const event of filtered) {
      const tool = event.sourceTool;
      if (tool) {
        counts[tool] = (counts[tool] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Get per-tool performance metrics: success rate, avg duration, error count.
   */
  getToolPerformanceMetrics(since?: Date): Record<string, {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgDurationMs: number;
    lastCalledAt: Date | null;
    callers: string[];
  }> {
    const filtered = since
      ? this.eventBuffer.filter(e => e.eventType === 'tool_invocation' && e.timestamp >= since)
      : this.eventBuffer.filter(e => e.eventType === 'tool_invocation');

    const metrics: Record<string, {
      totalCalls: number;
      successCount: number;
      failureCount: number;
      totalDuration: number;
      lastCalledAt: Date | null;
      callerSet: Set<string>;
    }> = {};

    for (const event of filtered) {
      const tool = event.sourceTool;
      if (!metrics[tool]) {
        metrics[tool] = {
          totalCalls: 0,
          successCount: 0,
          failureCount: 0,
          totalDuration: 0,
          lastCalledAt: null,
          callerSet: new Set(),
        };
      }
      const m = metrics[tool];
      m.totalCalls++;
      const meta = event.metadata as Record<string, unknown> | undefined;
      if (meta?.success === true) m.successCount++;
      else if (meta?.success === false) m.failureCount++;
      if (typeof meta?.durationMs === 'number') m.totalDuration += meta.durationMs;
      if (meta?.callerAgent && typeof meta.callerAgent === 'string') {
        m.callerSet.add(meta.callerAgent);
      }
      if (!m.lastCalledAt || event.timestamp > m.lastCalledAt) {
        m.lastCalledAt = event.timestamp;
      }
    }

    const result: Record<string, {
      totalCalls: number;
      successCount: number;
      failureCount: number;
      successRate: number;
      avgDurationMs: number;
      lastCalledAt: Date | null;
      callers: string[];
    }> = {};

    for (const [tool, m] of Object.entries(metrics)) {
      result[tool] = {
        totalCalls: m.totalCalls,
        successCount: m.successCount,
        failureCount: m.failureCount,
        successRate: m.totalCalls > 0 ? Math.round((m.successCount / m.totalCalls) * 100) : 0,
        avgDurationMs: m.totalCalls > 0 ? Math.round(m.totalDuration / m.totalCalls) : 0,
        lastCalledAt: m.lastCalledAt,
        callers: Array.from(m.callerSet),
      };
    }

    return result;
  }

  /**
   * Get total unique tools invoked in period.
   */
  getActiveToolCount(since?: Date): number {
    const counts = this.getToolUsageCounts(since);
    return Object.keys(counts).length;
  }

  // ═════════════════════════════════════════════════════════════════
  // ACCESSORS — for reports and quality dimensions
  // ═════════════════════════════════════════════════════════════════

  /**
   * Get event counts from in-memory buffer.
   * Falls through to PostgreSQL if available for full history.
   */
  getEventCounts(since?: Date): Record<string, number> {
    const filtered = since
      ? this.eventBuffer.filter(e => e.timestamp >= since)
      : this.eventBuffer;

    const counts: Record<string, number> = {};
    for (const event of filtered) {
      counts[event.eventType] = (counts[event.eventType] || 0) + 1;
    }
    return counts;
  }

  /**
   * Get event counts from PostgreSQL (async, full history).
   */
  async getEventCountsFromDB(since?: Date): Promise<Record<string, number>> {
    return dbGetEventCounts(since);
  }

  /**
   * Get delegation statistics from in-memory buffer.
   */
  getDelegationStats(since?: Date): {
    totalDelegations: number;
    activeDelegations: number;
    completedDelegations: number;
    driftCount: number;
    uniqueParentAgents: number;
    uniqueSubAgents: number;
  } {
    const filtered = since
      ? this.delegationBuffer.filter(d => d.createdAt >= since)
      : this.delegationBuffer;

    const parentAgents = new Set<string>();
    const subAgents = new Set<string>();

    let active = 0;
    let completed = 0;
    let driftCount = 0;

    for (const d of filtered) {
      parentAgents.add(d.parentAgentId);
      subAgents.add(d.subAgentId);
      if (!d.resolvedAt) active++;
      if (d.disposition === 'completed') completed++;
      if (d.driftFlag) driftCount++;
    }

    return {
      totalDelegations: filtered.length,
      activeDelegations: active,
      completedDelegations: completed,
      driftCount,
      uniqueParentAgents: parentAgents.size,
      uniqueSubAgents: subAgents.size,
    };
  }

  /**
   * Get delegation stats from PostgreSQL (async, full history).
   */
  async getDelegationStatsFromDB(since?: Date) {
    return dbGetDelegationStats(since);
  }

  /**
   * Get total event count in buffer (for health checks).
   */
  get bufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Get recent events (for quick report snapshots).
   */
  getRecentEvents(limit: number = 50): ReadonlyArray<BufferedEvent> {
    return this.eventBuffer.slice(-limit);
  }

  /**
   * Get last event timestamp for a given type.
   */
  getLastEventTimestamp(eventType: string): Date | null {
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      if (this.eventBuffer[i].eventType === eventType) {
        return this.eventBuffer[i].timestamp;
      }
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════
  // INTERNAL — write-through emit
  // ═════════════════════════════════════════════════════════════════

  private emit(event: {
    eventType: string;
    sourceTool: string;
    sourceAuditId?: string;
    maiLevel?: string;
    details: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date();

    // In-memory circular buffer (always succeeds)
    // Evict oldest entries in batch if at capacity — reduces per-emit overhead
    if (this.eventBuffer.length >= MAX_BUFFER_SIZE) {
      // Evict 5% to avoid shift() on every single emit at capacity
      const evictCount = Math.max(1, Math.floor(MAX_BUFFER_SIZE * 0.05));
      this.eventBuffer.splice(0, evictCount);
    }
    this.eventBuffer.push({ ...event, timestamp: now });

    // PostgreSQL — fire-and-forget
    const record: GovernanceEventRecord = {
      eventType: event.eventType,
      sourceTool: event.sourceTool,
      sourceAuditId: event.sourceAuditId,
      maiLevel: event.maiLevel,
      details: event.details,
      metadata: event.metadata,
    };
    persistGovernanceEvent(record);
  }
}
