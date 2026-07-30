/**
 * @module    routing-monitor
 * @layer     GOVERNANCE
 * @inherits  GovernanceRoot (sibling to StoreyThresholdMonitor in core/threshold)
 * @mai       A — health reports are Advisory; CRITICAL status elevates to Mandatory
 * @audit     true — every health assessment writes to the ForensicLedger
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  IRoutingObservation,
  IRoutingMetric,
  IRoutingHealthReport,
  IRoutingBandConfig,
  RoutingBandStatus,
  RoutingOutcome,
  ModelTier,
} from './routing-types.js';
import { ForensicLedger } from '../audit/ledger.js';
import { GovernanceScorer } from '../scoring/scorer.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';

/** Per-MTok pricing for leakage math. Pinned in config, reviewed monthly. */
export interface ITierPricing {
  [model: string]: { input: number; output: number };
}

/**
 * ModelRoutingThresholdMonitor
 *
 * What it does: extends the Storey Threshold pattern from escalation health
 * to routing health. Observes completed model requests at the egress proxy
 * chokepoint (never agent self-reports) and assesses four bands:
 * fallback rate, cache hit rate, batch utilization, premium leakage.
 *
 * Governance layer: core/threshold. Feeds the same alert path as the
 * escalation monitor.
 *
 * Observation feed: the egress chokepoint for GIA model calls is the
 * server-side LLM kernel (a separate container). The kernel writes one
 * routing_observations row per completed request to the shared PostgreSQL;
 * the engine hydrates this monitor from those rows before each assessment.
 * In-process record() remains for direct feeds and tests.
 *
 * Ledger writes: one entry per assessHealth() call, containing the full
 * report. CRITICAL reports are written at Mandatory classification with
 * requiresGate=true (Rule 2: context elevates, never reduces).
 *
 * Failure path: assessment errors are governance-aware. A monitor that
 * cannot assess does not return HEALTHY; it records the failure to the
 * ledger and throws. The supervisor treats monitoring loss as an
 * Advisory error (alert + repair attempt).
 */
export class ModelRoutingThresholdMonitor {
  private observations: IRoutingObservation[] = [];
  private readonly seenRequestIds = new Set<string>();
  private lastHeartbeat: Date | null = null;

  constructor(
    private readonly config: IRoutingBandConfig,
    private readonly pricing: ITierPricing,
    private readonly ledger: ForensicLedger,
    private readonly scorer: GovernanceScorer,
  ) {}

  /** Record one completed request. Called by the egress feed, not by agents. */
  record(obs: IRoutingObservation): void {
    if (obs.inputTokens < 0 || obs.outputTokens < 0 || obs.cacheReadTokens < 0) {
      throw new Error(`GovernedError[routing-monitor]: negative token counts on ${obs.requestId}`);
    }
    if (this.seenRequestIds.has(obs.requestId)) return; // idempotent across hydrations
    this.seenRequestIds.add(obs.requestId);

    // Any observed SAFEGUARD_FALLBACK detection proves the detector fires —
    // that IS the heartbeat. Canaries exist to force this proof on schedule.
    if (obs.outcome === RoutingOutcome.SAFEGUARD_FALLBACK) {
      this.recordDetectorHeartbeat(obs.timestamp);
    }

    // Canaries are synthetic control probes: heartbeat-only, never band data.
    if (obs.canary) return;

    this.observations.push(obs);
  }

  /** Bulk-load observations (e.g. hydrated from the shared DB). Idempotent. */
  hydrate(batch: IRoutingObservation[]): void {
    for (const obs of batch) this.record(obs);
  }

  /**
   * Instrumentation heartbeat: the fallback detector proves it is alive by
   * processing a synthetic safeguarded-domain canary on a schedule. If the
   * canary does not trip the detector, fallback metrics are UNVERIFIED.
   * This is the control-efficacy harness principle applied to the monitor
   * itself: a control that has never been observed firing is unproven.
   */
  recordDetectorHeartbeat(at: Date): void {
    if (this.lastHeartbeat === null || at > this.lastHeartbeat) {
      this.lastHeartbeat = at;
    }
  }

  /** Assess all bands over a window. Writes the report to the ledger. */
  assessHealth(windowStart: Date, windowEnd: Date): IRoutingHealthReport {
    const entry = this.ledger.begin(
      'routing-threshold-assessment',
      MaiClassification.ADVISORY,
      GiaLayer.CORE,
      'routing-monitor',
    );
    try {
      const window = this.observations.filter(
        (o) => o.timestamp >= windowStart && o.timestamp <= windowEnd,
      );

      const fallbackRate = this.assessFallback(window, windowEnd);
      const cacheHitRate = this.assessCacheHit(window);
      const batchUtilization = this.assessBatchUtilization(window);
      const premiumLeakage = this.assessPremiumLeakage(window);

      const overallStatus = this.worstOf([
        fallbackRate.status,
        cacheHitRate.status,
        batchUtilization.status,
        premiumLeakage.status,
      ]);

      const report: IRoutingHealthReport = {
        windowStart,
        windowEnd,
        totalObservations: window.length,
        fallbackRate,
        cacheHitRate,
        batchUtilization,
        premiumLeakage,
        overallStatus,
        auditId: entry.id,
      };

      entry.addMetadata('report', {
        ...report,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });

      // MAI Rule 2: context elevates, never reduces. A CRITICAL routing
      // report is a Mandatory governance event that requires a gate.
      const isCritical = overallStatus === RoutingBandStatus.CRITICAL;
      const score = this.scorer.scoreDefault('routing-threshold-assessment');
      const completed = entry.complete(score, {
        classification: isCritical ? MaiClassification.MANDATORY : MaiClassification.ADVISORY,
        confidence: 1.0,
        rationale: isCritical
          ? `Routing health CRITICAL: ${this.criticalSummary(report)} Premium-tier routing requires human review.`
          : `Routing health ${overallStatus} over ${window.length} observations.`,
        requiresGate: isCritical,
      });
      this.ledger.record(completed);

      return report;
    } catch (error) {
      const failed = entry.fail(
        error instanceof Error ? error : new Error(String(error)),
        MaiClassification.ADVISORY,
      );
      this.ledger.record(failed);
      throw error;
    }
  }

  // ---------------------------------------------------------------- bands

  private assessFallback(window: IRoutingObservation[], windowEnd: Date): IRoutingMetric {
    const premium = window.filter((o) => o.plannedTier === ModelTier.FABLE_5);
    if (premium.length < this.config.minSampleSize) {
      return this.insufficient('fallback_rate', premium.length);
    }
    const fallbacks = premium.filter((o) => o.outcome === RoutingOutcome.SAFEGUARD_FALLBACK);
    const rate = fallbacks.length / premium.length;

    // Theater check: a perfect score with no proof the detector works is
    // UNVERIFIED, not HEALTHY. Applies to ANY band-eligible sample — control
    // flow is already past the minSampleSize floor here. (A prior
    // zeroFallbackSuspectN >= 200 qualifier left a 50-199 window where a
    // dead detector reported HEALTHY — the exact false-green this check
    // exists to prevent.)
    if (rate === 0) {
      const heartbeatFresh =
        this.lastHeartbeat !== null &&
        windowEnd.getTime() - this.lastHeartbeat.getTime() < 24 * 60 * 60 * 1000;
      if (!heartbeatFresh) {
        return {
          name: 'fallback_rate',
          value: 0,
          status: RoutingBandStatus.UNVERIFIED,
          sampleSize: premium.length,
          rationale:
            'Zero fallbacks with no detector heartbeat in 24h. ' +
            'Cannot distinguish perfect routing from blind instrumentation.',
        };
      }
    }

    return this.band('fallback_rate', rate, premium.length, {
      warnAbove: this.config.fallbackWarn,
      criticalAbove: this.config.fallbackCritical,
      healthyText: 'Provider fallbacks are residue, not a routing mechanism.',
      warnText: 'Upstream domain classifier is leaking safeguarded work to the premium tier.',
      criticalText: 'Routing logic is broken upstream. Paying premium rates for fallback answers.',
    });
  }

  private assessCacheHit(window: IRoutingObservation[]): IRoutingMetric {
    if (window.length < this.config.minSampleSize) {
      return this.insufficient('cache_hit_rate', window.length);
    }
    const totalInput = window.reduce((s, o) => s + o.inputTokens, 0);
    const cached = window.reduce((s, o) => s + o.cacheReadTokens, 0);
    if (totalInput === 0) return this.insufficient('cache_hit_rate', window.length);
    const rate = cached / totalInput;

    return this.band('cache_hit_rate', rate, window.length, {
      warnBelow: this.config.cacheHitWarn,
      criticalBelow: this.config.cacheHitCritical,
      healthyText: 'Stable prefixes (charters, MAI blocks, schemas) are being reused.',
      warnText: 'Prefix design is leaking dynamic content into the cacheable region.',
      criticalText: 'Cache is effectively off. The prefix is the problem, not the model.',
    });
  }

  private assessBatchUtilization(window: IRoutingObservation[]): IRoutingMetric {
    const eligible = window.filter((o) => o.batchEligible);
    if (eligible.length < this.config.minSampleSize) {
      return this.insufficient('batch_utilization', eligible.length);
    }
    const batched = eligible.filter((o) => o.batched);
    const rate = batched.length / eligible.length;

    return this.band('batch_utilization', rate, eligible.length, {
      warnBelow: this.config.batchUtilizationWarn,
      criticalBelow: this.config.batchUtilizationCritical,
      healthyText: 'Batch-eligible workload is running batched at the 50% rate.',
      warnText: 'Eligible work is running interactive. Each eligible token unbatched is a 2x overpay.',
      criticalText: 'Batch routing has effectively stopped. Spend is doubling on eligible classes.',
    });
  }

  private assessPremiumLeakage(window: IRoutingObservation[]): IRoutingMetric {
    const premium = window.filter((o) => o.plannedTier === ModelTier.FABLE_5);
    if (premium.length < this.config.minSampleSize) {
      return this.insufficient('premium_leakage', premium.length);
    }
    const cost = (o: IRoutingObservation): number => {
      const p = this.pricing[o.plannedTier];
      if (!p) throw new Error(`GovernedError[routing-monitor]: no pricing for ${o.plannedTier}`);
      const uncachedInput = Math.max(o.inputTokens - o.cacheReadTokens, 0);
      const inputCost = (uncachedInput * p.input + o.cacheReadTokens * p.input * 0.1) / 1_000_000;
      return inputCost + (o.outputTokens * p.output) / 1_000_000;
    };
    const totalSpend = premium.reduce((s, o) => s + cost(o), 0);
    const leakedSpend = premium
      .filter((o) => o.outcome === RoutingOutcome.SAFEGUARD_FALLBACK)
      .reduce((s, o) => s + cost(o), 0);
    if (totalSpend === 0) return this.insufficient('premium_leakage', premium.length);
    const rate = leakedSpend / totalSpend;

    return this.band('premium_leakage', rate, premium.length, {
      warnAbove: this.config.premiumLeakageWarn,
      criticalAbove: this.config.premiumLeakageCritical,
      healthyText: 'Premium spend is buying premium answers.',
      warnText: 'A material share of Fable-rate dollars returned fallback-tier answers.',
      criticalText: 'Significant spend at premium rates for non-premium answers. Route safeguarded domains to Opus 4.8 directly.',
    });
  }

  // ---------------------------------------------------------------- helpers

  private criticalSummary(report: IRoutingHealthReport): string {
    const critical = [report.fallbackRate, report.cacheHitRate, report.batchUtilization, report.premiumLeakage]
      .filter((m) => m.status === RoutingBandStatus.CRITICAL)
      .map((m) => `${m.name}=${Number.isNaN(m.value) ? 'n/a' : (m.value * 100).toFixed(1) + '%'}`);
    return critical.join(', ') + '.';
  }

  private band(
    name: string,
    value: number,
    sampleSize: number,
    spec: {
      warnAbove?: number;
      criticalAbove?: number;
      warnBelow?: number;
      criticalBelow?: number;
      healthyText: string;
      warnText: string;
      criticalText: string;
    },
  ): IRoutingMetric {
    let status = RoutingBandStatus.HEALTHY;
    let rationale = spec.healthyText;

    if (spec.criticalAbove !== undefined && value > spec.criticalAbove) {
      status = RoutingBandStatus.CRITICAL;
      rationale = spec.criticalText;
    } else if (spec.warnAbove !== undefined && value > spec.warnAbove) {
      status = RoutingBandStatus.WARNING;
      rationale = spec.warnText;
    } else if (spec.criticalBelow !== undefined && value < spec.criticalBelow) {
      status = RoutingBandStatus.CRITICAL;
      rationale = spec.criticalText;
    } else if (spec.warnBelow !== undefined && value < spec.warnBelow) {
      status = RoutingBandStatus.WARNING;
      rationale = spec.warnText;
    }

    return { name, value, status, sampleSize, rationale };
  }

  private insufficient(name: string, sampleSize: number): IRoutingMetric {
    return {
      name,
      value: NaN,
      status: RoutingBandStatus.INSUFFICIENT_DATA,
      sampleSize,
      rationale: `Fewer than ${this.config.minSampleSize} qualifying observations. No assessment issued.`,
    };
  }

  private worstOf(statuses: RoutingBandStatus[]): RoutingBandStatus {
    const order = [
      RoutingBandStatus.CRITICAL,
      RoutingBandStatus.UNVERIFIED,
      RoutingBandStatus.WARNING,
      RoutingBandStatus.INSUFFICIENT_DATA,
      RoutingBandStatus.HEALTHY,
    ];
    for (const s of order) if (statuses.includes(s)) return s;
    return RoutingBandStatus.HEALTHY;
  }
}
