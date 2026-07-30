/**
 * @module    routing-threshold.config
 * @layer     GOVERNANCE
 * @inherits  src/core/threshold/routing-monitor
 * @mai       N/A — configuration constants
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { IRoutingBandConfig } from '../core/threshold/routing-types.js';

/**
 * INITIAL CALIBRATION — these bands are hypotheses, not validated constants.
 * Recalibrate after 30 days of production observations, same way the
 * 10-18% Storey escalation band was derived from observed healthy pipelines.
 *
 * Rationale per band:
 * - Fallback: a correct upstream router should send safeguarded-domain work
 *   to Opus 4.8 directly. Provider fallbacks should be rare residue, not a
 *   routing mechanism. >5% means the router's domain classifier is leaking.
 *   >15% means it is broken.
 * - Cache hit: stable prefixes (charters, MAI policy blocks, tool schemas)
 *   should dominate input. Industry observation: <20% hit rate after a week
 *   means the prefix design is the problem, not the model.
 * - Batch utilization: GIA's batch-eligible classes (overnight ECV, report
 *   generation, cohort content) should run batched. Every unbatched eligible
 *   token is a 2x overpay.
 * - Premium leakage: dollars billed at Fable 5 rates for requests that were
 *   served by fallback. This should trend to zero as the router learns.
 */
export const ROUTING_THRESHOLD_DEFAULTS: IRoutingBandConfig = {
  minSampleSize: 50,

  fallbackWarn: 0.05,
  fallbackCritical: 0.15,

  cacheHitWarn: 0.4,
  cacheHitCritical: 0.2,

  batchUtilizationWarn: 0.7,
  batchUtilizationCritical: 0.4,

  premiumLeakageWarn: 0.05,
  premiumLeakageCritical: 0.15,
};

/** Per-MTok pricing used for leakage math. Pin and review monthly.
 *  Verified against Anthropic list pricing 2026-06-10 — keep in sync with
 *  server/src/services/costCalculator.ts and llm/modelRegistry.ts. */
export const TIER_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
