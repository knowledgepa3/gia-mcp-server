/**
 * @module    threshold-health
 * @layer     GOVERNANCE
 * @inherits  storey-threshold-monitor
 * @mai       A — health assessments are ADVISORY
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */

import { StoreyThresholdMonitor } from './monitor.js';
import { ThresholdStatus, type IThresholdReading } from '../../shared/types.js';

export interface IHealthAssessment {
  reading: IThresholdReading;
  recommendation: string;
  actionRequired: boolean;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export class ThresholdHealthAssessor {
  constructor(private readonly monitor: StoreyThresholdMonitor) {}

  assess(): IHealthAssessment {
    const reading = this.monitor.getReading();

    switch (reading.status) {
      case ThresholdStatus.HEALTHY:
        return { reading, recommendation: 'Governance calibration is nominal. No action required.', actionRequired: false, severity: 'INFO' };
      case ThresholdStatus.LOW_ESCALATION:
        return { reading, recommendation: 'Escalation rate below 10%. Review MAI classification rules — critical decisions may be under-classified.', actionRequired: true, severity: 'WARNING' };
      case ThresholdStatus.HIGH_ESCALATION:
        return { reading, recommendation: 'Escalation rate above 18%. Review MAI classification rules — non-critical decisions may be over-classified, creating unnecessary friction.', actionRequired: true, severity: 'WARNING' };
      case ThresholdStatus.CRITICAL:
        return { reading, recommendation: 'Escalation rate outside safe bounds (<5% or >25%). IMMEDIATE review required. System governance may be miscalibrated.', actionRequired: true, severity: 'CRITICAL' };
      case ThresholdStatus.INSUFFICIENT_DATA:
        return { reading, recommendation: 'Insufficient data for threshold calculation. Minimum 20 decisions required.', actionRequired: false, severity: 'INFO' };
    }
  }
}
