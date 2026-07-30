/**
 * @module    routing-types
 * @layer     GOVERNANCE
 * @inherits  src/core/threshold (Storey Threshold family)
 * @mai       N/A — type definitions only
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

/** Model tiers GIA routes between. Extend as Anthropic ships new tiers. */
export enum ModelTier {
  FABLE_5 = 'claude-fable-5',
  OPUS_4_8 = 'claude-opus-4-8',
  SONNET_4_6 = 'claude-sonnet-4-6',
  HAIKU_4_5 = 'claude-haiku-4-5',
}

/** Why a request landed on the model it landed on. */
export enum RoutingOutcome {
  /** Request executed on the tier GIA's router selected. */
  ROUTED_AS_PLANNED = 'ROUTED_AS_PLANNED',
  /** Provider-side safeguard fallback (e.g. Fable 5 -> Opus 4.8). */
  SAFEGUARD_FALLBACK = 'SAFEGUARD_FALLBACK',
  /** GIA-side gate redirected the request before it left the proxy. */
  GIA_GATE_REDIRECT = 'GIA_GATE_REDIRECT',
  /** Provider error forced a retry on a different tier. */
  ERROR_FAILOVER = 'ERROR_FAILOVER',
}

/** One observed, completed model request. Recorded at the egress proxy chokepoint. */
export interface IRoutingObservation {
  readonly requestId: string;
  readonly timestamp: Date;
  /** Tier the GIA router intended. */
  readonly plannedTier: ModelTier;
  /** Tier that actually served the response. */
  readonly servedTier: ModelTier;
  readonly outcome: RoutingOutcome;
  /** True if this request went through the Message Batches API. */
  readonly batched: boolean;
  /** True if the workload class was batch-eligible (non-interactive). */
  readonly batchEligible: boolean;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** True for synthetic detector-heartbeat canaries. Canaries prove the
   *  fallback detector fires; they are EXCLUDED from all band math so
   *  synthetic traffic never pollutes real routing metrics. */
  readonly canary?: boolean;
}

export enum RoutingBandStatus {
  HEALTHY = 'HEALTHY',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
  /** Not enough observations to assess. Never silently report HEALTHY. */
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
  /** Metric reads perfect but instrumentation heartbeat is missing. Theater suspect. */
  UNVERIFIED = 'UNVERIFIED',
}

export interface IRoutingMetric {
  readonly name: string;
  readonly value: number;
  readonly status: RoutingBandStatus;
  readonly sampleSize: number;
  readonly rationale: string;
}

export interface IRoutingHealthReport {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly totalObservations: number;
  readonly fallbackRate: IRoutingMetric;
  readonly cacheHitRate: IRoutingMetric;
  readonly batchUtilization: IRoutingMetric;
  readonly premiumLeakage: IRoutingMetric;
  /** Worst status across all metrics. Drives gate behavior. */
  readonly overallStatus: RoutingBandStatus;
  readonly auditId: string;
}

export interface IRoutingBandConfig {
  /** Minimum observations before any band is assessed. */
  minSampleSize: number;
  /** Fallback rate above this is WARNING. */
  fallbackWarn: number;
  /** Fallback rate above this is CRITICAL: routing logic is broken upstream. */
  fallbackCritical: number;
  /** Cache hit rate below this is WARNING (prefix design problem). */
  cacheHitWarn: number;
  /** Cache hit rate below this is CRITICAL. */
  cacheHitCritical: number;
  /** Share of batch-eligible work actually batched. Below warn = burning money. */
  batchUtilizationWarn: number;
  batchUtilizationCritical: number;
  /** Share of premium-tier spend that returned a fallback-tier answer. */
  premiumLeakageWarn: number;
  premiumLeakageCritical: number;
}
