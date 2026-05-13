/**
 * @module    governance-config
 * @layer     CONFIG
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */
import { MaiClassification } from '../src/shared/types.js';
export const ACE_MAI_CONFIG = {
    vertical: 'ace',
    agentClassifications: {
        'unified-gateway': MaiClassification.MANDATORY,
        'timeline-builder': MaiClassification.INFORMATIONAL,
        'evidence-validator': MaiClassification.ADVISORY,
        'initial-rater': MaiClassification.ADVISORY,
        'cnp-examiner': MaiClassification.ADVISORY,
        'rater-decision': MaiClassification.MANDATORY,
        'quality-assurance': MaiClassification.ADVISORY,
        'report-generator': MaiClassification.MANDATORY,
        'telemetry-collector': MaiClassification.INFORMATIONAL,
    },
    elevationRules: [
        { condition: 'pii_detected', elevateTo: MaiClassification.MANDATORY, description: 'Veteran PII detected — MANDATORY' },
        { condition: 'cue_identified', elevateTo: MaiClassification.MANDATORY, description: 'CUE identified — MANDATORY review' },
        { condition: 'medical_language', elevateTo: MaiClassification.ADVISORY, description: 'Medical language — ADVISORY minimum' },
    ],
};
export const GOVERNANCE_CONFIG = {
    autoRunMode: true, // Enable for initial development; disable in production
    advisoryGateTimeoutMs: 5 * 60 * 1000,
    scoringWeights: { integrity: 0.40, accuracy: 0.35, compliance: 0.25 },
    thresholdWindowSize: 100,
};
//# sourceMappingURL=governance.config.js.map