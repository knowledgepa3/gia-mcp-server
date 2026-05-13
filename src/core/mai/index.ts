/**
 * @module    mai
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */
export { MaiClassifier } from './classifier.js';
export { MaiGate, type IGateConfig } from './gate.js';
export { MAI_PRIORITY, DEFAULT_ELEVATION_RULES, type IClassificationContext, type IClassificationRequest } from './types.js';
export { notifyGateCreated, notifyGateResolved, notifyGateExpired, registerTenantWebhookResolver } from './webhook.js';
export type { IGateEventData, IWebhookConfig, IWebhookGatePayload } from './webhook.js';
