/**
 * @module    runtime-accountability-service
 * @layer     GOVERNANCE
 * @mai       M — runtime accountability is MANDATORY for full traceability
 * @audit     true — every runtime session is compliance evidence
 * @owner     William J. Storey III / ACE / GIA
 *
 * RUNTIME ACCOUNTABILITY SERVICE — 4th Control Surface
 *
 * Completes the governed execution story:
 *   1. Decision layer  → What was decided (MAI classification)
 *   2. Delegation layer → Who delegated to whom (agent delegations)
 *   3. Execution layer  → Which tools ran (tool accountability)
 *   4. Runtime layer    → Under what operating conditions (THIS SERVICE)
 *
 * "Who did what, using which tool, under which contract,
 *  in which runtime state, with what controls, and what happened."
 *
 * Design:
 * - Dual write-through: bounded in-memory + PostgreSQL
 * - Fire-and-forget: every emit is non-blocking
 * - Instance-scoped: one service per GovernanceEngine (one per process)
 * - Config fingerprint: SHA-256 of governance config at boot (drift detection)
 * - Environment detection: auto-detects production/staging/demo from env vars
 */

import { v4 as uuidv4 } from 'uuid';
import {
  persistRuntimeSession,
  updateRuntimeSession,
  getRuntimeStats as dbGetRuntimeStats,
  getActiveSessions as dbGetActiveSessions,
  type RuntimeSessionRecord,
  type RuntimeSessionUpdate,
  type RuntimeStats,
} from '../persistence/runtime-persistence.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type SessionDisposition =
  | 'active'
  | 'completed'
  | 'failed'
  | 'halted'
  | 'escalated'
  | 'degraded'
  | 'timed_out';

export type SessionType =
  | 'tool_invocation'
  | 'agent_workflow'
  | 'batch_operation'
  | 'swarm_run';

export interface RuntimeSession {
  runtimeId: string;
  instanceId: string;
  sessionType: SessionType;
  parentRuntimeId?: string;
  workflowId?: string;
  contractId?: string;
  runId?: string;
  agentId?: string;
  agentRole?: string;
  provider?: string;
  model?: string;
  environment: string;
  policyPackId?: string;
  policyPackVersion?: string;
  configFingerprint: string;
  maiLevel?: string;
  auditId?: string;

  // Lifecycle
  startedAt: Date;
  endedAt?: Date;
  disposition: SessionDisposition;

  // Execution metrics (accumulated during session)
  toolsInvoked: Set<string>;
  gateCount: number;
  retryCount: number;
  fallbackCount: number;
  breakGlassUsed: boolean;

  // Resource metrics
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;

  // Error context
  errorMessage?: string;
  errorCode?: string;
}

export interface RuntimeContext {
  runtimeId: string;
  instanceId: string;
  environment: string;
  configFingerprint: string;
  workflowId?: string;
  contractId?: string;
  parentRuntimeId?: string;
}

// ═══════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════

const MAX_SESSION_BUFFER = 5000;

export class RuntimeAccountabilityService {
  /** Stable instance ID for this engine process — survives session starts/stops */
  public readonly instanceId: string;

  /** SHA-256 fingerprint of governance config at boot */
  public readonly configFingerprint: string;

  /** Detected runtime environment */
  public readonly environment: string;

  /** Boot timestamp */
  public readonly bootedAt: Date;

  /** In-memory session buffer (bounded circular) */
  private readonly sessionBuffer: RuntimeSession[] = [];

  /** Active sessions index by runtimeId (fast lookup) */
  private readonly activeSessions: Map<string, RuntimeSession> = new Map();

  /** Session counter for this instance */
  private sessionCounter = 0;

  constructor(configFingerprint?: string) {
    this.instanceId = `gia-${uuidv4().slice(0, 8)}`;
    this.bootedAt = new Date();
    this.environment = this.detectEnvironment();
    this.configFingerprint = configFingerprint || 'no-config-hash';
  }

  // ═════════════════════════════════════════════════════════════════
  // SESSION LIFECYCLE
  // ═════════════════════════════════════════════════════════════════

  /**
   * Start a new runtime session. Returns a RuntimeContext that should be
   * threaded through all governed operations within this session.
   */
  startSession(params: {
    sessionType?: SessionType;
    parentRuntimeId?: string;
    workflowId?: string;
    contractId?: string;
    runId?: string;
    agentId?: string;
    agentRole?: string;
    provider?: string;
    model?: string;
    policyPackId?: string;
    policyPackVersion?: string;
    maiLevel?: string;
    auditId?: string;
    metadata?: Record<string, unknown>;
  }): RuntimeContext {
    const runtimeId = `rt-${++this.sessionCounter}-${Date.now().toString(36)}-${uuidv4().slice(0, 8)}`;

    const session: RuntimeSession = {
      runtimeId,
      instanceId: this.instanceId,
      sessionType: params.sessionType || 'tool_invocation',
      parentRuntimeId: params.parentRuntimeId,
      workflowId: params.workflowId,
      contractId: params.contractId,
      runId: params.runId,
      agentId: params.agentId,
      agentRole: params.agentRole,
      provider: params.provider,
      model: params.model,
      environment: this.environment,
      policyPackId: params.policyPackId,
      policyPackVersion: params.policyPackVersion,
      configFingerprint: this.configFingerprint,
      maiLevel: params.maiLevel,
      auditId: params.auditId,
      startedAt: new Date(),
      disposition: 'active',
      toolsInvoked: new Set(),
      gateCount: 0,
      retryCount: 0,
      fallbackCount: 0,
      breakGlassUsed: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      estimatedCostUsd: 0,
    };

    // In-memory tracking
    this.activeSessions.set(runtimeId, session);
    if (this.sessionBuffer.length >= MAX_SESSION_BUFFER) {
      const evictCount = Math.max(1, Math.floor(MAX_SESSION_BUFFER * 0.05));
      this.sessionBuffer.splice(0, evictCount);
    }
    this.sessionBuffer.push(session);

    // PostgreSQL — fire-and-forget
    const record: RuntimeSessionRecord = {
      runtimeId,
      instanceId: this.instanceId,
      sessionType: session.sessionType,
      parentRuntimeId: params.parentRuntimeId,
      workflowId: params.workflowId,
      contractId: params.contractId,
      runId: params.runId,
      agentId: params.agentId,
      agentRole: params.agentRole,
      provider: params.provider,
      model: params.model,
      environment: this.environment,
      policyPackId: params.policyPackId,
      policyPackVersion: params.policyPackVersion,
      configFingerprint: this.configFingerprint,
      maiLevel: params.maiLevel,
      auditId: params.auditId,
      metadata: params.metadata,
    };
    persistRuntimeSession(record);

    return {
      runtimeId,
      instanceId: this.instanceId,
      environment: this.environment,
      configFingerprint: this.configFingerprint,
      workflowId: params.workflowId,
      contractId: params.contractId,
      parentRuntimeId: params.parentRuntimeId,
    };
  }

  /**
   * Record a tool invocation within an active session.
   */
  recordToolUse(runtimeId: string, toolName: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.toolsInvoked.add(toolName);
    }
  }

  /**
   * Record a gate trigger within an active session.
   */
  recordGate(runtimeId: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.gateCount++;
    }
  }

  /**
   * Record a retry within an active session.
   */
  recordRetry(runtimeId: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.retryCount++;
    }
  }

  /**
   * Record a fallback within an active session.
   */
  recordFallback(runtimeId: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.fallbackCount++;
    }
  }

  /**
   * Record a break-glass override within an active session.
   */
  recordBreakGlass(runtimeId: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.breakGlassUsed = true;
    }
  }

  /**
   * Record token usage within an active session.
   */
  recordTokens(runtimeId: string, input: number, output: number, costUsd?: number): void {
    const session = this.activeSessions.get(runtimeId);
    if (session) {
      session.inputTokens += input;
      session.outputTokens += output;
      session.totalTokens += (input + output);
      if (costUsd) session.estimatedCostUsd += costUsd;
    }
  }

  /**
   * Elevate the MAI level for this session (highest wins).
   */
  elevateMaiLevel(runtimeId: string, level: string): void {
    const session = this.activeSessions.get(runtimeId);
    if (!session) return;

    const rank: Record<string, number> = { INFORMATIONAL: 1, ADVISORY: 2, MANDATORY: 3 };
    const currentRank = rank[session.maiLevel || 'INFORMATIONAL'] || 0;
    const newRank = rank[level] || 0;
    if (newRank > currentRank) {
      session.maiLevel = level;
    }
  }

  /**
   * End a runtime session with a final disposition.
   */
  endSession(runtimeId: string, disposition: SessionDisposition, error?: { message: string; code?: string }): void {
    const session = this.activeSessions.get(runtimeId);
    if (!session) return;

    // Update in-memory
    session.disposition = disposition;
    session.endedAt = new Date();
    session.latencyMs = session.endedAt.getTime() - session.startedAt.getTime();
    if (error) {
      session.errorMessage = error.message;
      session.errorCode = error.code;
    }

    // Remove from active index
    this.activeSessions.delete(runtimeId);

    // PostgreSQL — fire-and-forget
    const update: RuntimeSessionUpdate = {
      disposition,
      toolsInvoked: Array.from(session.toolsInvoked),
      toolCount: session.toolsInvoked.size,
      gateCount: session.gateCount,
      retryCount: session.retryCount,
      fallbackCount: session.fallbackCount,
      breakGlassUsed: session.breakGlassUsed,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      totalTokens: session.totalTokens,
      latencyMs: session.latencyMs,
      estimatedCostUsd: session.estimatedCostUsd,
      errorMessage: error?.message,
      errorCode: error?.code,
      maiLevel: session.maiLevel,
    };
    updateRuntimeSession(runtimeId, update);
  }

  // ═════════════════════════════════════════════════════════════════
  // ACCESSORS — for reports and system-status
  // ═════════════════════════════════════════════════════════════════

  /**
   * Get in-memory runtime stats (fast, bounded by buffer).
   */
  getStats(since?: Date): {
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    failedSessions: number;
    avgLatencyMs: number;
    totalTokens: number;
    totalCostUsd: number;
    uniqueAgents: number;
    breakGlassCount: number;
    retryTotal: number;
    fallbackTotal: number;
  } {
    const filtered = since
      ? this.sessionBuffer.filter(s => s.startedAt >= since)
      : this.sessionBuffer;

    const agents = new Set<string>();
    let completed = 0, failed = 0;
    let totalLatency = 0, latencyCount = 0;
    let tokens = 0, cost = 0;
    let breakGlass = 0, retries = 0, fallbacks = 0;

    for (const s of filtered) {
      if (s.agentId) agents.add(s.agentId);
      if (s.disposition === 'completed') completed++;
      if (s.disposition === 'failed') failed++;
      if (s.endedAt) { totalLatency += s.latencyMs; latencyCount++; }
      tokens += s.totalTokens;
      cost += s.estimatedCostUsd;
      if (s.breakGlassUsed) breakGlass++;
      retries += s.retryCount;
      fallbacks += s.fallbackCount;
    }

    return {
      totalSessions: filtered.length,
      activeSessions: this.activeSessions.size,
      completedSessions: completed,
      failedSessions: failed,
      avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
      totalTokens: tokens,
      totalCostUsd: Math.round(cost * 1000000) / 1000000,
      uniqueAgents: agents.size,
      breakGlassCount: breakGlass,
      retryTotal: retries,
      fallbackTotal: fallbacks,
    };
  }

  /**
   * Get full runtime stats from PostgreSQL (async, full history).
   */
  async getStatsFromDB(since?: Date): Promise<RuntimeStats> {
    return dbGetRuntimeStats(since);
  }

  /**
   * Get active session count from PostgreSQL for this instance.
   */
  async getActiveSessionCountFromDB(): Promise<number> {
    return dbGetActiveSessions(this.instanceId);
  }

  /**
   * Get runtime instance context (for embedding in reports/status).
   */
  getInstanceContext(): {
    instanceId: string;
    environment: string;
    configFingerprint: string;
    bootedAt: string;
    uptimeMs: number;
    totalSessionsStarted: number;
    activeSessionCount: number;
    bufferSize: number;
  } {
    return {
      instanceId: this.instanceId,
      environment: this.environment,
      configFingerprint: this.configFingerprint,
      bootedAt: this.bootedAt.toISOString(),
      uptimeMs: Date.now() - this.bootedAt.getTime(),
      totalSessionsStarted: this.sessionCounter,
      activeSessionCount: this.activeSessions.size,
      bufferSize: this.sessionBuffer.length,
    };
  }

  /**
   * Get recent sessions (for quick inspection).
   */
  getRecentSessions(limit: number = 20): ReadonlyArray<{
    runtimeId: string;
    sessionType: string;
    agentId?: string;
    disposition: string;
    toolCount: number;
    latencyMs: number;
    maiLevel?: string;
    startedAt: string;
  }> {
    return this.sessionBuffer.slice(-limit).map(s => ({
      runtimeId: s.runtimeId,
      sessionType: s.sessionType,
      agentId: s.agentId,
      disposition: s.disposition,
      toolCount: s.toolsInvoked.size,
      latencyMs: s.latencyMs,
      maiLevel: s.maiLevel,
      startedAt: s.startedAt.toISOString(),
    }));
  }

  // ═════════════════════════════════════════════════════════════════
  // INTERNAL
  // ═════════════════════════════════════════════════════════════════

  private detectEnvironment(): string {
    const env = process.env.NODE_ENV || process.env.GIA_ENVIRONMENT || '';
    if (env.includes('prod')) return 'production';
    if (env.includes('stag')) return 'staging';
    if (env.includes('demo')) return 'demo';
    if (env.includes('eval')) return 'eval_only';
    if (env.includes('train')) return 'training';
    if (env.includes('dev') || env.includes('test')) return 'staging';
    return 'production'; // Default to most restrictive
  }
}
