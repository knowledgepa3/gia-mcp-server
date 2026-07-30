/**
 * Audit finding M10 — truth-in-labeling for SRT postmortem ROI figures.
 *
 * The postmortem's humanTimeSavedMinutes / costAvoidedUSD are HEURISTIC
 * ESTIMATES from hardcoded severity buckets, not measured savings. They are
 * persisted into srt_incidents_persistent (postmortem JSONB), so they must
 * carry an explicit `estimated` / `basis` annotation. This test pins that
 * honest contract and pins the (unchanged) bucket math.
 *
 * Real timing metrics (TTD/TTDiag/TTR) are computed separately and are NOT
 * covered here — they are real measurements and must not be relabeled.
 */
import { describe, it, expect } from 'vitest';
import { estimateRepairRoi } from '../../src/mcp/tools/srt.js';

describe('M10: SRT ROI estimate is honestly labeled', () => {
  it('marks every result as an estimate with a severity-bucket basis', () => {
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) {
      const roi = estimateRepairRoi(severity, 0);
      expect(roi.estimated).toBe(true);
      expect(roi.basis).toBe('severity-bucket heuristic');
    }
  });

  it('exposes humanTimeSavedMinutes and costAvoidedUSD as numbers', () => {
    const roi = estimateRepairRoi('HIGH', 10);
    expect(typeof roi.humanTimeSavedMinutes).toBe('number');
    expect(typeof roi.costAvoidedUSD).toBe('number');
  });

  // Pin the bucket values + math so a future edit can't silently change the
  // ROI heuristic while leaving the "estimate" label in place.
  it('CRITICAL bucket: manual=90min, $100/min (unchanged)', () => {
    // totalActiveMinutes = 0 -> humanTimeSaved = 90 - round(0) = 90
    const roi = estimateRepairRoi('CRITICAL', 0);
    expect(roi.humanTimeSavedMinutes).toBe(90);
    expect(roi.costAvoidedUSD).toBe(90 * 100);
  });

  it('HIGH bucket: manual=60min, $50/min (unchanged)', () => {
    const roi = estimateRepairRoi('HIGH', 0);
    expect(roi.humanTimeSavedMinutes).toBe(60);
    expect(roi.costAvoidedUSD).toBe(60 * 50);
  });

  it('default (non-CRITICAL/HIGH) bucket: manual=30min, $10/min (unchanged)', () => {
    const roi = estimateRepairRoi('MEDIUM', 0);
    expect(roi.humanTimeSavedMinutes).toBe(30);
    expect(roi.costAvoidedUSD).toBe(30 * 10);
  });

  it('subtracts 10% of total active minutes from the manual estimate (unchanged math)', () => {
    // CRITICAL, totalActiveMinutes = 200 -> 90 - round(20) = 70 min, *$100 = $7000
    const roi = estimateRepairRoi('CRITICAL', 200);
    expect(roi.humanTimeSavedMinutes).toBe(70);
    expect(roi.costAvoidedUSD).toBe(7000);
  });

  it('never returns negative time saved (floored at 0)', () => {
    const roi = estimateRepairRoi('MEDIUM', 10000); // 30 - 1000 -> floored to 0
    expect(roi.humanTimeSavedMinutes).toBe(0);
    expect(roi.costAvoidedUSD).toBe(0);
  });
});
