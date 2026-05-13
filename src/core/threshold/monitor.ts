/**
 * @module    storey-threshold-monitor
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       A — threshold monitoring is ADVISORY (alerts on deviation)
 * @audit     true — threshold readings recorded
 * @owner     William J. Storey III / ACE / GIA
 */

import {
  MaiClassification, type IThresholdReading, ThresholdStatus,
  type IMaiResult,
} from '../../shared/types.js';
import {
  STOREY_THRESHOLD_MIN, STOREY_THRESHOLD_MAX,
  STOREY_THRESHOLD_CRITICAL_LOW, STOREY_THRESHOLD_CRITICAL_HIGH,
  STOREY_THRESHOLD_MIN_WINDOW, STOREY_THRESHOLD_WINDOW_SIZE,
  STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS,
} from '../../shared/constants.js';

/**
 * StoreyThresholdMonitor — monitors escalation rates across all governed operations.
 *
 * The Storey Threshold (10-18% escalation rate) is a quantitative governance
 * health indicator. Escalation = any decision classified as MANDATORY.
 *
 * Below 10%: under-classifying, possibly missing critical decisions
 * 10-18%: healthy — governance is appropriately calibrated
 * Above 18%: over-classifying, creating unnecessary friction
 * Above 25% or below 5%: CRITICAL — system health concern
 */
export class StoreyThresholdMonitor {
  private decisions: Array<{ classification: MaiClassification; timestamp: Date }> = [];
  private windowSize: number;

  constructor(windowSize: number = STOREY_THRESHOLD_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  /**
   * Record a classification decision for threshold calculation.
   * Called after every MAI classification.
   *
   * @param classification — the MAI result to record
   * @param timestamp — optional original timestamp. Pass when seeding from
   *   recovered ledger entries so historical decisions don't all collapse onto
   *   the recovery instant. Defaults to `new Date()` for live classifications.
   */
  record(classification: IMaiResult, timestamp?: Date): void {
    this.decisions.push({
      classification: classification.classification,
      timestamp: timestamp ?? new Date(),
    });

    // Trim to window size — keep exactly windowSize most recent decisions
    if (this.decisions.length > this.windowSize) {
      this.decisions = this.decisions.slice(-this.windowSize);
    }
  }

  /**
   * Get current threshold reading.
   *
   * @governance  The Storey Threshold is THE governance health indicator.
   * @ledger      Reading recorded by caller.
   * @failure     Returns INSUFFICIENT_DATA if either:
   *              (a) the window has fewer than STOREY_THRESHOLD_MIN_WINDOW
   *                  decisions (count-confidence floor), or
   *              (b) the window's wall-clock span is shorter than
   *                  STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS (time-confidence floor).
   *              The time-confidence floor catches the case where the count is
   *              full but every entry was stamped within a few milliseconds —
   *              e.g., recovery seeded historical entries onto the boot instant.
   *              In that situation the rate is real arithmetic but is not
   *              predictive of current operational health.
   */
  getReading(): IThresholdReading {
    const window = this.decisions.slice(-this.windowSize);

    if (window.length < STOREY_THRESHOLD_MIN_WINDOW) {
      return {
        escalationRate: 0,
        windowSize: window.length,
        windowStart: window[0]?.timestamp ?? new Date(),
        windowEnd: window[window.length - 1]?.timestamp ?? new Date(),
        isHealthy: false,
        status: ThresholdStatus.INSUFFICIENT_DATA,
      };
    }

    // Compute true min/max timestamps rather than trusting insertion order —
    // recovery seeding may push entries out of chronological order.
    let minTs = window[0].timestamp.getTime();
    let maxTs = window[0].timestamp.getTime();
    for (let i = 1; i < window.length; i++) {
      const t = window[i].timestamp.getTime();
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }

    // Time-confidence floor — full count but degenerate time-span means the
    // window is not predictive of current operational health.
    if (maxTs - minTs < STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS) {
      return {
        escalationRate: 0,
        windowSize: window.length,
        windowStart: new Date(minTs),
        windowEnd: new Date(maxTs),
        isHealthy: false,
        status: ThresholdStatus.INSUFFICIENT_DATA,
      };
    }

    const escalations = window.filter(d => d.classification === MaiClassification.MANDATORY).length;
    const rate = escalations / window.length;

    return {
      escalationRate: rate,
      windowSize: window.length,
      windowStart: new Date(minTs),
      windowEnd: new Date(maxTs),
      isHealthy: rate >= STOREY_THRESHOLD_MIN && rate <= STOREY_THRESHOLD_MAX,
      status: this.calculateStatus(rate),
    };
  }

  /**
   * Get detailed breakdown of classifications in current window.
   */
  getBreakdown(): Record<MaiClassification, number> {
    const window = this.decisions.slice(-this.windowSize);
    return {
      [MaiClassification.MANDATORY]: window.filter(d => d.classification === MaiClassification.MANDATORY).length,
      [MaiClassification.ADVISORY]: window.filter(d => d.classification === MaiClassification.ADVISORY).length,
      [MaiClassification.INFORMATIONAL]: window.filter(d => d.classification === MaiClassification.INFORMATIONAL).length,
    };
  }

  /**
   * Check if threshold is in healthy band.
   */
  isHealthy(): boolean {
    return this.getReading().isHealthy;
  }

  private calculateStatus(rate: number): ThresholdStatus {
    if (rate < STOREY_THRESHOLD_CRITICAL_LOW || rate > STOREY_THRESHOLD_CRITICAL_HIGH) {
      return ThresholdStatus.CRITICAL;
    }
    if (rate < STOREY_THRESHOLD_MIN) return ThresholdStatus.LOW_ESCALATION;
    if (rate > STOREY_THRESHOLD_MAX) return ThresholdStatus.HIGH_ESCALATION;
    return ThresholdStatus.HEALTHY;
  }
}
