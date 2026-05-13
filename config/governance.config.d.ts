/**
 * @module    governance-config
 * @layer     CONFIG
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */
import { type IMaiVerticalConfig } from '../src/shared/types.js';
export declare const ACE_MAI_CONFIG: IMaiVerticalConfig;
export declare const GOVERNANCE_CONFIG: {
    autoRunMode: boolean;
    advisoryGateTimeoutMs: number;
    scoringWeights: {
        integrity: number;
        accuracy: number;
        compliance: number;
    };
    thresholdWindowSize: number;
};
//# sourceMappingURL=governance.config.d.ts.map