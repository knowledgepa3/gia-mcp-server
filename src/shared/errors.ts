/**
 * @module    shared-errors
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A — triggered by governance layer
 * @audit     true — all GovernedErrors produce audit entries
 * @owner     William J. Storey III / ACE / GIA
 */

import { MaiClassification, GiaLayer, ErrorSeverity } from './types.js';

export class GovernedError extends Error {
  public readonly code: string;
  public readonly layer: GiaLayer;
  public readonly maiLevel: MaiClassification;
  public readonly auditId: string;
  public readonly severity: ErrorSeverity;
  public readonly publicMessage: string;
  public readonly timestamp: Date;

  constructor(
    message: string,
    options: {
      code: string;
      layer: GiaLayer;
      maiLevel: MaiClassification;
      auditId: string;
      severity: ErrorSeverity;
      publicMessage?: string;
      cause?: Error;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'GovernedError';
    this.code = options.code;
    this.layer = options.layer;
    this.maiLevel = options.maiLevel;
    this.auditId = options.auditId;
    this.severity = options.severity;
    this.publicMessage = options.publicMessage ?? 'A governance error occurred.';
    this.timestamp = new Date();
  }

  toPublicResponse(): Record<string, unknown> {
    return {
      error: this.code,
      governanceLayer: this.layer,
      maiLevel: this.maiLevel,
      auditId: this.auditId,
      message: this.publicMessage,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

export class GateRejectionError extends GovernedError {
  constructor(gateId: string, classification: MaiClassification, auditId: string, rationale: string) {
    super(`Gate ${gateId} rejected: ${rationale}`, {
      code: 'GATE_REJECTED', layer: GiaLayer.CORE, maiLevel: classification,
      auditId, severity: ErrorSeverity.MANDATORY,
      publicMessage: `Operation requires approval. Gate ID: ${gateId}`,
    });
    this.name = 'GateRejectionError';
  }
}

export class ScoreFailureError extends GovernedError {
  public readonly score: number;
  public readonly threshold: number;
  constructor(operation: string, score: number, threshold: number, auditId: string) {
    super(`Governance score ${score.toFixed(3)} below threshold ${threshold} for ${operation}`, {
      code: 'SCORE_BELOW_THRESHOLD', layer: GiaLayer.CORE, maiLevel: MaiClassification.MANDATORY,
      auditId, severity: ErrorSeverity.MANDATORY,
      publicMessage: `Output did not meet governance quality threshold. Audit ID: ${auditId}`,
    });
    this.name = 'ScoreFailureError';
    this.score = score;
    this.threshold = threshold;
  }
}

export class SupervisorHaltError extends GovernedError {
  constructor(agent: string, rationale: string, auditId: string) {
    super(`Supervisor halted agent ${agent}: ${rationale}`, {
      code: 'SUPERVISOR_HALT', layer: GiaLayer.CORE, maiLevel: MaiClassification.MANDATORY,
      auditId, severity: ErrorSeverity.MANDATORY,
      publicMessage: `Pipeline halted by supervisor. Audit ID: ${auditId}`,
    });
    this.name = 'SupervisorHaltError';
  }
}

export class AuthenticationError extends GovernedError {
  constructor(reason: string, auditId: string) {
    super(`Authentication failed: ${reason}`, {
      code: 'AUTHENTICATION_FAILED', layer: GiaLayer.MCP, maiLevel: MaiClassification.MANDATORY,
      auditId, severity: ErrorSeverity.MANDATORY, publicMessage: 'Authentication required.',
    });
    this.name = 'AuthenticationError';
  }
}

export class TierPermissionError extends GovernedError {
  constructor(currentTier: string, requiredTier: string, tool: string, auditId: string) {
    super(`Tier ${currentTier} insufficient for ${tool}, requires ${requiredTier}`, {
      code: 'INSUFFICIENT_TIER', layer: GiaLayer.MCP, maiLevel: MaiClassification.ADVISORY,
      auditId, severity: ErrorSeverity.ADVISORY,
      publicMessage: `This tool requires ${requiredTier} tier access.`,
    });
    this.name = 'TierPermissionError';
  }
}

export class LedgerWriteError extends GovernedError {
  constructor(operation: string, auditId: string, cause?: Error) {
    super(`Forensic ledger write failed for ${operation}`, {
      code: 'LEDGER_WRITE_FAILURE', layer: GiaLayer.CORE, maiLevel: MaiClassification.MANDATORY,
      auditId, severity: ErrorSeverity.MANDATORY,
      publicMessage: `System audit error. Audit ID: ${auditId}`, cause,
    });
    this.name = 'LedgerWriteError';
  }
}

export class ValidationError extends GovernedError {
  constructor(field: string, reason: string, auditId: string) {
    super(`Validation failed for ${field}: ${reason}`, {
      code: 'VALIDATION_FAILED', layer: GiaLayer.MCP, maiLevel: MaiClassification.INFORMATIONAL,
      auditId, severity: ErrorSeverity.INFORMATIONAL,
      publicMessage: `Invalid input: ${reason}`,
    });
    this.name = 'ValidationError';
  }
}
