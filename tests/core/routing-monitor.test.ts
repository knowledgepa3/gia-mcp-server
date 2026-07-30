/**
 * @module    test-routing-monitor
 * @layer     TEST
 * @inherits  src/core/threshold/routing-monitor
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verifies the ModelRoutingThresholdMonitor (MRT):
 *  - Boundary tests: classification boundaries must be exact
 *  - Theater detection: perfect metric without detector heartbeat is UNVERIFIED
 *  - Canary handling: heartbeat-only, never band data
 *  - Audit: every assessment writes to the real ForensicLedger; CRITICAL
 *    reports elevate to MANDATORY with requiresGate
 *  - Governance-aware errors: no silent failures
 */

import { describe, it, expect } from 'vitest';
import { ModelRoutingThresholdMonitor } from '../../src/core/threshold/routing-monitor.js';
import {
  type IRoutingObservation,
  ModelTier,
  RoutingOutcome,
  RoutingBandStatus,
} from '../../src/core/threshold/routing-types.js';
import { ROUTING_THRESHOLD_DEFAULTS, TIER_PRICING_USD_PER_MTOK } from '../../src/config/routing-threshold.config.js';
import { ForensicLedger } from '../../src/core/audit/ledger.js';
import { GovernanceScorer } from '../../src/core/scoring/scorer.js';
import { MaiClassification, EntryStatus } from '../../src/shared/types.js';

let seq = 0;
const obs = (over: Partial<IRoutingObservation>): IRoutingObservation => ({
  requestId: `req-${seq++}`,
  timestamp: new Date('2026-06-10T12:00:00Z'),
  plannedTier: ModelTier.FABLE_5,
  servedTier: ModelTier.FABLE_5,
  outcome: RoutingOutcome.ROUTED_AS_PLANNED,
  batched: true,
  batchEligible: true,
  inputTokens: 100_000,
  cacheReadTokens: 70_000,
  cacheWriteTokens: 0,
  outputTokens: 5_000,
  ...over,
});

const windowStart = new Date('2026-06-10T00:00:00Z');
const windowEnd = new Date('2026-06-11T00:00:00Z');

const build = () => {
  const ledger = new ForensicLedger();
  const monitor = new ModelRoutingThresholdMonitor(
    ROUTING_THRESHOLD_DEFAULTS,
    TIER_PRICING_USD_PER_MTOK,
    ledger,
    new GovernanceScorer(),
  );
  return { monitor, ledger };
};

describe('ModelRoutingThresholdMonitor', () => {
  // Boundary tests: classification boundaries must be exact (testing.md sec 2)
  it('reports INSUFFICIENT_DATA below minimum sample size, never HEALTHY', () => {
    const { monitor } = build();
    for (let i = 0; i < ROUTING_THRESHOLD_DEFAULTS.minSampleSize - 1; i++) monitor.record(obs({}));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.INSUFFICIENT_DATA);
  });

  it('flags fallback rate above critical band as CRITICAL', () => {
    const { monitor } = build();
    for (let i = 0; i < 80; i++) monitor.record(obs({}));
    for (let i = 0; i < 20; i++)
      monitor.record(obs({ outcome: RoutingOutcome.SAFEGUARD_FALLBACK, servedTier: ModelTier.OPUS_4_8 }));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.value).toBeCloseTo(0.2);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.CRITICAL);
    expect(r.overallStatus).toBe(RoutingBandStatus.CRITICAL);
  });

  // Theater detection: perfect metric without detector heartbeat is UNVERIFIED
  it('marks zero fallbacks over a large sample as UNVERIFIED without heartbeat', () => {
    const { monitor } = build();
    for (let i = 0; i < 200; i++) monitor.record(obs({}));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.UNVERIFIED);
  });

  // Regression (2026-06-10 adversarial review): the theater check previously
  // only fired at >= 200 observations, so a dead detector over a 50-199
  // sample reported HEALTHY — the exact false-green the check exists to
  // prevent. Any band-eligible sample must require a heartbeat for a
  // perfect score.
  it('marks zero fallbacks as UNVERIFIED without heartbeat on a small band-eligible sample (50-199)', () => {
    const { monitor } = build();
    for (let i = 0; i < 150; i++) monitor.record(obs({}));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.UNVERIFIED);
  });

  it('marks zero fallbacks as UNVERIFIED without heartbeat at exactly minSampleSize', () => {
    const { monitor } = build();
    for (let i = 0; i < ROUTING_THRESHOLD_DEFAULTS.minSampleSize; i++) monitor.record(obs({}));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.UNVERIFIED);
  });

  it('accepts zero fallbacks when detector heartbeat is fresh', () => {
    const { monitor } = build();
    for (let i = 0; i < 200; i++) monitor.record(obs({}));
    monitor.recordDetectorHeartbeat(new Date('2026-06-10T23:00:00Z'));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.HEALTHY);
  });

  it('accepts zero fallbacks on a small sample when detector heartbeat is fresh', () => {
    const { monitor } = build();
    for (let i = 0; i < 150; i++) monitor.record(obs({}));
    monitor.recordDetectorHeartbeat(new Date('2026-06-10T23:00:00Z'));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.HEALTHY);
  });

  // Canary: a tripped canary IS the heartbeat, but never band data
  it('treats a canary fallback as heartbeat without polluting band metrics', () => {
    const { monitor } = build();
    for (let i = 0; i < 200; i++) monitor.record(obs({}));
    monitor.record(obs({
      canary: true,
      outcome: RoutingOutcome.SAFEGUARD_FALLBACK,
      servedTier: ModelTier.OPUS_4_8,
      timestamp: new Date('2026-06-10T23:30:00Z'),
    }));
    const r = monitor.assessHealth(windowStart, windowEnd);
    // Heartbeat satisfied by the canary → HEALTHY, and the canary itself is
    // excluded: fallback rate stays exactly 0 over the real sample.
    expect(r.fallbackRate.status).toBe(RoutingBandStatus.HEALTHY);
    expect(r.fallbackRate.value).toBe(0);
    expect(r.fallbackRate.sampleSize).toBe(200);
  });

  it('flags low cache hit rate as CRITICAL below the floor', () => {
    const { monitor } = build();
    for (let i = 0; i < 60; i++) monitor.record(obs({ cacheReadTokens: 10_000 })); // 10% hit
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.cacheHitRate.status).toBe(RoutingBandStatus.CRITICAL);
  });

  it('flags unbatched eligible workload', () => {
    const { monitor } = build();
    for (let i = 0; i < 30; i++) monitor.record(obs({ batched: true }));
    for (let i = 0; i < 70; i++) monitor.record(obs({ batched: false }));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.batchUtilization.value).toBeCloseTo(0.3);
    expect(r.batchUtilization.status).toBe(RoutingBandStatus.CRITICAL);
  });

  // Audit requirement: every assessment writes to the ledger
  it('writes every assessment to the forensic ledger', () => {
    const { monitor, ledger } = build();
    for (let i = 0; i < 60; i++) monitor.record(obs({}));
    const r = monitor.assessHealth(windowStart, windowEnd);
    const completed = ledger.queryCompleted();
    const assessment = completed.find((e) => e.id === r.auditId);
    expect(assessment).toBeDefined();
    expect(assessment!.operation).toBe('routing-threshold-assessment');
    expect(assessment!.status).toBe(EntryStatus.COMPLETED);
  });

  // MAI Rule 2: CRITICAL elevates the ledger event to MANDATORY + requiresGate
  it('elevates CRITICAL reports to MANDATORY classification in the ledger', () => {
    const { monitor, ledger } = build();
    for (let i = 0; i < 80; i++) monitor.record(obs({}));
    for (let i = 0; i < 20; i++)
      monitor.record(obs({ outcome: RoutingOutcome.SAFEGUARD_FALLBACK, servedTier: ModelTier.OPUS_4_8 }));
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.overallStatus).toBe(RoutingBandStatus.CRITICAL);
    const assessment = ledger.queryCompleted().find((e) => e.id === r.auditId);
    expect(assessment!.metadata.maiClassification).toBe(MaiClassification.MANDATORY);
  });

  // Hydration: idempotent across repeated loads (same request_id never double-counts)
  it('deduplicates hydrated observations by requestId', () => {
    const { monitor } = build();
    const batch = Array.from({ length: 60 }, () => obs({}));
    monitor.hydrate(batch);
    monitor.hydrate(batch); // second hydration of the same rows
    const r = monitor.assessHealth(windowStart, windowEnd);
    expect(r.totalObservations).toBe(60);
  });

  // Governance-aware errors: no silent failures
  it('rejects malformed observations instead of swallowing them', () => {
    const { monitor } = build();
    expect(() => monitor.record(obs({ inputTokens: -1 }))).toThrow(/GovernedError/);
  });
});
