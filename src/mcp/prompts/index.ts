/**
 * @module    mcp-prompts
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — prompt registration, not a governed operation
 * @audit     false — prompts are templates, execution is governed separately
 * @owner     William J. Storey III / ACE / GIA
 *
 * MCP Prompts — guided workflow templates for governance operations.
 * These provide structured entry points for common GIA workflows.
 * Prompts do NOT contain business logic (transport layer).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';

export function registerPrompts(server: McpServer, engine: GovernanceEngine): void {

  // ────────────────────────────────────────────────────
  // Prompt: /gia-assess — Governance Assessment
  // ────────────────────────────────────────────────────
  server.prompt(
    'gia-assess',
    'Perform a governance assessment on an AI system or operation. Walks through risk tier, MAI classification, scoring criteria, and compliance mapping.',
    {
      system_description: z.string().describe('Description of the AI system or operation to assess'),
      domain: z.string().default('general').describe('Industry domain (va-claims, legal, healthcare, finance, federal, general)'),
    },
    async (input) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Perform a GIA governance assessment for the following system:`,
            ``,
            `System: ${input.system_description}`,
            `Domain: ${input.domain}`,
            ``,
            `Please complete these steps:`,
            `1. Use assess_risk_tier to determine the EU AI Act risk tier.`,
            `2. Use classify_decision to classify a representative decision from this system.`,
            `3. Use map_compliance with framework=ALL to show current compliance coverage.`,
            `4. Use evaluate_threshold to check governance health.`,
            `5. Summarize findings with specific recommendations for governance configuration.`,
          ].join('\n'),
        },
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Prompt: /gia-design-gate — Design Gate Strategy
  // ────────────────────────────────────────────────────
  server.prompt(
    'gia-design-gate',
    'Design a MAI gate strategy for an AI agent pipeline. Recommends classification levels and gate enforcement for each stage.',
    {
      pipeline_description: z.string().describe('Description of the agent pipeline stages'),
      is_client_facing: z.boolean().default(false).describe('Whether pipeline produces client-facing output'),
      has_pii: z.boolean().default(false).describe('Whether pipeline handles PII'),
    },
    async (input) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Design a MAI gate strategy for this pipeline:`,
            ``,
            `Pipeline: ${input.pipeline_description}`,
            `Client-facing: ${input.is_client_facing}`,
            `Handles PII: ${input.has_pii}`,
            ``,
            `For each pipeline stage, recommend:`,
            `- MAI classification level (MANDATORY/ADVISORY/INFORMATIONAL)`,
            `- Whether a gate is required`,
            `- Scoring criteria priorities (Integrity/Accuracy/Compliance weighting)`,
            `- Supervisor thresholds (max repair attempts, halt conditions)`,
            ``,
            `Use classify_decision for representative decisions at each stage.`,
            `Use evaluate_threshold to confirm the resulting escalation rate stays healthy (5-35%).`,
          ].join('\n'),
        },
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Prompt: /gia-compliance-report — Generate Compliance Report
  // ────────────────────────────────────────────────────
  server.prompt(
    'gia-compliance-report',
    'Generate a comprehensive compliance report mapping GIA governance to regulatory frameworks.',
    {
      framework: z.enum(['NIST_AI_RMF', 'EU_AI_ACT', 'ISO_42001', 'NIST_800_53', 'ALL']).default('ALL').describe('Target compliance framework'),
      format: z.enum(['summary', 'detailed', 'executive']).default('detailed').describe('Report format'),
    },
    async (input) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Generate a ${input.format} GIA compliance report for framework: ${input.framework}`,
            ``,
            `Steps:`,
            `1. Use map_compliance with framework=${input.framework} to get control mappings.`,
            `2. Use generate_report with format=${input.format} for current operational metrics.`,
            `3. Use evaluate_threshold for governance health context.`,
            `4. Use system_status for system overview.`,
            `5. Produce a formatted compliance report showing:`,
            `   - Framework requirements and GIA control mappings`,
            `   - Implementation status for each control`,
            `   - Current governance health metrics`,
            `   - Gaps and remediation recommendations`,
            `   - Executive summary (if detailed or executive format)`,
          ].join('\n'),
        },
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Prompt: /gia-health-check — System Health Check
  // ────────────────────────────────────────────────────
  server.prompt(
    'gia-health-check',
    'Run a full GIA system health check covering threshold, agents, and audit integrity.',
    {},
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Run a full GIA system health check:`,
            ``,
            `1. Use system_status to get overall system state.`,
            `2. Use evaluate_threshold to assess governance health metric.`,
            `3. Use monitor_agents to check agent health and failure rates.`,
            `4. Use audit_pipeline to review recent audit entries for anomalies.`,
            `5. Summarize: Is the system healthy? Any agents in trouble? Any threshold drift?`,
          ].join('\n'),
        },
      }],
    })
  );
}
