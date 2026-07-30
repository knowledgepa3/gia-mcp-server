/**
 * @module    mai-gate
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — gate decisions are MANDATORY governance events
 * @audit     true — every gate decision is recorded
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  MaiClassification, type IGateDecision, type IWebAuthnProof, GateStatus,
} from '../../shared/types.js';
import {
  ADVISORY_GATE_TIMEOUT_MS,
  MANDATORY_GATE_MAX_WAIT_MS,
  MANDATORY_GATE_SLA_WARNING_MS,
  MANDATORY_GATE_SLA_BREACH_MS,
} from '../../shared/constants.js';
import { generateGateId, utcNow } from '../../shared/utils.js';
import { GateRejectionError } from '../../shared/errors.js';
import { persistGateRequest, persistGateResolution, checkRemoteGateResolution, getAdvisoryTimeoutMs } from '../persistence/gate-persistence.js';
import { notifyGateCreated, notifyGateResolved, notifyGateExpired } from './webhook.js';

export type PasskeyEnforcement = 'off' | 'mandatory-only' | 'all';

export interface IGateConfig {
  autoRunMode: boolean;
  advisoryTimeoutMs: number;
  /**
   * Configurable timeout for MANDATORY gates in milliseconds.
   * If no human responds within this window, the gate auto-denies (fail-closed).
   * Default: MANDATORY_GATE_MAX_WAIT_MS (24 hours).
   * Set lower for tighter SLAs (e.g., 30 minutes for CI/CD pipelines).
   */
  mandatoryTimeoutMs: number;
  /** When true, MANDATORY gate approvals require WebAuthn proof. Default: false. */
  passkeyRequired: boolean;
  /**
   * MAI-driven passkey enforcement:
   * - 'off': no passkey required (backward compatible)
   * - 'mandatory-only': passkeys required ONLY for MANDATORY gates (recommended)
   * - 'all': passkeys required for ALL gate classifications
   * Default: 'off'. Overrides passkeyRequired when set to non-'off' value.
   */
  passkeyEnforcement: PasskeyEnforcement;
}

/**
 * Pending approval — tracks a MANDATORY gate awaiting human approval.
 * Includes SLA tracking and role-based ownership for escalation.
 */
interface IPendingApproval {
  gateId: string;
  classification: MaiClassification;
  operation: string;
  auditId: string;
  requestedAt: Date;
  /** Who should approve this gate (default: 'isso') */
  ownerRole: string;
  /** Escalation level: 0=normal, 1=warning, 2=breach */
  escalationLevel: number;
  resolve: (decision: IGateDecision) => void;
  reject: (error: Error) => void;
}

export class MaiGate {
  private config: IGateConfig;
  private pendingApprovals: Map<string, IPendingApproval> = new Map();

  constructor(config?: Partial<IGateConfig>) {
    this.config = {
      autoRunMode: false,
      advisoryTimeoutMs: config?.advisoryTimeoutMs ?? ADVISORY_GATE_TIMEOUT_MS,
      mandatoryTimeoutMs: config?.mandatoryTimeoutMs ?? MANDATORY_GATE_MAX_WAIT_MS,
      passkeyRequired: false,
      passkeyEnforcement: 'off',
      ...config,
    };
  }

  /**
   * Enforce gate based on MAI classification.
   *
   * MANDATORY: requires explicit human approval (or AUTO-RUN mode)
   * ADVISORY: pauses, auto-continues after timeout (or AUTO-RUN mode)
   * INFORMATIONAL: no gate — passes through
   *
   * @governance  Gate enforcement is the MAI Framework's teeth.
   * @ledger      Gate decision recorded by caller.
   * @failure     Throws GateRejectionError if gate is rejected.
   */
  async enforce(
    classification: MaiClassification,
    operation: string,
    auditId: string,
    ownerRole: string = 'isso'
  ): Promise<IGateDecision> {
    const gateId = generateGateId();

    // INFORMATIONAL — no gate needed
    if (classification === MaiClassification.INFORMATIONAL) {
      return {
        gateId, classification, status: GateStatus.APPROVED,
        approvedBy: 'AUTO', timestamp: utcNow(),
        rationale: 'INFORMATIONAL classification — no gate required.',
        autoRunMode: false,
      };
    }

    // AUTO-RUN mode — approve all gates with audit trail
    // SECURITY: autoRunMode is blocked in production to prevent MANDATORY gate bypass
    if (this.config.autoRunMode) {
      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction && classification === MaiClassification.MANDATORY) {
        // MANDATORY gates NEVER auto-approve in production — even with autoRunMode
        return {
          gateId, classification, status: GateStatus.PENDING,
          approvedBy: 'BLOCKED', timestamp: utcNow(),
          rationale: `AUTO-RUN mode blocked for MANDATORY gate in production. Human approval required for ${operation}.`,
          autoRunMode: true,
        };
      }
      return {
        gateId, classification, status: GateStatus.APPROVED,
        approvedBy: 'AUTO-RUN', timestamp: utcNow(),
        rationale: `AUTO-RUN mode active. ${classification} gate auto-approved for ${operation}.`,
        autoRunMode: true,
      };
    }

    // ADVISORY — pause + notify, auto-APPROVE after timeout (human can reject early)
    if (classification === MaiClassification.ADVISORY) {
      const timeoutMs = await getAdvisoryTimeoutMs(this.config.advisoryTimeoutMs);
      return new Promise<IGateDecision>((resolve, reject) => {
        const pending: IPendingApproval = {
          gateId, classification, operation, auditId,
          requestedAt: utcNow(),
          ownerRole,
          escalationLevel: 0,
          resolve, reject,
        };
        this.pendingApprovals.set(gateId, pending);

        persistGateRequest({
          gateId, classification, operation, auditId,
          requestedAt: pending.requestedAt,
          ownerRole,
          escalationLevel: 0,
        });

        const expiresAt = new Date(pending.requestedAt.getTime() + timeoutMs);
        notifyGateCreated({
          gateId, classification, operation, ownerRole,
          createdAt: pending.requestedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });

        // Poll for early human approval or rejection
        const POLL_INTERVAL_MS = 3_000;
        const pollTimer = setInterval(async () => {
          if (!this.pendingApprovals.has(gateId)) { clearInterval(pollTimer); return; }
          try {
            const remote = await checkRemoteGateResolution(gateId);
            if (!remote) return;
            clearInterval(pollTimer);
            if (!this.pendingApprovals.has(gateId)) return;
            this.pendingApprovals.delete(gateId);
            if (remote.status === 'APPROVED' || remote.status === 'BREAK_GLASS') {
              const decision: IGateDecision = {
                gateId, classification, status: GateStatus.APPROVED,
                approvedBy: remote.approvedBy, timestamp: utcNow(),
                rationale: remote.rationale, autoRunMode: false,
              };
              notifyGateResolved({ gateId, classification, operation, rationale: remote.rationale, resolvedBy: remote.approvedBy, resolvedAt: new Date().toISOString(), createdAt: pending.requestedAt.toISOString() }, 'APPROVED');
              resolve(decision);
            } else {
              notifyGateResolved({ gateId, classification, operation, rationale: remote.rationale, resolvedBy: remote.approvedBy, resolvedAt: new Date().toISOString(), createdAt: pending.requestedAt.toISOString() }, 'REJECTED');
              reject(new GateRejectionError(gateId, classification, auditId, remote.rationale));
            }
          } catch { /* poll failure non-fatal */ }
        }, POLL_INTERVAL_MS);

        // Timeout: auto-APPROVE (opposite of MANDATORY which auto-denies)
        setTimeout(() => {
          clearInterval(pollTimer);
          if (!this.pendingApprovals.has(gateId)) return;
          this.pendingApprovals.delete(gateId);
          const timeoutSec = Math.round(timeoutMs / 1000);
          const decision: IGateDecision = {
            gateId, classification, status: GateStatus.APPROVED,
            approvedBy: 'TIMEOUT', timestamp: utcNow(),
            rationale: `ADVISORY gate auto-approved after ${timeoutSec}s — no objection received for ${operation}.`,
            autoRunMode: false,
          };
          persistGateResolution({ gateId, status: 'APPROVED', approvedBy: 'TIMEOUT', rationale: decision.rationale });
          notifyGateResolved({ gateId, classification, operation, rationale: decision.rationale, resolvedBy: 'TIMEOUT', resolvedAt: decision.timestamp.toISOString(), createdAt: pending.requestedAt.toISOString() }, 'APPROVED');
          resolve(decision);
        }, timeoutMs);
      });
    }

    // MANDATORY - register pending approval and wait for human response.
    // The pipeline FREEZES here until a human signs off, break-glass overrides,
    // or the configurable timeout expires. Fail-closed: no response = auto-deny.
    const timeoutMs = this.config.mandatoryTimeoutMs;
    return new Promise<IGateDecision>((resolve, reject) => {
      const pending = {
        gateId, classification, operation, auditId,
        requestedAt: utcNow(),
        ownerRole,
        escalationLevel: 0,
        resolve, reject,
      };
      this.pendingApprovals.set(gateId, pending);

      // Write-through: persist gate request to PostgreSQL
      persistGateRequest({
        gateId, classification, operation, auditId,
        requestedAt: pending.requestedAt,
        ownerRole,
        escalationLevel: 0,
      });

      // Fire-and-forget: webhook notification for MANDATORY gate creation
      const expiresAt = new Date(pending.requestedAt.getTime() + timeoutMs);
      notifyGateCreated({
        gateId,
        classification,
        operation,
        ownerRole,
        createdAt: pending.requestedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      // ── Remote approval polling ─────────────────────────────────────
      // Poll PostgreSQL every 3s for approvals from remote channels
      // (ntfy action buttons, GIA console, mobile web).
      // This bridges the gap between remote HTTP approval and the
      // in-memory Promise that's blocking the pipeline.
      const POLL_INTERVAL_MS = 3_000;
      const pollTimer = setInterval(async () => {
        if (!this.pendingApprovals.has(gateId)) {
          clearInterval(pollTimer); // Already resolved locally
          return;
        }
        try {
          const remote = await checkRemoteGateResolution(gateId);
          if (!remote) return; // No decision yet

          // Remote decision found — resolve the in-memory Promise
          clearInterval(pollTimer);
          if (!this.pendingApprovals.has(gateId)) return; // Race guard

          this.pendingApprovals.delete(gateId);

          if (remote.status === 'APPROVED' || remote.status === 'BREAK_GLASS') {
            const decision: IGateDecision = {
              gateId,
              classification,
              status: GateStatus.APPROVED,
              approvedBy: remote.approvedBy,
              timestamp: utcNow(),
              rationale: remote.rationale,
              autoRunMode: false,
            };
            // Webhook notification for resolved gate
            notifyGateResolved({
              gateId,
              classification,
              operation,
              rationale: remote.rationale,
              resolvedBy: remote.approvedBy,
              resolvedAt: new Date().toISOString(),
              createdAt: pending.requestedAt.toISOString(),
            }, 'APPROVED');
            resolve(decision);
          } else {
            // REJECTED or TIMED_OUT from remote
            notifyGateResolved({
              gateId,
              classification,
              operation,
              rationale: remote.rationale,
              resolvedBy: remote.approvedBy,
              resolvedAt: new Date().toISOString(),
              createdAt: pending.requestedAt.toISOString(),
            }, 'REJECTED');
            reject(new GateRejectionError(
              gateId, classification, auditId, remote.rationale
            ));
          }
        } catch {
          // Poll failure is non-fatal — local approve_gate tool still works
        }
      }, POLL_INTERVAL_MS);

      // Timeout: if no approval/rejection within configured window, auto-deny (fail-closed).
      // SLA warning at 2h and breach at 8h are surfaced via getPendingApprovals() - real timestamps.
      setTimeout(() => {
        clearInterval(pollTimer); // Stop polling on timeout
        if (this.pendingApprovals.has(gateId)) {
          this.pendingApprovals.delete(gateId);
          const timeoutHours = Math.round(timeoutMs / 3600000 * 100) / 100;
          // Write-through: persist timeout resolution
          persistGateResolution({
            gateId,
            status: 'TIMED_OUT',
            approvedBy: 'TIMEOUT',
            rationale: `MANDATORY gate auto-denied (fail-closed) after ${timeoutHours}h for ${operation}. No human approval received.`,
          });
          // Fire-and-forget: webhook notification for gate expiration
          notifyGateExpired({
            gateId,
            classification: classification.toString(),
            operation,
            rationale: `Gate timed out after ${timeoutHours}h - no human approval received`,
            createdAt: pending.requestedAt.toISOString(),
            expiresAt: new Date(pending.requestedAt.getTime() + timeoutMs).toISOString(),
          });
          reject(new GateRejectionError(
            gateId, classification, auditId,
            `MANDATORY gate auto-denied (fail-closed) after ${timeoutHours}h for ${operation}. No human approval received.`
          ));
        }
      }, timeoutMs);
    });
  }

  /**
   * Submit an approval for a pending MANDATORY gate.
   * Returns true if the gate was found and approved, false if not found.
   *
   * @param webauthnProof  Optional cryptographic proof from WebAuthn passkey assertion.
   *                       Required when passkeyEnforcement demands it for the gate's classification.
   *
   * MAI-driven enforcement logic:
   *   'off'            → passkey never required (backward compatible)
   *   'mandatory-only' → passkey required ONLY for MANDATORY gates
   *   'all'            → passkey required for ALL gates
   *   passkeyRequired  → legacy flag, treated as 'all' when true
   */
  approve(gateId: string, approvedBy: string, rationale?: string, webauthnProof?: IWebAuthnProof): boolean {
    const pending = this.pendingApprovals.get(gateId);
    if (!pending) return false;

    // MAI-driven passkey enforcement
    const enforcement = this.config.passkeyEnforcement;
    const requiresPasskey = enforcement === 'all'
      || (enforcement === 'mandatory-only' && pending.classification === MaiClassification.MANDATORY)
      || this.config.passkeyRequired; // legacy flag

    if (requiresPasskey && !webauthnProof) {
      return false; // Caller should check and provide appropriate error message
    }

    this.pendingApprovals.delete(gateId);
    const decision: IGateDecision = {
      gateId,
      classification: pending.classification,
      status: GateStatus.APPROVED,
      approvedBy: webauthnProof ? webauthnProof.userId : approvedBy,
      timestamp: utcNow(),
      rationale: rationale ?? `MANDATORY gate approved by ${approvedBy}.`,
      autoRunMode: false,
      webauthnProof,
    };
    // Write-through: persist approval resolution
    persistGateResolution({
      gateId,
      status: 'APPROVED',
      approvedBy: decision.approvedBy,
      rationale: decision.rationale,
      decision,
    });
    // Fire-and-forget: webhook notification for gate approval
    notifyGateResolved({
      gateId,
      classification: pending.classification,
      operation: pending.operation,
      rationale: decision.rationale,
      resolvedBy: decision.approvedBy,
      resolvedAt: decision.timestamp.toISOString(),
      createdAt: pending.requestedAt.toISOString(),
    }, 'APPROVED');
    pending.resolve(decision);
    return true;
  }

  /**
   * Reject a pending MANDATORY gate.
   * Optionally accepts WebAuthn proof for identity verification on rejections.
   */
  reject(gateId: string, rejectedBy: string, rationale?: string, webauthnProof?: IWebAuthnProof): boolean {
    const pending = this.pendingApprovals.get(gateId);
    if (!pending) return false;

    const actualRejectedBy = webauthnProof ? webauthnProof.userId : rejectedBy;
    this.pendingApprovals.delete(gateId);
    const rejectionRationale = rationale ?? `MANDATORY gate rejected by ${actualRejectedBy}.`;
    // Write-through: persist rejection resolution
    persistGateResolution({
      gateId,
      status: 'REJECTED',
      approvedBy: actualRejectedBy,
      rationale: rejectionRationale,
    });
    // Fire-and-forget: webhook notification for gate rejection
    notifyGateResolved({
      gateId,
      classification: pending.classification,
      operation: pending.operation,
      rationale: rejectionRationale,
      resolvedBy: actualRejectedBy,
      resolvedAt: new Date().toISOString(),
      createdAt: pending.requestedAt.toISOString(),
    }, 'REJECTED');
    pending.reject(new GateRejectionError(
      gateId, pending.classification, pending.auditId,
      rejectionRationale
    ));
    return true;
  }

  /**
   * Emergency break-glass approval for a pending MANDATORY gate.
   * Resolves the gate with APPROVED status + BREAK-GLASS metadata — heavily audited.
   * Requires break-glass session ID for traceability and mandatory post-review.
   *
   * This is the "in case of emergency, break glass" path:
   * - Session ID ties to the Express break-glass system (activation, MFA, TTL, review)
   * - Every break-glass override is tagged in the audit trail
   * - Post-incident review is mandatory
   */
  breakGlassApprove(
    gateId: string,
    approvedBy: string,
    breakGlassSessionId: string,
    justification: string
  ): boolean {
    const pending = this.pendingApprovals.get(gateId);
    if (!pending) return false;

    this.pendingApprovals.delete(gateId);
    const breakGlassDecision: IGateDecision = {
      gateId,
      classification: pending.classification,
      status: GateStatus.APPROVED,
      approvedBy,
      timestamp: utcNow(),
      rationale: `BREAK-GLASS OVERRIDE by ${approvedBy}. Session: ${breakGlassSessionId}. Justification: ${justification}`,
      autoRunMode: false,
      breakGlass: {
        sessionId: breakGlassSessionId,
        approvedBy,
        justification,
        timestamp: utcNow().toISOString(),
      },
    };
    // Write-through: persist break-glass resolution (heavily audited)
    persistGateResolution({
      gateId,
      status: 'BREAK_GLASS',
      approvedBy,
      rationale: breakGlassDecision.rationale,
      decision: breakGlassDecision,
    });
    // Fire-and-forget: webhook notification for break-glass approval
    notifyGateResolved({
      gateId,
      classification: pending.classification,
      operation: pending.operation,
      rationale: breakGlassDecision.rationale,
      resolvedBy: approvedBy,
      resolvedAt: breakGlassDecision.timestamp.toISOString(),
      createdAt: pending.requestedAt.toISOString(),
    }, 'BREAK_GLASS');
    pending.resolve(breakGlassDecision);
    return true;
  }

  /**
   * List all pending approval requests with real-time SLA status.
   * SLA durations computed from Date.now() - requestedAt.getTime() — real timestamps, no Math.random().
   */
  getPendingApprovals(): Array<{
    gateId: string;
    operation: string;
    classification: MaiClassification;
    requestedAt: Date;
    ownerRole: string;
    sla: {
      elapsedMs: number;
      elapsedHuman: string;
      status: 'normal' | 'warning' | 'breach';
      remainingMs: number;
    };
  }> {
    const now = Date.now();
    return Array.from(this.pendingApprovals.values()).map(p => {
      const elapsed = now - p.requestedAt.getTime();
      const status: 'normal' | 'warning' | 'breach' =
        elapsed >= MANDATORY_GATE_SLA_BREACH_MS ? 'breach'
        : elapsed >= MANDATORY_GATE_SLA_WARNING_MS ? 'warning'
        : 'normal';
      const remaining = Math.max(0, this.config.mandatoryTimeoutMs - elapsed);
      const hours = Math.floor(elapsed / 3600000);
      const mins = Math.floor((elapsed % 3600000) / 60000);

      return {
        gateId: p.gateId,
        operation: p.operation,
        classification: p.classification,
        requestedAt: p.requestedAt,
        ownerRole: p.ownerRole,
        sla: {
          elapsedMs: elapsed,
          elapsedHuman: `${hours}h ${mins}m`,
          status,
          remainingMs: remaining,
        },
      };
    });
  }

  /**
   * Enable or disable auto-run mode.
   * Auto-run does NOT eliminate classification — only changes gate behavior.
   */
  setAutoRunMode(enabled: boolean): void {
    this.config.autoRunMode = enabled;
  }

  get isAutoRunMode(): boolean {
    return this.config.autoRunMode;
  }

  /**
   * Set MAI-driven passkey enforcement level.
   * 'off': backward compatible, no passkey needed.
   * 'mandatory-only': MANDATORY gates require passkey proof (recommended).
   * 'all': all gates require passkey proof.
   */
  setPasskeyEnforcement(level: PasskeyEnforcement): void {
    this.config.passkeyEnforcement = level;
  }

  get passkeyEnforcement(): PasskeyEnforcement {
    return this.config.passkeyEnforcement;
  }

  /**
   * Check if a given classification level requires passkey proof
   * under the current enforcement configuration.
   */
  requiresPasskey(classification: MaiClassification): boolean {
    const enforcement = this.config.passkeyEnforcement;
    return enforcement === 'all'
      || (enforcement === 'mandatory-only' && classification === MaiClassification.MANDATORY)
      || this.config.passkeyRequired;
  }
}
