/**
 * @module    mcp-tool-governed-sampling
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       A — sampling requests are ADVISORY baseline, context-elevated
 * @audit     true — every sampling request writes to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * governed_sample — Client-Mediated Governed Cognition
 *
 * This tool lets operators and agents request LLM completions through MCP
 * Sampling, where the CLIENT (not the server) performs the model invocation.
 *
 * The server never touches API keys. The client handles auth. GIA governs
 * the request: classify, gate, budget, audit. The model call is a governed
 * service request, not a hardcoded dependency.
 *
 * "GIA can govern sampled cognition the same way it governs tool execution:
 *  authority, context, vendor allowance, budget, audit trail, and downstream
 *  action control."
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { ALL_SAMPLING_PURPOSES } from '../../core/sampling/index.js';
import { GovernedError } from '../../shared/errors.js';

export function registerGovernedSamplingTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'governed_sample',
    'Request a governed LLM completion via MCP Sampling. The client performs the model call — the server governs when, how, and under what constraints sampling is allowed. Every request is classified, policy-checked, optionally gated, and recorded in the forensic ledger.',
    {
      purpose: z.enum(ALL_SAMPLING_PURPOSES as [string, ...string[]]).describe(
        'Why this sampling is happening. Determines MAI classification. gate_review_assist triggers MANDATORY gate.'
      ),
      prompt: z.string().min(1).max(50_000).describe('The prompt / question to send to the model'),
      system_prompt: z.string().max(10_000).optional().describe('Optional system prompt for the sampling request'),
      context: z.string().max(50_000).optional().describe('Additional context prepended to the prompt'),
      max_tokens: z.number().int().min(1).max(8192).default(2048).describe('Maximum tokens for the response'),
      include_context: z.enum(['none', 'thisServer', 'allServers']).default('none').describe(
        'Context inclusion mode. "none" (default) minimizes exposure. "thisServer" includes this MCP server context.'
      ),
      domain: z.enum(['va-claims', 'legal', 'healthcare', 'finance', 'federal', 'general']).default('general').describe('Domain context for MAI classification'),
      agent_name: z.string().max(100).optional().describe('Agent requesting the sample'),
    },
    {
      title: 'Governed Sampling (Client-Mediated Cognition)',
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (input) => {
      // Check if sampling is available
      if (!engine.hasSampling()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'SAMPLING_NOT_AVAILABLE',
            message: 'Governed Sampling is not initialized. The connected client may not support MCP Sampling.',
            hint: 'Ensure your client (Claude Desktop, Claude Code) supports the sampling capability.',
          }, null, 2) }],
          isError: true,
        };
      }

      try {
        // Build the full prompt with optional context
        const fullPrompt = input.context
          ? `${input.context}\n\n---\n\n${input.prompt}`
          : input.prompt;

        const result = await engine.sampling.sample({
          purpose: input.purpose as (typeof ALL_SAMPLING_PURPOSES)[number],
          systemPrompt: input.system_prompt || 'You are a governed AI assistant. Provide clear, accurate, and concise responses.',
          messages: [{ role: 'user', content: fullPrompt }],
          maxTokens: input.max_tokens,
          includeContext: input.include_context as 'none' | 'thisServer' | 'allServers',
          domain: input.domain,
          agentName: input.agent_name,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            content: result.content,
            model: result.model,
            stopReason: result.stopReason,
            tokensUsed: result.tokensUsed,
            governance: {
              auditId: result.auditId,
              classification: result.classification.classification,
              confidence: result.classification.confidence,
              rationale: result.classification.rationale,
              gateEnforced: !!result.gateDecision,
              gateStatus: result.gateDecision?.status,
              scored: result.score.scored,
              // Sampling never independently measures the model's output, so the
              // score is an explicit NOT-SCORED sentinel — surface that honestly
              // rather than dumping the -1 sentinel as if it were a real number.
              ...(result.score.scored
                ? {
                    compositeScore: result.score.composite,
                    integrity: result.score.integrity,
                    accuracy: result.score.accuracy,
                    compliance: result.score.compliance,
                  }
                : {
                    scoreBasis:
                      'NOT independently scored — model output is not measured for accuracy. Transport integrity is attested out-of-band via contentHash.',
                  }),
            },
          }, null, 2) }],
        };
      } catch (error: unknown) {
        if (error instanceof GovernedError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(error.toPublicResponse(), null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'SAMPLING_FAILED',
            message: error instanceof Error ? error.message : 'Unknown sampling error',
          }, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
