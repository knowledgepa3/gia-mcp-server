/**
 * @module    mcp-resources
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — resource registration, not a governed operation
 * @audit     false — read-only resources
 * @owner     William J. Storey III / ACE / GIA
 *
 * MCP Resources — expose governance specifications and system state as
 * readable resources for MCP clients. Resources are read-only and do NOT
 * contain business logic (transport layer).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GovernanceEngine } from '../../core/governance.js';
import { registerUIAppResources } from './ui-apps.js';
import { GIA_VERSION, GIA_AUTHOR, GIA_DESCRIPTION } from '../../shared/constants.js';
import {
  STOREY_THRESHOLD_MIN, STOREY_THRESHOLD_MAX,
  DEFAULT_SCORE_WEIGHTS, MIN_COMPOSITE_SCORE, SCORE_HALT_THRESHOLD,
} from '../../shared/constants.js';

export function registerResources(server: McpServer, engine: GovernanceEngine): void {
  // Register MCP App UI resources (interactive HTML rendered in Claude.ai)
  registerUIAppResources(server);

  // ────────────────────────────────────────────────────
  // Resource: MAI Framework Specification
  // ────────────────────────────────────────────────────
  server.resource(
    'mai-specification',
    'gia://spec/mai-framework',
    { description: 'MAI Framework (Mandatory/Advisory/Informational) specification and classification rules.' },
    async () => ({
      contents: [{
        uri: 'gia://spec/mai-framework',
        mimeType: 'application/json',
        text: JSON.stringify({
          framework: 'MAI — Mandatory / Advisory / Informational',
          version: GIA_VERSION,
          author: GIA_AUTHOR,
          classifications: {
            MANDATORY: {
              description: 'Requires explicit human approval before proceeding.',
              gateRequired: true,
              auditLevel: 'FULL',
              examples: ['Final client deliverables', 'Legal assertions', 'Financial decisions'],
            },
            ADVISORY: {
              description: 'Pauses for review, auto-continues after timeout.',
              gateRequired: true,
              auditLevel: 'STANDARD',
              examples: ['Draft recommendations', 'Internal analysis', 'Data transformations'],
            },
            INFORMATIONAL: {
              description: 'Executes and logs. No gate required.',
              gateRequired: false,
              auditLevel: 'LIGHT',
              examples: ['Status checks', 'Logging', 'Internal routing'],
            },
          },
          rules: [
            'Every decision MUST be classified before execution.',
            'Context elevates classification. Context NEVER reduces classification.',
            'PII detection elevates to MANDATORY minimum.',
            'Client-facing outputs elevate to ADVISORY minimum.',
            'Auto-run mode changes gate behavior, NOT classification.',
          ],
          priority: 'MANDATORY > ADVISORY > INFORMATIONAL',
        }, null, 2),
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Resource: Storey Threshold Specification
  // ────────────────────────────────────────────────────
  server.resource(
    'threshold-specification',
    'gia://spec/storey-threshold',
    { description: 'Storey Threshold quantitative governance health metric specification.' },
    async () => ({
      contents: [{
        uri: 'gia://spec/storey-threshold',
        mimeType: 'application/json',
        text: JSON.stringify({
          metric: 'Storey Threshold',
          description: 'Quantitative measure of governance health based on escalation rate.',
          version: GIA_VERSION,
          author: GIA_AUTHOR,
          healthyBand: { min: STOREY_THRESHOLD_MIN, max: STOREY_THRESHOLD_MAX },
          statuses: {
            HEALTHY: `Escalation rate between ${STOREY_THRESHOLD_MIN * 100}% and ${STOREY_THRESHOLD_MAX * 100}%.`,
            LOW_ESCALATION: `Below ${STOREY_THRESHOLD_MIN * 100}%. System may be under-classifying risk.`,
            HIGH_ESCALATION: `Above ${STOREY_THRESHOLD_MAX * 100}%. System may be over-classifying, causing friction.`,
            CRITICAL: 'Below 5% or above 25%. Immediate investigation required.',
            INSUFFICIENT_DATA: 'Not enough decisions to compute a reliable rate.',
          },
          interpretation: 'A healthy system naturally escalates 10-18% of decisions to MANDATORY. Too low means risks are being missed. Too high means the system is creating unnecessary friction.',
        }, null, 2),
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Resource: Governance Scoring Specification
  // ────────────────────────────────────────────────────
  server.resource(
    'scoring-specification',
    'gia://spec/governance-scoring',
    { description: 'Three-dimensional governance scoring specification (Integrity, Accuracy, Compliance).' },
    async () => ({
      contents: [{
        uri: 'gia://spec/governance-scoring',
        mimeType: 'application/json',
        text: JSON.stringify({
          system: 'Governance Scoring Engine',
          version: GIA_VERSION,
          dimensions: {
            integrity: { weight: DEFAULT_SCORE_WEIGHTS.integrity, description: 'Data integrity and consistency.' },
            accuracy: { weight: DEFAULT_SCORE_WEIGHTS.accuracy, description: 'Factual accuracy of output.' },
            compliance: { weight: DEFAULT_SCORE_WEIGHTS.compliance, description: 'Regulatory and policy compliance.' },
          },
          thresholds: {
            minimumRelease: MIN_COMPOSITE_SCORE,
            haltThreshold: SCORE_HALT_THRESHOLD,
          },
          rules: [
            'Every agent output is scored before release.',
            `Composite score below ${SCORE_HALT_THRESHOLD} triggers supervisor HALT.`,
            `Composite score below ${MIN_COMPOSITE_SCORE} fails release threshold.`,
            'Scoring dimensions are weighted: Integrity 40%, Accuracy 35%, Compliance 25%.',
          ],
        }, null, 2),
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Resource: Live System Status (dynamic)
  // ────────────────────────────────────────────────────
  server.resource(
    'system-status',
    'gia://status/live',
    { description: 'Live GIA system status including engine health, threshold, and telemetry.' },
    async () => ({
      contents: [{
        uri: 'gia://status/live',
        mimeType: 'application/json',
        text: JSON.stringify({
          description: GIA_DESCRIPTION,
          version: GIA_VERSION,
          ...engine.getStatus(),
        }, null, 2),
      }],
    })
  );

  // ────────────────────────────────────────────────────
  // Resource: Architecture Guide
  // ────────────────────────────────────────────────────
  server.resource(
    'architecture-guide',
    'gia://spec/architecture',
    { description: 'GIA system architecture and governance inheritance chain.' },
    async () => ({
      contents: [{
        uri: 'gia://spec/architecture',
        mimeType: 'text/plain',
        text: [
          'GIA ARCHITECTURE — GOVERNANCE INHERITANCE CHAIN',
          '================================================',
          '',
          'Layer 1: GOVERNANCE (GovernanceRoot)',
          '  └── ForensicLedger: append-only audit log',
          '  └── MaiClassifier: decision classification engine',
          '  └── MaiGate: gate enforcement (Mandatory/Advisory/Informational)',
          '  └── GovernanceScorer: output quality scoring (Integrity/Accuracy/Compliance)',
          '  └── StoreyThresholdMonitor: escalation rate health metric',
          '  └── Supervisor: agent monitoring and repair',
          '',
          'Layer 2: APPLICATION (Verticals)',
          '  └── ACE (VA Claims Evidence Analysis)',
          '  └── Legal, Healthcare, Finance, Federal (planned)',
          '  └── All verticals inherit from GovernanceRoot',
          '',
          'Layer 3: TRANSPORT (MCP Server)',
          '  └── Tools: thin wrappers delegating to CORE',
          '  └── Resources: read-only specifications and status',
          '  └── Prompts: guided workflow templates',
          '  └── ZERO business logic in transport layer',
          '',
          'RULE: If you trace any module upward and it does not',
          'terminate at GovernanceRoot, the code is broken.',
        ].join('\n'),
      }],
    })
  );
}
