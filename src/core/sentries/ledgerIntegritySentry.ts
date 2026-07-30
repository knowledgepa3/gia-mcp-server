/**
 * @module    ledger-integrity-sentry
 * @layer     CORE
 * @inherits  ROOT
 * @mai       M — chain-break detection triggers MANDATORY gate
 * @audit     true — every check result (broken or intact) is recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * LEDGER INTEGRITY SENTRY
 *
 * Two-tier cryptographic chain verification:
 *   • Incremental (60 s)  — verifyChain() from last checkpoint; writes
 *     LEDGER_INTEGRITY_BROKEN only when a break is detected.
 *   • Full (24 h)         — verifyChainFull() from genesis; writes
 *     LEDGER_INTEGRITY_CHECK (INTACT) on clean or LEDGER_INTEGRITY_BROKEN on break.
 *
 * Score sentinel invariant: sentries do NOT score work quality.
 * All ledger entries carry scored=false / -1 sentinel values.
 *
 * GATE_HOLD deduplication: if a MANDATORY gate for LEDGER_INTEGRITY_BROKEN
 * is already pending, a second gate is NOT fired — preventing alert storms
 * during a persistent chain break.
 */

import { MaiClassification, GiaLayer } from '../../shared/types.js';
import type { IGovernanceScore, IMaiResult, IScoreWeights } from '../../shared/types.js';
import type { GovernanceEngine } from '../governance.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SENTRY_ACTOR = 'system:ledger-integrity';
const INCREMENTAL_INTERVAL_MS = 60_000;           // 60 seconds
const FULL_INTERVAL_MS = 24 * 60 * 60_000;        // 24 hours

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Sentinel score used for all sentry ledger entries.
 *
 * CRITICAL: scored=false / all fields -1.  Sentries record governance
 * events, not scored work output.  Using scored=true/1.0 would fabricate
 * a passing quality score on every sentry tick.
 */
function sentryScore(): IGovernanceScore {
  const w: IScoreWeights = { integrity: 1 / 3, accuracy: 1 / 3, compliance: 1 / 3 };
  return {
    integrity: -1,
    accuracy: -1,
    compliance: -1,
    composite: -1,
    weights: w,
    timestamp: new Date(),
    scoredBy: 'system:ledger-integrity-sentry-not-scored',
    scored: false,
  };
}

function sentryClassification(level: MaiClassification): IMaiResult {
  return {
    classification: level,
    confidence: 1.0,
    rationale: 'Ledger integrity sentry check',
    requiresGate: level === MaiClassification.MANDATORY,
  };
}

// ─── Sentry class ─────────────────────────────────────────────────────────────

export class LedgerIntegritySentry {
  private incrementalTimer: ReturnType<typeof setInterval> | null = null;
  private fullTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly engine: GovernanceEngine) {}

  /**
   * Start the two-tier cron.
   *
   * Both timers are set and both checks are run immediately (on the next
   * event-loop tick via void — callers that need to await startup should
   * await runIncremental() + runFull() directly).
   */
  start(): void {
    this.incrementalTimer = setInterval(() => { void this.runIncremental(); }, INCREMENTAL_INTERVAL_MS);
    this.fullTimer = setInterval(() => { void this.runFull(); }, FULL_INTERVAL_MS);
    void this.runIncremental();
    void this.runFull();
  }

  /**
   * Stop both timers and clear their handles.
   */
  stop(): void {
    if (this.incrementalTimer !== null) {
      clearInterval(this.incrementalTimer);
      this.incrementalTimer = null;
    }
    if (this.fullTimer !== null) {
      clearInterval(this.fullTimer);
      this.fullTimer = null;
    }
  }

  /**
   * Incremental chain verification (60 s cadence).
   *
   * Calls engine.ledger.verifyChain() which walks from the last checkpoint.
   * Writes to the ledger ONLY when a break is detected.  Clean passes are
   * silent to avoid polluting the audit trail with noise.
   */
  async runIncremental(): Promise<void> {
    try {
      const result = this.engine.ledger.verifyChain();
      if (!result.valid) {
        await this.writeBrokenEntry(result);
      }
      // Clean incremental pass: write nothing (intentional)
    } catch (err) {
      await this.writeSentryError(err);
    }
  }

  /**
   * Full chain verification (24 h cadence).
   *
   * Calls engine.ledger.verifyChainFull() which walks the entire chain from
   * genesis.  Writes LEDGER_INTEGRITY_CHECK (INTACT) on success, or
   * LEDGER_INTEGRITY_BROKEN on failure.
   */
  async runFull(): Promise<void> {
    try {
      const result = this.engine.ledger.verifyChainFull();
      if (!result.valid) {
        await this.writeBrokenEntry(result);
      } else {
        await this.writeIntactEntry(result.entriesVerified, result.verificationDurationMs, result.legacyLinkageBreaks ?? 0);
      }
    } catch (err) {
      await this.writeSentryError(err);
    }
  }

  // ─── Private writers ───────────────────────────────────────────────────────

  private async writeBrokenEntry(result: {
    firstBrokenLink: number;
    headHash: string;
    verificationDurationMs: number;
    breakDetail?: string;
  }): Promise<void> {
    const builder = this.engine.ledger.begin(
      'LEDGER_INTEGRITY_BROKEN',
      MaiClassification.MANDATORY,
      GiaLayer.CORE,
      SENTRY_ACTOR
    );
    builder.addMetadata('firstBrokenLink', result.firstBrokenLink);
    builder.addMetadata('chainHead', result.headHash);
    builder.addMetadata('verificationDurationMs', result.verificationDurationMs);
    if (result.breakDetail) {
      builder.addMetadata('breakDetail', result.breakDetail);
    }
    const entry = builder.complete(
      sentryScore(),
      sentryClassification(MaiClassification.MANDATORY)
    );
    this.engine.ledger.record(entry);

    // GATE_HOLD deduplication — avoid duplicate MANDATORY gates for a
    // persistent chain break (each 60 s tick would otherwise queue a new gate).
    const pending = this.engine.gate.getPendingApprovals();
    const alreadyPending = pending.some((g) => g.operation === 'LEDGER_INTEGRITY_BROKEN');
    if (!alreadyPending) {
      void this.engine.gate.enforce(
        MaiClassification.MANDATORY,
        'LEDGER_INTEGRITY_BROKEN',
        `ledger-integrity-${result.firstBrokenLink}-${Date.now()}`
      );
    }
  }

  private async writeIntactEntry(
    entriesVerified: number,
    durationMs: number,
    legacyLinkageBreaks: number = 0
  ): Promise<void> {
    const builder = this.engine.ledger.begin(
      'LEDGER_INTEGRITY_CHECK',
      MaiClassification.INFORMATIONAL,
      GiaLayer.CORE,
      SENTRY_ACTOR
    );
    builder.addMetadata('entriesVerified', entriesVerified);
    builder.addMetadata('verificationDurationMs', durationMs);
    builder.addMetadata('result', 'INTACT');
    // Honest record: known legacy linkage breaks (pre-2026-07-01 rewrite-loop
    // damage, immutable) are documented on every full check — INTACT means
    // "no NEW breaks", never "the legacy damage disappeared".
    builder.addMetadata('legacyLinkageBreaks', legacyLinkageBreaks);
    const entry = builder.complete(
      sentryScore(),
      sentryClassification(MaiClassification.INFORMATIONAL)
    );
    this.engine.ledger.record(entry);
  }

  /**
   * Last-resort error writer.  If the sentry itself throws, we still record
   * the failure so the audit trail reflects that verification did NOT complete.
   *
   * If even the error write fails (e.g. ledger is corrupt), we fall back to
   * console.error — we must not throw from a sentry.
   */
  private async writeSentryError(err: unknown): Promise<void> {
    try {
      const builder = this.engine.ledger.begin(
        'SENTRY_ERROR',
        MaiClassification.ADVISORY,
        GiaLayer.CORE,
        SENTRY_ACTOR
      );
      builder.addMetadata('sentry', 'ledger-integrity');
      builder.addMetadata('error', err instanceof Error ? err.message : String(err));
      builder.addMetadata('note', 'Verification did not complete — treat as UNCERTAIN');
      const entry = builder.complete(
        sentryScore(),
        sentryClassification(MaiClassification.ADVISORY)
      );
      this.engine.ledger.record(entry);
    } catch (writeErr) {
      console.error(
        '[ledger-integrity-sentry] CRITICAL: cannot write sentry error to ledger',
        writeErr
      );
    }
  }
}
