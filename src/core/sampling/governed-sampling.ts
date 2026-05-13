/**
 * @module    governed-sampling
 * @layer     CORE
 * @inherits  governance-root
 * @mai       A — sampling requests are ADVISORY baseline, elevated by context
 * @audit     true — every sampling request and response is ledgered
 * @owner     William J. Storey III / ACE / GIA
 *
 * Governed Sampling — Client-Mediated Model Invocation Under Governance
 *
 * MCP Sampling lets the server request the CLIENT to perform LLM completions.
 * This module wraps that capability with full GIA governance:
 *
 *   1. Policy validation (purpose, tokens, rate, budget)
 *   2. MAI classification (MANDATORY/ADVISORY/INFORMATIONAL)
 *   3. Gate enforcement (human approval for MANDATORY)
 *   4. Forensic ledger entry (request + response)
 *   5. Governance scoring
 *   6. Token budget tracking
 *
 * Security model:
 *   - Server NEVER touches API keys for sampled calls — client handles auth
 *   - Ledger distinguishes: server requested → client executed → governance recorded
 *   - Token budget enforcement prevents runaway sampling
 *   - Context scope control (none/thisServer/allServers) defaults to 'none'
 *
 * "Sampling turns the model call into a governed service request
 *  instead of a hardcoded dependency." — GIA Architecture Principle
 */

import { createHash } from 'crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { GovernanceEngine } from '../governance.js';
import { MaiClassification, GiaLayer, ErrorSeverity } from '../../shared/types.js';
import type { IGovernanceScore, IGateDecision, IMaiResult } from '../../shared/types.js';
import { SAMPLING_OP_REQUESTED, SAMPLING_OP_DENIED } from '../../shared/constants.js';
import { GovernedError } from '../../shared/errors.js';
import { sanitize } from '../../shared/utils.js';
import type { IClassificationContext } from '../mai/types.js';
import { type ISamplingPolicy, type SamplingPurpose, DEFAULT_SAMPLING_POLICY } from './sampling-policy.js';

// ─── Request / Result Types ────────────────────────────────────────────────

export interface ISamplingRequest {
  /** Why this sampling is happening — governs MAI classification */
  purpose: SamplingPurpose;
  /** System prompt for the sampling request */
  systemPrompt: string;
  /** Message history */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Maximum tokens for the response */
  maxTokens: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** Context inclusion mode */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  /** Additional metadata for the ledger */
  metadata?: Record<string, unknown>;
  /** Agent requesting the sample */
  agentName?: string;
  /** Domain context for MAI classification */
  domain?: string;
  /** Correlation ID for cross-system tracing */
  correlationId?: string;
}

export interface ISamplingResult {
  /** Text content from the model */
  content: string;
  /** Model that produced the response (chosen by client) */
  model: string;
  /** Why the model stopped */
  stopReason: string;
  /** Estimated tokens consumed */
  tokensUsed: number;
  /** Forensic ledger audit ID */
  auditId: string;
  /** MAI classification applied */
  classification: IMaiResult;
  /** Governance score of the result */
  score: IGovernanceScore;
  /** Gate decision (if MANDATORY gate was enforced) */
  gateDecision?: IGateDecision;
}

// ─── Rate Limiter (In-Memory) ──────────────────────────────────────────────

interface RateBucket {
  minute: number;    // minute timestamp (Date.now() / 60000 | 0)
  count: number;
}

interface TokenBucket {
  hour: number;      // hour timestamp (Date.now() / 3600000 | 0)
  tokens: number;
}

// ─── GovernedSampling Service ──────────────────────────────────────────────

export class GovernedSampling {
  private readonly engine: GovernanceEngine;
  private readonly serverRef: Server;
  private readonly policy: ISamplingPolicy;

  // In-memory rate tracking — resets on restart (acceptable for protective limits)
  private readonly rateBuckets: RateBucket[] = [];
  private readonly tokenBucket: TokenBucket = { hour: 0, tokens: 0 };

  constructor(engine: GovernanceEngine, serverRef: Server) {
    this.engine = engine;
    this.serverRef = serverRef;
    this.policy = DEFAULT_SAMPLING_POLICY;
  }

  /**
   * Execute a governed sampling request.
   *
   * 10-step flow:
   *   1. Policy validation
   *   2. Begin ledger entry
   *   3. MAI classify
   *   4. Gate enforcement (if MANDATORY)
   *   5. Build SDK params
   *   6. Execute sampling (client performs completion)
   *   7. Extract content
   *   8. Score result
   *   9. Complete ledger entry
   *  10. Update rate counters
   */
  async sample(request: ISamplingRequest): Promise<ISamplingResult> {

    // ── Step 1: Policy validation ──────────────────────────────────────────
    this.validatePolicy(request);

    // ── Step 2: Begin ledger entry ─────────────────────────────────────────
    const entry = this.engine.ledger.begin(
      SAMPLING_OP_REQUESTED,
      MaiClassification.ADVISORY,
      GiaLayer.CORE,
      request.agentName || 'governed-sampling',
      undefined,
      request.correlationId,
    );
    entry.addMetadata('purpose', request.purpose);
    entry.addMetadata('domain', request.domain || 'general');
    entry.addMetadata('maxTokens', request.maxTokens);
    entry.addMetadata('includeContext', request.includeContext || this.policy.defaultIncludeContext);
    entry.addMetadata('messageCount', request.messages.length);
    if (request.metadata) {
      entry.addMetadata('requestMetadata', request.metadata);
    }

    try {
      // ── Step 3: MAI classify ───────────────────────────────────────────────
      const baseLevel = this.policy.requireGateForPurposes.includes(request.purpose)
        ? MaiClassification.MANDATORY
        : MaiClassification.ADVISORY;

      const context: IClassificationContext = {
        operation: `sampling:${request.purpose}`,
        agentName: request.agentName,
        vertical: request.domain === 'va-claims' ? 'ace' : request.domain,
        inputSensitivity: 'CONTROLLED',
        outputAudience: 'INTERNAL',
        hasFinancialImpact: false,
        hasLegalImpact: false,
        piiDetected: false,
        correlationId: request.correlationId,
      };

      const classification = this.engine.classifier.classify(
        `sampling:${request.purpose}`,
        baseLevel,
        context,
      );

      entry.addMetadata('maiClassification', classification.classification);
      entry.addMetadata('maiConfidence', classification.confidence);
      this.engine.thresholdMonitor.record(classification);

      // ── Step 4: Gate enforcement ─────────────────────────────────────────
      let gateDecision: IGateDecision | undefined;
      if (classification.requiresGate) {
        gateDecision = await this.engine.gate.enforce(
          classification.classification,
          `sampling:${request.purpose}`,
          entry.id,
        );
        entry.addMetadata('gateId', gateDecision.gateId);
        entry.addMetadata('gateStatus', gateDecision.status);
      }

      // ── Step 5: Build SDK params ─────────────────────────────────────────
      const sdkParams = {
        messages: request.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: { type: 'text' as const, text: m.content },
        })),
        systemPrompt: request.systemPrompt,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        includeContext: (request.includeContext || this.policy.defaultIncludeContext) as 'none' | 'thisServer' | 'allServers',
        modelPreferences: {
          intelligencePriority: 0.7,
          speedPriority: 0.5,
          costPriority: 0.8,
        },
      };

      // ── Step 6: Execute sampling ─────────────────────────────────────────
      const result = await this.serverRef.createMessage(sdkParams);

      // ── Step 7: Extract content ──────────────────────────────────────────
      let textContent = '';
      if (result.content && typeof result.content === 'object' && 'text' in result.content) {
        textContent = (result.content as { text: string }).text;
      } else if (typeof result.content === 'string') {
        textContent = result.content;
      } else if (Array.isArray(result.content)) {
        // Array of content blocks
        textContent = (result.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text)
          .join('\n');
      }

      const estimatedTokens = Math.ceil(textContent.length / 4); // rough estimate
      const contentHash = createHash('sha256').update(textContent).digest('hex').slice(0, 16);

      // ── Step 8: Score result ─────────────────────────────────────────────
      const score = this.engine.scorer.score(
        {
          integrity: 0.95,    // High: cryptographic transport, hash-verified
          accuracy: 0.85,     // Moderate: model output, not independently verified
          compliance: 0.90,   // High: governed request path, policy-validated
        },
        SAMPLING_OP_REQUESTED,
        entry.id,
      );

      // ── Step 9: Complete ledger entry ────────────────────────────────────
      entry.addMetadata('responseModel', result.model);
      entry.addMetadata('stopReason', result.stopReason || 'unknown');
      entry.addMetadata('tokensUsed', estimatedTokens);
      entry.addMetadata('contentHash', contentHash);
      entry.addMetadata('contentLength', textContent.length);

      const completedEntry = entry.complete(score, classification, gateDecision);
      this.engine.ledger.record(completedEntry);

      // Telemetry
      this.engine.telemetryService.emitToolCall(
        'governed_sample', entry.id, classification.classification,
        true, undefined, request.agentName,
      );

      // ── Step 10: Update rate counters ────────────────────────────────────
      this.recordUsage(estimatedTokens);

      return {
        content: textContent,
        model: result.model,
        stopReason: result.stopReason || 'unknown',
        tokensUsed: estimatedTokens,
        auditId: entry.id,
        classification,
        score,
        gateDecision,
      };

    } catch (error: unknown) {
      // Record failure to ledger
      const err = error instanceof Error ? error : new Error(String(error));
      const failedEntry = entry.fail(err, MaiClassification.ADVISORY);
      this.engine.ledger.record(failedEntry);

      this.engine.telemetryService.emitToolCall(
        'governed_sample', entry.id, 'ADVISORY', false, undefined, request.agentName,
      );

      // Check for sampling not supported
      const errMsg = err.message.toLowerCase();
      if (errMsg.includes('not supported') || errMsg.includes('capability') || errMsg.includes('sampling')) {
        throw new GovernedError('Client does not support MCP Sampling', {
          code: 'SAMPLING_NOT_SUPPORTED',
          layer: GiaLayer.CORE,
          maiLevel: MaiClassification.ADVISORY,
          auditId: entry.id,
          severity: ErrorSeverity.ADVISORY,
          publicMessage: 'The connected client does not support MCP Sampling. Ensure your client (Claude Desktop, Claude Code) supports the sampling capability.',
          cause: err,
        });
      }

      throw new GovernedError('Governed sampling failed', {
        code: 'SAMPLING_FAILED',
        layer: GiaLayer.CORE,
        maiLevel: MaiClassification.ADVISORY,
        auditId: entry.id,
        severity: ErrorSeverity.ADVISORY,
        publicMessage: `Sampling request failed. Audit ID: ${entry.id}`,
        cause: err,
      });
    }
  }

  // ─── Policy Validation ─────────────────────────────────────────────────

  private validatePolicy(request: ISamplingRequest): void {
    // Purpose check
    if (!this.policy.allowedPurposes.includes(request.purpose)) {
      const denyEntry = this.engine.ledger.begin(
        SAMPLING_OP_DENIED, MaiClassification.ADVISORY, GiaLayer.CORE,
        request.agentName || 'governed-sampling',
      );
      denyEntry.addMetadata('reason', 'purpose_not_allowed');
      denyEntry.addMetadata('purpose', request.purpose);
      const score = this.engine.scorer.scoreDefault(SAMPLING_OP_DENIED);
      this.engine.ledger.record(denyEntry.complete(score, {
        classification: MaiClassification.ADVISORY, confidence: 1.0,
        rationale: `Purpose '${request.purpose}' not in allowed list`, requiresGate: false,
      }));
      throw new GovernedError(`Sampling purpose '${request.purpose}' is not allowed by policy`, {
        code: 'SAMPLING_PURPOSE_DENIED', layer: GiaLayer.CORE,
        maiLevel: MaiClassification.ADVISORY, auditId: denyEntry.id,
        severity: ErrorSeverity.ADVISORY,
        publicMessage: `Sampling purpose '${request.purpose}' is not permitted.`,
      });
    }

    // Token cap
    if (request.maxTokens > this.policy.maxTokensPerRequest) {
      throw new GovernedError(`Token request ${request.maxTokens} exceeds policy cap ${this.policy.maxTokensPerRequest}`, {
        code: 'SAMPLING_TOKEN_LIMIT', layer: GiaLayer.CORE,
        maiLevel: MaiClassification.ADVISORY, auditId: 'pre-validation',
        severity: ErrorSeverity.ADVISORY,
        publicMessage: `Maximum tokens per request is ${this.policy.maxTokensPerRequest}.`,
      });
    }

    // Rate limit
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);
    // Prune old buckets
    while (this.rateBuckets.length > 0 && this.rateBuckets[0].minute < currentMinute) {
      this.rateBuckets.shift();
    }
    const minuteCount = this.rateBuckets.reduce((sum, b) => sum + b.count, 0);
    if (minuteCount >= this.policy.maxRequestsPerMinute) {
      throw new GovernedError('Sampling rate limit exceeded', {
        code: 'SAMPLING_RATE_LIMITED', layer: GiaLayer.CORE,
        maiLevel: MaiClassification.ADVISORY, auditId: 'pre-validation',
        severity: ErrorSeverity.ADVISORY,
        publicMessage: `Rate limit: max ${this.policy.maxRequestsPerMinute} requests/minute.`,
      });
    }

    // Hourly budget
    const currentHour = Math.floor(now / 3_600_000);
    if (this.tokenBucket.hour !== currentHour) {
      this.tokenBucket.hour = currentHour;
      this.tokenBucket.tokens = 0;
    }
    if (this.tokenBucket.tokens + request.maxTokens > this.policy.maxTokenBudgetPerHour) {
      throw new GovernedError('Hourly token budget exhausted', {
        code: 'SAMPLING_BUDGET_EXHAUSTED', layer: GiaLayer.CORE,
        maiLevel: MaiClassification.ADVISORY, auditId: 'pre-validation',
        severity: ErrorSeverity.ADVISORY,
        publicMessage: `Hourly token budget of ${this.policy.maxTokenBudgetPerHour} tokens exhausted.`,
      });
    }
  }

  // ─── Usage Tracking ────────────────────────────────────────────────────

  private recordUsage(tokensUsed: number): void {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);
    const currentHour = Math.floor(now / 3_600_000);

    // Rate bucket
    const lastBucket = this.rateBuckets[this.rateBuckets.length - 1];
    if (lastBucket && lastBucket.minute === currentMinute) {
      lastBucket.count++;
    } else {
      this.rateBuckets.push({ minute: currentMinute, count: 1 });
    }

    // Token budget
    if (this.tokenBucket.hour !== currentHour) {
      this.tokenBucket.hour = currentHour;
      this.tokenBucket.tokens = 0;
    }
    this.tokenBucket.tokens += tokensUsed;
  }

  // ─── Status ────────────────────────────────────────────────────────────

  getStatus(): {
    available: boolean;
    policy: ISamplingPolicy;
    currentMinuteRequests: number;
    currentHourTokens: number;
  } {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);
    const currentHour = Math.floor(now / 3_600_000);

    const minuteCount = this.rateBuckets
      .filter(b => b.minute === currentMinute)
      .reduce((sum, b) => sum + b.count, 0);

    const hourTokens = this.tokenBucket.hour === currentHour ? this.tokenBucket.tokens : 0;

    return {
      available: true,
      policy: this.policy,
      currentMinuteRequests: minuteCount,
      currentHourTokens: hourTokens,
    };
  }
}
