/**
 * @module    governance-root
 * @layer     GOVERNANCE
 * @inherits  ROOT — this IS the root. Everything traces back here.
 * @mai       M — governance operations are MANDATORY
 * @audit     true — every governed operation is audited
 * @owner     William J. Storey III / ACE / GIA
 *
 * THE GOVERNANCE ROOT
 *
 * This is the most important class in the GIA ecosystem.
 * Every module, every service, every agent MUST inherit from GovernanceRoot.
 * If you trace any module's inheritance chain upward and it does not
 * terminate here, the code is broken.
 *
 * GovernanceRoot provides:
 * - ForensicLedger: immutable audit log
 * - MaiClassifier: decision classification engine
 * - MaiGate: gate enforcement
 * - GovernanceScorer: output quality scoring
 * - StoreyThresholdMonitor: escalation rate health metric
 * - Supervisor: agent monitoring and repair
 *
 * The govern() method is the single entry point for ALL governed operations.
 * No agent action executes outside govern(). No exception.
 */

import { createHash } from 'crypto';
import {
  MaiClassification,
  type IGovernedResult,
  type IGovernanceScore,
  type IMaiResult,
  type IGateDecision,
  GiaLayer,
  EntryStatus,
} from '../shared/types.js';
import { GovernedError } from '../shared/errors.js';
import { generateAuditId, utcNow } from '../shared/utils.js';
import {
  GIA_VERSION, GIA_SERVER_NAME, GENESIS_HASH, CHAIN_VERSION,
  STOREY_THRESHOLD_MIN, STOREY_THRESHOLD_MAX,
  STOREY_THRESHOLD_CRITICAL_LOW, STOREY_THRESHOLD_CRITICAL_HIGH,
  STOREY_THRESHOLD_WINDOW_SIZE, DEFAULT_SCORE_WEIGHTS,
} from '../shared/constants.js';

/**
 * Compute a deterministic SHA-256 fingerprint of the kernel governance config.
 *
 * This hash covers the full set of governance invariants that are locked at
 * boot: version, threshold bounds, scoring weights, genesis anchor, chain
 * version, and runtime environment. Any change to the governed law — even a
 * threshold calibration — produces a different fingerprint, making silent
 * policy drift detectable in every ledger entry and runtime session record.
 *
 * @returns  64-char lowercase hex SHA-256 string
 */
function computeKernelConfigFingerprint(): string {
  const config = {
    giaVersion: GIA_VERSION,
    giaServerName: GIA_SERVER_NAME,
    genesisHash: GENESIS_HASH,
    chainVersion: CHAIN_VERSION,
    thresholdMin: STOREY_THRESHOLD_MIN,
    thresholdMax: STOREY_THRESHOLD_MAX,
    thresholdCriticalLow: STOREY_THRESHOLD_CRITICAL_LOW,
    thresholdCriticalHigh: STOREY_THRESHOLD_CRITICAL_HIGH,
    thresholdWindowSize: STOREY_THRESHOLD_WINDOW_SIZE,
    scoreWeights: DEFAULT_SCORE_WEIGHTS,
    environment: process.env['NODE_ENV'] ?? process.env['GIA_ENVIRONMENT'] ?? 'production',
  };
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

import { ForensicLedger, type AuditEntryBuilder } from './audit/ledger.js';
import { TelemetryCollector } from './audit/telemetry.js';
import { MaiClassifier } from './mai/classifier.js';
import { MaiGate } from './mai/gate.js';
import { type IClassificationContext } from './mai/types.js';
import { GovernanceScorer, type IScoringCriteria } from './scoring/scorer.js';
import { StoreyThresholdMonitor } from './threshold/monitor.js';
import { ThresholdHealthAssessor } from './threshold/health.js';
import { Supervisor } from './supervisor/supervisor.js';

// Persistence layers — write-through to PostgreSQL
import { initGMPPersistence, closeGMPPersistence } from './persistence/gmp-persistence.js';
import { initSRTPersistence, closeSRTPersistence } from './persistence/srt-persistence.js';
import { initGatePersistence, cleanupStaleGates, closeGatePersistence } from './persistence/gate-persistence.js';
import { initIntelligencePersistence, closeIntelligencePersistence } from './persistence/intelligence-persistence.js';
import { initTelemetryPersistence, closeTelemetryPersistence } from './persistence/telemetry-persistence.js';
import { initRuntimePersistence, closeRuntimePersistence } from './persistence/runtime-persistence.js';
import { GovernanceTelemetryService } from './telemetry/governance-telemetry-service.js';
import { RuntimeAccountabilityService } from './telemetry/runtime-accountability-service.js';
import type { GovernedSampling } from './sampling/governed-sampling.js';

/**
 * GovernanceRoot — the abstract base class for all governed components.
 *
 * Every governed operation follows this flow:
 * 1. Begin audit entry (forensic ledger)
 * 2. Classify the decision (MAI)
 * 3. Enforce gate if required (MAI gate)
 * 4. Execute the governed operation
 * 5. Score the output (governance scorer)
 * 6. Evaluate supervisor decision
 * 7. Record threshold data (Storey Threshold)
 * 8. Complete audit entry
 * 9. Return GovernedResult with full governance context
 */
export abstract class GovernanceRoot {
  protected readonly ledger: ForensicLedger;
  protected readonly classifier: MaiClassifier;
  protected readonly gate: MaiGate;
  protected readonly scorer: GovernanceScorer;
  protected readonly thresholdMonitor: StoreyThresholdMonitor;
  protected readonly healthAssessor: ThresholdHealthAssessor;
  protected readonly supervisor: Supervisor;
  protected readonly telemetry: TelemetryCollector;

  constructor(engine: GovernanceEngine) {
    this.ledger = engine.ledger;
    this.classifier = engine.classifier;
    this.gate = engine.gate;
    this.scorer = engine.scorer;
    this.thresholdMonitor = engine.thresholdMonitor;
    this.healthAssessor = engine.healthAssessor;
    this.supervisor = engine.supervisor;
    this.telemetry = engine.telemetry;
  }

  /**
   * THE governed operation wrapper.
   *
   * Every AI agent action in the GIA ecosystem passes through this method.
   * It is the single choke point for governance enforcement.
   *
   * @param operation   Name of the operation being performed
   * @param maiLevel    Base MAI classification level
   * @param context     Classification context (for elevation rules)
   * @param execute     The actual operation to execute (domain logic)
   * @param scoreFn     Optional custom scoring function
   * @returns           GovernedResult with full governance context
   */
  protected async govern<T>(
    operation: string,
    maiLevel: MaiClassification,
    context: IClassificationContext,
    execute: () => Promise<T>,
    scoreFn?: (result: T) => IScoringCriteria
  ): Promise<IGovernedResult<T>> {
    // 1. Begin audit entry (with cross-ledger correlation ID if provided)
    const entry = this.ledger.begin(operation, maiLevel, GiaLayer.CORE, context.agentName ?? 'SYSTEM', undefined, context.correlationId);

    try {
      // 2. Classify the decision
      const classification = this.classifier.classify(operation, maiLevel, context);
      entry.addMetadata('maiClassification', classification.classification);
      entry.addMetadata('maiConfidence', classification.confidence);

      // 3. Enforce gate if required
      let gateDecision: IGateDecision | undefined;
      if (classification.requiresGate) {
        gateDecision = await this.gate.enforce(classification.classification, operation, entry.id);
        entry.addMetadata('gateDecision', gateDecision.status);
      }

      // 4. Execute the governed operation
      const result = await execute();

      // 5. Score the output
      const criteria = scoreFn ? scoreFn(result) : { integrity: 0.85, accuracy: 0.85, compliance: 0.85 };
      const score = this.scorer.score(criteria, operation, entry.id);

      // 6. Evaluate supervisor decision
      this.supervisor.evaluate(context.agentName ?? operation, score, EntryStatus.COMPLETED, entry.id);

      // 7. Record to threshold monitor
      this.thresholdMonitor.record(classification);

      // 8. Complete audit entry
      const completedEntry = entry.complete(score, classification, gateDecision);
      this.ledger.record(completedEntry);

      // 9. Return governed result
      return {
        result,
        score,
        classification,
        auditId: entry.id,
        gateDecision,
        timestamp: utcNow(),
      };
    } catch (error) {
      // Record failure to forensic ledger
      const failedEntry = entry.fail(
        error instanceof Error ? error : new Error(String(error)),
        maiLevel
      );
      this.ledger.record(failedEntry);

      // Re-throw as GovernedError if not already
      if (error instanceof GovernedError) throw error;

      throw new GovernedError(
        `Governed operation '${operation}' failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'GOVERNED_OPERATION_FAILED',
          layer: GiaLayer.CORE,
          maiLevel,
          auditId: entry.id,
          severity: maiLevel === MaiClassification.MANDATORY ? 'MANDATORY' as any : 'ADVISORY' as any,
          publicMessage: `Operation failed. Audit ID: ${entry.id}`,
          cause: error instanceof Error ? error : undefined,
        }
      );
    }
  }
}

/**
 * GovernanceEngine — the initialized governance system.
 *
 * Created once at server startup. Passed to all GovernanceRoot subclasses.
 * Encapsulates all governance components as a single injectable unit.
 */
export class GovernanceEngine {
  public readonly ledger: ForensicLedger;
  public readonly classifier: MaiClassifier;
  public readonly gate: MaiGate;
  public readonly scorer: GovernanceScorer;
  public readonly thresholdMonitor: StoreyThresholdMonitor;
  public readonly healthAssessor: ThresholdHealthAssessor;
  public readonly supervisor: Supervisor;
  public readonly telemetry: TelemetryCollector;
  public readonly telemetryService: GovernanceTelemetryService;
  public readonly runtimeService: RuntimeAccountabilityService;
  public readonly startedAt: Date;

  // Governed Sampling — initialized after MCP server creation (needs Server ref)
  private _sampling: GovernedSampling | null = null;

  private initialized = false;

  constructor() {
    this.ledger = new ForensicLedger();
    this.classifier = new MaiClassifier();
    this.gate = new MaiGate();
    this.scorer = new GovernanceScorer();
    this.thresholdMonitor = new StoreyThresholdMonitor();
    this.healthAssessor = new ThresholdHealthAssessor(this.thresholdMonitor);
    this.supervisor = new Supervisor(this.ledger);
    this.telemetryService = new GovernanceTelemetryService();
    this.runtimeService = new RuntimeAccountabilityService(computeKernelConfigFingerprint());
    this.telemetry = new TelemetryCollector(this.ledger);
    this.telemetry.setTelemetryService(this.telemetryService);
    this.startedAt = utcNow();
  }

  // ─── Governed Sampling ─────────────────────────────────────────────────

  /** Get the GovernedSampling service. Throws if not initialized (client doesn't support sampling). */
  get sampling(): GovernedSampling {
    if (!this._sampling) {
      throw new Error('GovernedSampling not initialized. Sampling requires a connected MCP client that supports the sampling capability.');
    }
    return this._sampling;
  }

  /** Set the GovernedSampling service. Called from server.ts after McpServer is created. */
  setSampling(s: GovernedSampling): void {
    this._sampling = s;
  }

  /** Check if sampling is available without throwing. */
  hasSampling(): boolean {
    return this._sampling !== null;
  }

  /**
   * Initialize the governance engine.
   * MUST be called before any governed operations execute.
   * If initialization fails, the server does NOT start.
   *
   * Recovery flow:
   * 1. Initialize PostgreSQL persistence (if DATABASE_URL set)
   * 2. Recover ledger entries from database
   * 3. Validate governance components
   * 4. Log initialization to ledger (persisted to both memory + DB)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new Error('GovernanceEngine already initialized. Double initialization is a governance violation.');
    }

    // Step 1-2: Initialize persistence + recover from PostgreSQL
    const { recovered, persisted } = await this.ledger.initPersistence();
    if (persisted) {
      console.error(`[GovernanceEngine] Persistence active — recovered ${recovered} ledger entries`);
    } else {
      console.error('[GovernanceEngine] Running in-memory only (no DATABASE_URL)');
    }

    // Step 2b: Initialize GMP, SRT, gate, and intelligence persistence layers
    // These are independent of the ledger and connect their own pools.
    // Failures are non-fatal — each falls back to in-memory only.
    const [gmpPersisted, srtPersisted, gatePersisted, intelPersisted, telemetryPersisted, runtimePersisted] = await Promise.all([
      initGMPPersistence(),
      initSRTPersistence(),
      initGatePersistence(),
      initIntelligencePersistence(),
      initTelemetryPersistence(),
      initRuntimePersistence(),
    ]);
    if (gmpPersisted || srtPersisted || gatePersisted || intelPersisted || telemetryPersisted || runtimePersisted) {
      console.error(`[GovernanceEngine] Persistence layers: GMP=${gmpPersisted}, SRT=${srtPersisted}, Gate=${gatePersisted}, Intel=${intelPersisted}, Telemetry=${telemetryPersisted}, Runtime=${runtimePersisted}`);
    }
    // Clean up stale pending gates from any previous crashed session
    if (gatePersisted) {
      await cleanupStaleGates();
    }

    // Verify all components are healthy
    this.validateComponents();

    // Log initialization to forensic ledger (now persisted!)
    const entry = this.ledger.begin('governance-engine-init', MaiClassification.MANDATORY);
    const score = this.scorer.scoreDefault('governance-engine-init');
    const completedEntry = entry.complete(score, {
      classification: MaiClassification.MANDATORY,
      confidence: 1.0,
      rationale: `Governance engine initialized. Persistence: ${persisted ? 'PostgreSQL' : 'in-memory'}. Recovered: ${recovered} entries.`,
      requiresGate: false,
    });
    this.ledger.record(completedEntry);

    // Kernel boot manifest — proves which institutional law was loaded at start.
    // Every agent session that inherits this runtime can trace back to this entry.
    // configFingerprint is the cryptographic anchor: change any governance constant
    // and a new fingerprint is produced, making silent policy drift visible.
    const manifestEntry = this.ledger.begin('kernel-boot-manifest', MaiClassification.MANDATORY);
    const instanceCtx = this.runtimeService.getInstanceContext();
    manifestEntry.addMetadata('configFingerprint', instanceCtx.configFingerprint);
    manifestEntry.addMetadata('instanceId', instanceCtx.instanceId);
    manifestEntry.addMetadata('environment', instanceCtx.environment);
    manifestEntry.addMetadata('giaVersion', GIA_VERSION);
    manifestEntry.addMetadata('giaServerName', GIA_SERVER_NAME);
    manifestEntry.addMetadata('thresholdBounds', {
      min: STOREY_THRESHOLD_MIN,
      max: STOREY_THRESHOLD_MAX,
      criticalLow: STOREY_THRESHOLD_CRITICAL_LOW,
      criticalHigh: STOREY_THRESHOLD_CRITICAL_HIGH,
      windowSize: STOREY_THRESHOLD_WINDOW_SIZE,
    });
    manifestEntry.addMetadata('scoreWeights', DEFAULT_SCORE_WEIGHTS);
    manifestEntry.addMetadata('genesisHash', GENESIS_HASH);
    manifestEntry.addMetadata('chainVersion', CHAIN_VERSION);
    manifestEntry.addMetadata('persistenceMode', persisted ? 'postgresql' : 'in-memory');
    manifestEntry.addMetadata('ledgerEntriesRecovered', recovered);
    const manifestScore = this.scorer.scoreDefault('kernel-boot-manifest');
    const completedManifest = manifestEntry.complete(manifestScore, {
      classification: MaiClassification.MANDATORY,
      confidence: 1.0,
      rationale: `Kernel boot manifest. Config fingerprint: ${instanceCtx.configFingerprint.slice(0, 16)}… Agent sessions inheriting this runtime are governed by the loaded institutional law.`,
      requiresGate: false,
    });
    this.ledger.record(completedManifest);

    this.initialized = true;

    // Seed threshold monitor from recovered ledger entries so it doesn't
    // show INSUFFICIENT_DATA after every restart. Only completed entries
    // with a maiLevel are useful — they represent real governance decisions.
    //
    // CRITICAL: pass each entry's ORIGINAL timestamp to record(). Without it,
    // every recovered entry would be stamped with the recovery instant, the
    // window's wall-clock span would collapse to zero, and `getReading()`
    // would either return a bogus rate or — after the time-confidence floor
    // shipped in `monitor.ts` — return INSUFFICIENT_DATA. Either way, the
    // health signal is wrong. Preserving original timestamps fixes both.
    const completedEntries = this.ledger.queryCompleted();
    let seeded = 0;
    for (const entry of completedEntries) {
      if (entry.maiLevel) {
        this.thresholdMonitor.record({
          classification: entry.maiLevel,
          confidence: 1.0,
          rationale: `Seeded from ledger entry ${entry.id}`,
          requiresGate: entry.maiLevel === MaiClassification.MANDATORY,
        }, entry.timestamp);
        seeded++;
      }
    }
    if (seeded > 0) {
      console.error(`[GovernanceEngine] Seeded threshold monitor with ${seeded} historical classifications (original timestamps preserved)`);
    }
  }

  /**
   * Check if engine is initialized and healthy.
   */
  isHealthy(): boolean {
    return this.initialized;
  }

  /**
   * Get full system status.
   */
  getStatus(): Record<string, unknown> {
    return {
      initialized: this.initialized,
      startedAt: this.startedAt.toISOString(),
      uptime: Date.now() - this.startedAt.getTime(),
      ledgerSize: this.ledger.size,
      ledgerChainHead: this.ledger.chainHead,
      ledgerUniqueOperations: this.ledger.uniqueOperations,
      thresholdHealth: this.healthAssessor.assess(),
      telemetry: this.telemetry.snapshot(),
      runtime: this.runtimeService.getInstanceContext(),
      autoRunMode: this.gate.isAutoRunMode,
    };
  }

  /**
   * Enable auto-run mode (all gates auto-approved).
   * Requires ISSO/system owner authorization.
   */
  enableAutoRun(): void {
    this.gate.setAutoRunMode(true);
    const entry = this.ledger.begin('auto-run-enabled', MaiClassification.MANDATORY);
    entry.addMetadata('autoRunMode', true);
    const score = this.scorer.scoreDefault('auto-run-enabled');
    const completedEntry = entry.complete(score, {
      classification: MaiClassification.MANDATORY,
      confidence: 1.0,
      rationale: 'Auto-run mode enabled by system owner.',
      requiresGate: false,
    });
    this.ledger.record(completedEntry);
  }

  /**
   * Disable auto-run mode (return to normal gate enforcement).
   */
  disableAutoRun(): void {
    this.gate.setAutoRunMode(false);
    const entry = this.ledger.begin('auto-run-disabled', MaiClassification.MANDATORY);
    entry.addMetadata('autoRunMode', false);
    const score = this.scorer.scoreDefault('auto-run-disabled');
    const completedEntry = entry.complete(score, {
      classification: MaiClassification.MANDATORY,
      confidence: 1.0,
      rationale: 'Auto-run mode disabled. Gate enforcement restored.',
      requiresGate: false,
    });
    this.ledger.record(completedEntry);
  }

  /**
   * Gracefully shut down all persistence pools.
   * Called during server shutdown to avoid connection leaks.
   */
  async shutdown(): Promise<void> {
    console.error('[GovernanceEngine] Shutting down persistence pools...');
    await Promise.allSettled([
      this.ledger.closePersistence(),
      closeGMPPersistence(),
      closeSRTPersistence(),
      closeGatePersistence(),
      closeIntelligencePersistence(),
      closeTelemetryPersistence(),
      closeRuntimePersistence(),
    ]);
    console.error('[GovernanceEngine] All persistence pools closed');
  }

  private validateComponents(): void {
    if (!this.ledger) throw new Error('ForensicLedger not initialized');
    if (!this.classifier) throw new Error('MaiClassifier not initialized');
    if (!this.gate) throw new Error('MaiGate not initialized');
    if (!this.scorer) throw new Error('GovernanceScorer not initialized');
    if (!this.thresholdMonitor) throw new Error('StoreyThresholdMonitor not initialized');
    if (!this.supervisor) throw new Error('Supervisor not initialized');
  }
}
