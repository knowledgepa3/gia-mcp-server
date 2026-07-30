/**
 * @module    test-storey-threshold-monitor
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verifies the StoreyThresholdMonitor — particularly the two confidence floors
 * that prevent false CRITICAL readings:
 *  - Count floor (windowSize < STOREY_THRESHOLD_MIN_WINDOW)
 *  - Time-span floor (windowEnd - windowStart < STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS)
 *
 * Also verifies the optional `timestamp` parameter on record(), which is what
 * recovery seeding uses to preserve original entry timestamps.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StoreyThresholdMonitor } from '../../src/core/threshold/monitor.js';
import {
  MaiClassification,
  ThresholdStatus,
  type IMaiResult,
} from '../../src/shared/types.js';
import {
  STOREY_THRESHOLD_MIN_WINDOW,
  STOREY_THRESHOLD_WINDOW_SIZE,
  STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS,
} from '../../src/shared/constants.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeResult(level: MaiClassification): IMaiResult {
  return {
    classification: level,
    confidence: 1.0,
    rationale: 'test',
    requiresGate: level === MaiClassification.MANDATORY,
  };
}

/** Fill a monitor with N decisions of `level`, all stamped at `timestamp` (or now). */
function seed(monitor: StoreyThresholdMonitor, n: number, level: MaiClassification, timestamp?: Date): void {
  for (let i = 0; i < n; i++) {
    monitor.record(makeResult(level), timestamp);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('StoreyThresholdMonitor', () => {
  let monitor: StoreyThresholdMonitor;

  beforeEach(() => {
    monitor = new StoreyThresholdMonitor();
  });

  describe('count-confidence floor', () => {
    it('returns INSUFFICIENT_DATA when window has fewer than MIN_WINDOW decisions', () => {
      seed(monitor, STOREY_THRESHOLD_MIN_WINDOW - 1, MaiClassification.MANDATORY);
      const reading = monitor.getReading();
      expect(reading.status).toBe(ThresholdStatus.INSUFFICIENT_DATA);
      expect(reading.isHealthy).toBe(false);
    });

    it('does not return INSUFFICIENT_DATA when window meets MIN_WINDOW (with adequate time spread)', () => {
      // Spread decisions across more than MIN_WINDOW_SPAN_MS so the time floor passes too.
      const start = new Date('2026-01-01T00:00:00Z');
      const spreadMs = STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS + 1000;
      for (let i = 0; i < STOREY_THRESHOLD_MIN_WINDOW; i++) {
        const t = new Date(start.getTime() + (spreadMs * i) / (STOREY_THRESHOLD_MIN_WINDOW - 1));
        monitor.record(makeResult(MaiClassification.INFORMATIONAL), t);
      }
      const reading = monitor.getReading();
      expect(reading.status).not.toBe(ThresholdStatus.INSUFFICIENT_DATA);
    });
  });

  describe('time-confidence floor (the bug this fix is for)', () => {
    it('returns INSUFFICIENT_DATA when count is full but all decisions share one instant', () => {
      // This is the recovery-seeding bug: 100 historical decisions, all stamped at boot.
      const recoveryInstant = new Date('2026-04-27T01:28:00.939Z');
      seed(monitor, STOREY_THRESHOLD_WINDOW_SIZE, MaiClassification.INFORMATIONAL, recoveryInstant);

      const reading = monitor.getReading();
      expect(reading.status).toBe(ThresholdStatus.INSUFFICIENT_DATA);
      expect(reading.windowSize).toBe(STOREY_THRESHOLD_WINDOW_SIZE);
      expect(reading.windowStart.getTime()).toBe(recoveryInstant.getTime());
      expect(reading.windowEnd.getTime()).toBe(recoveryInstant.getTime());
    });

    it('returns INSUFFICIENT_DATA when window span is just under the floor', () => {
      const start = new Date('2026-04-27T01:00:00Z');
      // Spread evenly across (floor - 1000ms) — still under threshold.
      const spreadMs = STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS - 1000;
      for (let i = 0; i < STOREY_THRESHOLD_WINDOW_SIZE; i++) {
        const t = new Date(start.getTime() + (spreadMs * i) / (STOREY_THRESHOLD_WINDOW_SIZE - 1));
        monitor.record(makeResult(MaiClassification.INFORMATIONAL), t);
      }
      const reading = monitor.getReading();
      expect(reading.status).toBe(ThresholdStatus.INSUFFICIENT_DATA);
    });

    it('does NOT return INSUFFICIENT_DATA when window span just exceeds the floor', () => {
      const start = new Date('2026-04-27T01:00:00Z');
      const spreadMs = STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS + 1000;
      for (let i = 0; i < STOREY_THRESHOLD_WINDOW_SIZE; i++) {
        const t = new Date(start.getTime() + (spreadMs * i) / (STOREY_THRESHOLD_WINDOW_SIZE - 1));
        monitor.record(makeResult(MaiClassification.INFORMATIONAL), t);
      }
      const reading = monitor.getReading();
      expect(reading.status).not.toBe(ThresholdStatus.INSUFFICIENT_DATA);
    });
  });

  describe('healthy band reporting', () => {
    it('reports HEALTHY when escalation rate is in [10%, 18%] band over a real time window', () => {
      const start = new Date('2026-04-27T01:00:00Z');
      const spreadMs = STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS + 60_000;
      const total = STOREY_THRESHOLD_WINDOW_SIZE;
      const mandatoryCount = 14; // 14% — squarely in the band
      for (let i = 0; i < total; i++) {
        const t = new Date(start.getTime() + (spreadMs * i) / (total - 1));
        const level = i < mandatoryCount ? MaiClassification.MANDATORY : MaiClassification.INFORMATIONAL;
        monitor.record(makeResult(level), t);
      }
      const reading = monitor.getReading();
      expect(reading.status).toBe(ThresholdStatus.HEALTHY);
      expect(reading.escalationRate).toBeCloseTo(0.14, 2);
      expect(reading.isHealthy).toBe(true);
    });

    it('reports CRITICAL only when rate is genuinely outside critical bounds AND time-spread is real', () => {
      const start = new Date('2026-04-27T01:00:00Z');
      const spreadMs = STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS + 60_000;
      // 1 MANDATORY out of 100 = 1% — below CRITICAL_LOW (5%)
      for (let i = 0; i < STOREY_THRESHOLD_WINDOW_SIZE; i++) {
        const t = new Date(start.getTime() + (spreadMs * i) / (STOREY_THRESHOLD_WINDOW_SIZE - 1));
        const level = i === 0 ? MaiClassification.MANDATORY : MaiClassification.INFORMATIONAL;
        monitor.record(makeResult(level), t);
      }
      const reading = monitor.getReading();
      expect(reading.status).toBe(ThresholdStatus.CRITICAL);
      expect(reading.escalationRate).toBeCloseTo(0.01, 2);
    });
  });

  describe('window timestamp computation', () => {
    it('computes windowStart and windowEnd from min and max timestamps, not insertion order', () => {
      // Insert out of chronological order: middle, oldest, newest.
      const middle = new Date('2026-04-27T02:00:00Z');
      const oldest = new Date('2026-04-27T01:00:00Z');
      const newest = new Date('2026-04-27T03:00:00Z');

      // Need >= MIN_WINDOW with valid time spread, then check min/max are recovered.
      seed(monitor, 10, MaiClassification.INFORMATIONAL, middle);
      seed(monitor, 10, MaiClassification.INFORMATIONAL, oldest);
      seed(monitor, 10, MaiClassification.INFORMATIONAL, newest);

      const reading = monitor.getReading();
      expect(reading.status).not.toBe(ThresholdStatus.INSUFFICIENT_DATA);
      expect(reading.windowStart.getTime()).toBe(oldest.getTime());
      expect(reading.windowEnd.getTime()).toBe(newest.getTime());
    });
  });

  describe('timestamp parameter on record()', () => {
    it('uses the passed timestamp when provided', () => {
      const t = new Date('2024-01-01T00:00:00Z');
      monitor.record(makeResult(MaiClassification.MANDATORY), t);
      seed(monitor, STOREY_THRESHOLD_MIN_WINDOW, MaiClassification.INFORMATIONAL, new Date('2026-01-01T00:00:00Z'));
      const reading = monitor.getReading();
      expect(reading.windowStart.getTime()).toBe(t.getTime());
    });

    it('falls back to new Date() when timestamp is omitted', () => {
      const before = Date.now();
      monitor.record(makeResult(MaiClassification.INFORMATIONAL));
      const after = Date.now();
      // Force a reading even though count is below MIN_WINDOW — windowStart is still populated.
      const reading = monitor.getReading();
      expect(reading.windowStart.getTime()).toBeGreaterThanOrEqual(before);
      expect(reading.windowEnd.getTime()).toBeLessThanOrEqual(after);
    });
  });
});
