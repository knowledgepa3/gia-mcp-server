/**
 * @module    sampling-policy
 * @layer     GOVERNANCE
 * @inherits  governance-root
 * @mai       A — sampling policy is advisory, enforcement is in governed-sampling
 * @audit     false — types only
 * @owner     William J. Storey III / ACE / GIA
 *
 * Sampling Policy — Defines the governance rules for MCP Sampling requests.
 *
 * MCP Sampling lets the server request the CLIENT to perform LLM completions.
 * This policy controls when, how, and under what constraints sampling is allowed.
 *
 * Security wins:
 *   - API keys eliminated from MCP server for sampled calls
 *   - Client handles auth — reduced attack surface
 *   - Enterprise controls which model/client is trusted
 *   - Token budget enforcement prevents runaway sampling
 */

// ─── Sampling Purpose ──────────────────────────────────────────────────────

export type SamplingPurpose =
  | 'analysis'
  | 'summarization'
  | 'classification'
  | 'gate_review_assist'
  | 'incident_diagnosis'
  | 'memory_distillation'
  | 'general';

export const ALL_SAMPLING_PURPOSES: SamplingPurpose[] = [
  'analysis', 'summarization', 'classification',
  'gate_review_assist', 'incident_diagnosis',
  'memory_distillation', 'general',
];

// ─── Policy Interface ──────────────────────────────────────────────────────

export interface ISamplingPolicy {
  /** Maximum tokens per individual sampling request */
  maxTokensPerRequest: number;
  /** Sliding-window rate limit: max requests per minute */
  maxRequestsPerMinute: number;
  /** Which purposes are allowed (reject anything not listed) */
  allowedPurposes: SamplingPurpose[];
  /** Default context inclusion mode for sampling requests */
  defaultIncludeContext: 'none' | 'thisServer' | 'allServers';
  /** Purposes that trigger MANDATORY gate before sampling executes */
  requireGateForPurposes: SamplingPurpose[];
  /** Rolling hourly token budget cap */
  maxTokenBudgetPerHour: number;
}

// ─── Default Policy ────────────────────────────────────────────────────────

export const DEFAULT_SAMPLING_POLICY: ISamplingPolicy = {
  maxTokensPerRequest: parseInt(process.env.GIA_SAMPLING_MAX_TOKENS || '4096', 10),
  maxRequestsPerMinute: parseInt(process.env.GIA_SAMPLING_RATE_LIMIT || '10', 10),
  allowedPurposes: ALL_SAMPLING_PURPOSES,
  defaultIncludeContext: (process.env.GIA_SAMPLING_CONTEXT as ISamplingPolicy['defaultIncludeContext']) || 'none',
  requireGateForPurposes: ['gate_review_assist'],
  maxTokenBudgetPerHour: parseInt(process.env.GIA_SAMPLING_HOUR_BUDGET || '50000', 10),
};
