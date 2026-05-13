/**
 * @module    sampling
 * @layer     CORE
 * @inherits  governance-root
 * @mai       A — governed sampling baseline
 * @audit     true
 * @owner     William J. Storey III / ACE / GIA
 */

export { GovernedSampling, type ISamplingRequest, type ISamplingResult } from './governed-sampling.js';
export { type ISamplingPolicy, type SamplingPurpose, ALL_SAMPLING_PURPOSES, DEFAULT_SAMPLING_POLICY } from './sampling-policy.js';
