/**
 * @module    mcp-tool-map-compliance
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { ComplianceFramework, type IComplianceMapping } from '../../shared/types.js';

const COMPLIANCE_MAPPINGS: IComplianceMapping[] = [
  { framework: ComplianceFramework.NIST_AI_RMF, control: 'GOVERN 1.1', description: 'Legal and regulatory requirements are identified', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_AI_RMF, control: 'GOVERN 1.2', description: 'Trustworthy AI characteristics are integrated into policies', giaComponent: 'GovernanceRoot', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_AI_RMF, control: 'MAP 1.1', description: 'Intended purpose and context of use are defined', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_AI_RMF, control: 'MEASURE 2.1', description: 'AI system is evaluated for performance and trustworthiness', giaComponent: 'GovernanceScorer', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_AI_RMF, control: 'MANAGE 1.1', description: 'AI risks are prioritized, responded to, and managed', giaComponent: 'StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.EU_AI_ACT, control: 'Art. 9', description: 'Risk management system', giaComponent: 'MaiClassifier + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.EU_AI_ACT, control: 'Art. 14', description: 'Human oversight with WebAuthn cryptographic identity verification on MANDATORY gates', giaComponent: 'MaiGate + WebAuthn + Supervisor', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.EU_AI_ACT, control: 'Art. 15', description: 'Accuracy, robustness, cybersecurity', giaComponent: 'GovernanceScorer + SecurityLayer', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.EU_AI_ACT, control: 'Art. 12', description: 'Record-keeping with SHA-256 hash-chained tamper-evident audit trail', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '6.1.2', description: 'AI risk assessment', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '8.4', description: 'AI system operation and monitoring', giaComponent: 'Supervisor + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: 'A.6.2.6', description: 'Data integrity and provenance verification', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_800_53, control: 'AU-2', description: 'Audit events with cryptographic hash chain for tamper evidence', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_800_53, control: 'AU-10', description: 'Non-repudiation via SHA-256 hash-chained append-only ledger', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_800_53, control: 'AC-3', description: 'Access enforcement', giaComponent: 'TierAccessControl', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.NIST_800_53, control: 'IA-5(2)', description: 'PKI-based authentication via WebAuthn/FIDO2 passkeys for MANDATORY gate approvals', giaComponent: 'WebAuthn + MaiGate', status: 'IMPLEMENTED' },

  // ── LINDDUN Privacy Threat Modeling ─────────────────────────────────────────
  { framework: ComplianceFramework.LINDDUN, control: 'L1 — Linking', description: 'Prevent linking data items to reveal identity or behavior patterns', giaComponent: 'Session Isolation + TierAccessControl', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'I1 — Identifying', description: 'Prevent direct identification of individuals from processed data', giaComponent: 'PII Redaction + Data Minimization', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'Nr1 — Non-repudiation', description: 'Ensure actions are attributable and undeniable for accountability', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'D1 — Detecting', description: 'Detect behavioral patterns that may reveal sensitive activities', giaComponent: 'Cerebro Signal Intelligence', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'Dc1 — Disclosure', description: 'Prevent unauthorized exposure of sensitive information', giaComponent: 'aRBAC + GMP Trust Levels', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'U1 — Unawareness', description: 'Ensure data subjects are aware of processing activities', giaComponent: 'Audit Chain + MAI Gate Transparency', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.LINDDUN, control: 'Nc1 — Non-compliance', description: 'Ensure processing complies with privacy regulations and policies', giaComponent: 'ComplianceMapper + Policy Engine', status: 'IMPLEMENTED' },

  // ── MITRE ATLAS AI Threat Modeling ──────────────────────────────────────────
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0015', description: 'Evade ML Model — adversarial inputs crafted to cause misclassification', giaComponent: 'Input Sanitization + SI-10 Validation', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0040', description: 'ML Model Inference API Access — unauthorized use of model inference', giaComponent: 'GovernedLLM Kernel + Budget Gate', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0043', description: 'Craft Adversarial Data — poisoned training/knowledge data injection', giaComponent: 'GMP Hash Sealing + Trust Levels', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0024', description: 'Exfiltration via ML Inference — extract sensitive data through model outputs', giaComponent: 'PII Redaction + Output Boundary', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0042', description: 'Verify Attack — adversary confirms attack success against AI system', giaComponent: 'InternalPenTester + CyberAttackViz', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0048', description: 'Command and Control via AI API — use AI API as covert C2 channel', giaComponent: 'Scope Enforcement + Prohibited Actions', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0025', description: 'Prompt Injection — adversarial prompts to override model instructions', giaComponent: 'Kernel Input Sanitization + SI-10', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.MITRE_ATLAS, control: 'AML.T0051', description: 'LLM Supply Chain Compromise — tampered models or knowledge artifacts', giaComponent: 'Rolling Code Gate + GMP Hash Chain', status: 'IMPLEMENTED' },

  // ── ISO 42001 Expanded Controls ─────────────────────────────────────────────
  { framework: ComplianceFramework.ISO_42001, control: '5.1', description: 'Leadership and commitment to AI management system', giaComponent: 'GovernanceRoot + Contract Templates', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '6.1.1', description: 'Actions to address AI risks and opportunities', giaComponent: 'MaiClassifier + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '7.4', description: 'Communication of AI policies and objectives', giaComponent: 'Reports + Dashboard + Executive Deliverables', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '8.2', description: 'AI risk assessment processes', giaComponent: 'RiskTierAssessment + MaiClassifier', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '9.1', description: 'Monitoring, measurement, analysis, and evaluation', giaComponent: 'ValueMetrics + Cerebro Signal Intelligence', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '9.2', description: 'Internal audit of AI management system', giaComponent: 'ForensicLedger + InternalPenTester', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: '10.1', description: 'Nonconformity and corrective action', giaComponent: 'SRT Pipeline + Postmortem Generation', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.ISO_42001, control: 'A.5.4', description: 'AI system documentation and traceability', giaComponent: 'Phoenix Records + Audit Chain', status: 'IMPLEMENTED' },

  // ── FedRAMP Controls (High baseline — key AI governance anchors) ─────────────
  { framework: ComplianceFramework.FEDRAMP, control: 'AC-2', description: 'Account Management — provisioning, deprovisioning, and audit of user and agent accounts', giaComponent: 'TierAccessControl + ARBAC + User Management', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.FEDRAMP, control: 'AU-2', description: 'Audit Events — cryptographic hash-chained audit trail for all governance events', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.FEDRAMP, control: 'CP-9', description: 'Information System Backup — hash-chained state snapshots every 30 minutes', giaComponent: 'Phoenix Snapshot Engine', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.FEDRAMP, control: 'CP-10', description: 'Information System Recovery — cryptographic integrity verification on reconstitution; ~8s recovery under chaos test', giaComponent: 'Phoenix Recovery + Integrity Verifier', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.FEDRAMP, control: 'IA-2(1)', description: 'Multi-Factor Authentication — MFA enforced for all MANDATORY gate approvals via WebAuthn/FIDO2', giaComponent: 'WebAuthn + MaiGate + ComplianceMode.FEDRAMP', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.FEDRAMP, control: 'SI-4', description: 'Information System Monitoring — real-time signal intelligence, behavioral drift detection, colony pulse', giaComponent: 'Cerebro Signal Intelligence + Colony Monitor', status: 'IMPLEMENTED' },

  // ── OMB M-25-22: Driving Efficient Acquisition of AI in Government ───────────
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 4(a)(i) — Data Non-Use', description: 'Prohibit vendor use of non-public agency data to train publicly available AI without agency consent', giaComponent: 'Knowledge Pack Isolation + Sealed GMP Trust Chain — agency data never exits governed boundary', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 4(a)(ii) — Vendor Accountability', description: 'Agencies must retain testing and evaluation rights over acquired AI systems', giaComponent: 'ForensicLedger + InternalPenTester + Audit Pipeline — queryable evidence of system behavior', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 4(a)(iii) — Transparency', description: 'AI system behavior must be explainable and traceable to acquiring agency', giaComponent: 'Chain of Reasoning + Retrieval Audit Bridge — every governed decision is replayable', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 4(b) — Portability', description: 'Contracts must include data portability and vendor lock-in prevention provisions', giaComponent: 'Export Ledger + Vendor-Agnostic MCP Transport — governance layer is model-independent', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 4(c) — Ongoing Monitoring', description: 'Agencies must maintain ongoing monitoring rights for AI system performance and cost-effectiveness', giaComponent: 'GIA Telemetry + Governance Scoring + ValueMetrics — live queryable governance state', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.OMB_M_25_22, control: 'Sec 5 — Acquisition Risk Management', description: 'Risk management practices applied across AI acquisition lifecycle', giaComponent: 'MaiClassifier + RiskTierAssessment + assess_risk_tier MCP tool', status: 'IMPLEMENTED' },

  // ── HIPAA / HITECH — PHI Governance for Clinical AI ─────────────────────────
  { framework: ComplianceFramework.HIPAA, control: '§164.312(b) — Audit Controls', description: 'Hardware, software, and procedural mechanisms to record and examine activity in systems containing PHI', giaComponent: 'ForensicLedger (hash-chained, append-only, queryable) — NIST AU-2/AU-10 aligned', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.HIPAA, control: '§164.312(a)(1) — Access Control', description: 'Unique user identification, automatic logoff, and encryption for systems handling PHI', giaComponent: 'TierAccessControl + Session Timeout (ComplianceMode) + ARBAC scope enforcement', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.HIPAA, control: '§164.312(e)(2)(i) — PHI Transmission Security', description: 'Guard against unauthorized access to PHI transmitted over electronic communications networks', giaComponent: 'PHI Redaction (piiDetected flag) + Output Boundary + MANDATORY gate on PHI-touching calls', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.HIPAA, control: '§164.306(a)(1) — Data Integrity', description: 'Protect PHI from improper alteration or destruction', giaComponent: 'SHA-256 Hash-Chained Ledger + GMP Trust Levels — tamper-evident record for every governed PHI interaction', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.HIPAA, control: '§164.308(a)(1)(ii)(D) — Activity Review', description: 'Implement procedures to regularly review records of information system activity', giaComponent: 'Audit Pipeline + Cerebro Signal Intelligence + Anomaly Detection', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.HIPAA, control: '§164.308(a)(5)(ii)(B) — Malicious Software Protection', description: 'Guard against malicious software including adversarial AI inputs and prompt injection', giaComponent: 'Kernel Input Sanitization + MITRE ATLAS AML.T0025 (Prompt Injection) mitigation', status: 'IMPLEMENTED' },

  // ── VHA Trustworthy AI — Six Principles ─────────────────────────────────────
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 1 — Purposeful', description: 'AI is used for a defined, mission-aligned purpose with explicit scope boundaries', giaComponent: 'Charter + Contract Templates — every agent operates under a defined scope contract', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 2 — Effective', description: 'AI performs as intended and delivers measurable, documented value', giaComponent: 'GovernanceScorer + ValueMetrics + record_value_metric MCP tool', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 3 — Safe', description: 'AI does not harm patients, staff, or clinical operations — high-risk actions are gated', giaComponent: 'MAI MANDATORY Gates + PHI Detection (piiDetected) + Human-in-the-loop approval flow', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 4 — Secure', description: 'AI is protected from misuse, adversarial manipulation, and unauthorized access', giaComponent: 'ARBAC + GovernedLLM Kernel + MITRE ATLAS coverage (8 attack vectors) + Rolling Code Gate', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 5 — Understandable', description: 'AI decisions can be explained, traced, and reviewed by clinical and oversight teams', giaComponent: 'Chain of Reasoning + Retrieval Audit Bridge — every decision is replayable with full provenance', status: 'IMPLEMENTED' },
  { framework: ComplianceFramework.VHA_TRUSTWORTHY_AI, control: 'Principle 6 — Equitable', description: 'AI does not perpetuate bias; drift and anomalous patterns are detected and routed to oversight', giaComponent: 'Cerebro Signal Intelligence + Disposition Monitor + colony_health drift detection', status: 'IMPLEMENTED' },
];

// --- Public accessor for HTTP dashboard endpoints ---
export function getComplianceMappings(framework?: string): IComplianceMapping[] {
  if (!framework || framework === 'ALL') return [...COMPLIANCE_MAPPINGS];
  return COMPLIANCE_MAPPINGS.filter(m => m.framework === framework);
}

export function registerMapComplianceTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'map_compliance',
    'Map GIA governance components to regulatory compliance frameworks (NIST AI RMF, EU AI Act, ISO 42001, NIST 800-53, FedRAMP, LINDDUN, MITRE ATLAS, OMB M-25-22, HIPAA, VHA Trustworthy AI). Shows which controls are implemented across 10 frameworks and 63 controls.',
    {
      framework: z.enum(['NIST_AI_RMF', 'EU_AI_ACT', 'ISO_42001', 'NIST_800_53', 'FEDRAMP', 'LINDDUN', 'MITRE_ATLAS', 'OMB_M_25_22', 'HIPAA', 'VHA_TRUSTWORTHY_AI', 'ALL']).describe('Compliance framework to map'),
    },
    { title: 'Map Compliance Framework', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const filtered = input.framework === 'ALL'
        ? COMPLIANCE_MAPPINGS
        : COMPLIANCE_MAPPINGS.filter(m => m.framework === input.framework);

      const implemented = filtered.filter(m => m.status === 'IMPLEMENTED').length;

      // Tool accountability tracking
      engine.telemetryService.emitToolCall('map_compliance', `compliance-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          framework: input.framework,
          totalControls: filtered.length,
          implemented,
          coverage: `${((implemented / filtered.length) * 100).toFixed(0)}%`,
          mappings: filtered,
        }, null, 2) }],
      };
    }
  );
}
