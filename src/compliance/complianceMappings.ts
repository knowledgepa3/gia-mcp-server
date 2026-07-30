/**
 * @module    compliance-mappings
 * @layer     COMPLIANCE
 * @inherits  governance-root
 * @mai       N/A — static design-mapping reference data (no agent actions)
 * @audit     false — read-only data; consumers audit their own access
 * @owner     William J. Storey III / ACE / GIA
 *
 * ⚠ VENDORED SINGLE SOURCE (same discipline as canonicalV2.ts). This exact file
 * exists at BOTH paths:
 *     gia-mcp-server/src/compliance/complianceMappings.ts
 *     server/src/compliance/complianceMappings.ts
 * The two deployables cannot import each other, so the file is vendored and a CI
 * test asserts the copies are BYTE-IDENTICAL
 * (gia-mcp-server/tests/compliance/compliance-mappings-vendor-parity.test.ts).
 * Edit one copy → copy it to the other VERBATIM → run both suites.
 * This file is deliberately self-contained (zero imports) so byte-identity holds
 * across the ESM (gia-mcp-server) and CJS (server) builds.
 *
 * WHY VENDORED (2026-07-02): the Express route had manually forked this table and
 * drifted to a different control set (45 vs 63) with none of the M12 honesty
 * framing — two surfaces gave two different answers to "what is GIA's compliance
 * map," one of which read as certified 100% coverage. Divergence is the failure
 * mode; byte-identity is the control.
 *
 * HONESTY CONTRACT (M12, 2026-06-18 — binds EVERY consumer of this data):
 * This is a DESIGN MAPPING — each row asserts that a GIA component is *intended
 * to address* a control. `status: 'IMPLEMENTED'` means the component EXISTS and
 * is mapped; `'PARTIAL'` means the component exists but the control's described
 * behavior is config-gated, incomplete, or presence-checked rather than proven.
 * NO status asserts third-party certification or measured runtime enforcement.
 * Runtime-evidenced coverage requires a ControlBinding with a live evidence query
 * (docs/superpowers/specs/2026-06-18-control-binding-runtime-compliance-design.md).
 * Evidence-bound controls today: 0 (the ControlBinding layer is post-QA-B).
 * Every surface serving this data MUST carry MAPPING_DISCLAIMER and
 * mappingType: 'design-mapping'.
 */

export type ComplianceFrameworkId =
  | 'NIST_800_53'
  | 'NIST_AI_RMF'
  | 'EU_AI_ACT'
  | 'ISO_42001'
  | 'FEDRAMP'
  | 'LINDDUN'
  | 'MITRE_ATLAS'
  | 'OMB_M_25_22'
  | 'HIPAA'
  | 'VHA_TRUSTWORTHY_AI';

export type ComplianceMappingStatus = 'IMPLEMENTED' | 'PARTIAL' | 'PLANNED';

export interface IComplianceMappingRow {
  framework: ComplianceFrameworkId;
  control: string;
  description: string;
  giaComponent: string;
  status: ComplianceMappingStatus;
}

export interface IFrameworkMeta {
  label: string;
  fullName: string;
  category: string;
}

export const MAPPING_DISCLAIMER =
  'DESIGN MAPPING — GIA components mapped to control intent. NOT third-party certification ' +
  'and NOT measured runtime enforcement. Runtime-evidenced coverage requires a ControlBinding ' +
  '(see 2026-06-18 control-binding spec). Evidence-bound controls today: 0.';

export const FRAMEWORK_META: Record<ComplianceFrameworkId, IFrameworkMeta> = {
  EU_AI_ACT:          { label: 'EU AI Act', fullName: 'European Union Artificial Intelligence Act (2024/1689)', category: 'Regulation' },
  NIST_800_53:        { label: 'NIST 800-53', fullName: 'NIST SP 800-53 Rev. 5 — Security and Privacy Controls', category: 'Framework' },
  NIST_AI_RMF:        { label: 'NIST AI RMF', fullName: 'NIST AI Risk Management Framework 1.0', category: 'Framework' },
  ISO_42001:          { label: 'ISO 42001', fullName: 'ISO/IEC 42001:2023 — AI Management System', category: 'Standard' },
  FEDRAMP:            { label: 'FedRAMP', fullName: 'FedRAMP High Baseline — key AI governance control anchors', category: 'Framework' },
  LINDDUN:            { label: 'LINDDUN', fullName: 'LINDDUN Privacy Threat Modeling Framework', category: 'Methodology' },
  MITRE_ATLAS:        { label: 'MITRE ATLAS', fullName: 'MITRE ATLAS — Adversarial Threat Landscape for AI Systems', category: 'Threat Model' },
  OMB_M_25_22:        { label: 'OMB M-25-22', fullName: 'OMB Memorandum M-25-22 — Driving Efficient Acquisition of AI in Government', category: 'Policy' },
  HIPAA:              { label: 'HIPAA', fullName: 'HIPAA Security Rule (45 CFR Part 164) — PHI Governance for Clinical AI', category: 'Regulation' },
  VHA_TRUSTWORTHY_AI: { label: 'VHA Trustworthy AI', fullName: 'VHA Trustworthy AI Framework — Six Principles', category: 'Framework' },
};

/**
 * The canonical cross-framework design-mapping table.
 *
 * ROW HONESTY RULES (enforced by review + the data-honesty pins in the vendor
 * parity test — keep them true when editing):
 *  - No cadence, latency, or benchmark figure unless the code demonstrably
 *    produces it (no "every 30 minutes", no "~8s under chaos test").
 *  - Enforcement that is config-gated and OFF by default is described as such
 *    and carries status 'PARTIAL' when the control text implies enforcement.
 *  - Presence-checks are named presence-checks (InternalPenTester probes are
 *    deterministic control-presence checks, not adversarial breach simulation).
 */
export const COMPLIANCE_MAPPINGS: IComplianceMappingRow[] = [
  // ── NIST AI RMF ─────────────────────────────────────────────────────────────
  { framework: 'NIST_AI_RMF', control: 'GOVERN 1.1', description: 'Legal and regulatory requirements are identified', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: 'NIST_AI_RMF', control: 'GOVERN 1.2', description: 'Trustworthy AI characteristics are integrated into policies', giaComponent: 'GovernanceRoot', status: 'IMPLEMENTED' },
  { framework: 'NIST_AI_RMF', control: 'MAP 1.1', description: 'Intended purpose and context of use are defined', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: 'NIST_AI_RMF', control: 'MEASURE 2.1', description: 'AI system is evaluated for performance and trustworthiness', giaComponent: 'GovernanceScorer', status: 'IMPLEMENTED' },
  { framework: 'NIST_AI_RMF', control: 'MANAGE 1.1', description: 'AI risks are prioritized, responded to, and managed', giaComponent: 'StoreyThreshold', status: 'IMPLEMENTED' },

  // ── EU AI Act ───────────────────────────────────────────────────────────────
  { framework: 'EU_AI_ACT', control: 'Art. 9', description: 'Risk management system', giaComponent: 'MaiClassifier + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 10', description: 'Data and data governance', giaComponent: 'GMP Hash Sealing + Trust Levels', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 11', description: 'Technical documentation', giaComponent: 'EU AI Act Technical Documentation Generator', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 12', description: 'Record-keeping with SHA-256 hash-chained tamper-evident audit trail', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 13', description: 'Transparency and provision of information to deployers', giaComponent: 'Audit Chain + MAI Gate Transparency', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 14', description: 'Human oversight — MANDATORY gates block until a human decision; WebAuthn passkey verification available (enforcement config-gated, default off)', giaComponent: 'MaiGate + Supervisor (+ WebAuthn, config-gated)', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 15', description: 'Accuracy, robustness, cybersecurity', giaComponent: 'GovernanceScorer + SecurityLayer', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 27', description: 'Fundamental rights impact assessment for deployers', giaComponent: 'FRIA Assessment Engine', status: 'IMPLEMENTED' },
  { framework: 'EU_AI_ACT', control: 'Art. 60', description: 'EU database for high-risk AI systems', giaComponent: 'AI System Registry', status: 'IMPLEMENTED' },

  // ── ISO 42001 ───────────────────────────────────────────────────────────────
  { framework: 'ISO_42001', control: '5.1', description: 'Leadership and commitment to AI management system', giaComponent: 'GovernanceRoot + Contract Templates', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '6.1.1', description: 'Actions to address AI risks and opportunities', giaComponent: 'MaiClassifier + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '6.1.2', description: 'AI risk assessment', giaComponent: 'MaiClassifier', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '7.4', description: 'Communication of AI policies and objectives', giaComponent: 'Reports + Dashboard + Executive Deliverables', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '8.2', description: 'AI risk assessment processes', giaComponent: 'RiskTierAssessment + MaiClassifier', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '8.4', description: 'AI system operation and monitoring', giaComponent: 'Supervisor + StoreyThreshold', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '9.1', description: 'Monitoring, measurement, analysis, and evaluation', giaComponent: 'ValueMetrics + Cerebro Signal Intelligence', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '9.2', description: 'Internal audit of AI management system', giaComponent: 'ForensicLedger + InternalPenTester (deterministic control-presence probes)', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: '10.1', description: 'Nonconformity and corrective action', giaComponent: 'SRT Pipeline + Postmortem Generation', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: 'A.5.4', description: 'AI system documentation and traceability', giaComponent: 'Phoenix Records + Audit Chain', status: 'IMPLEMENTED' },
  { framework: 'ISO_42001', control: 'A.6.2.6', description: 'Data integrity and provenance verification', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },

  // ── NIST 800-53 ─────────────────────────────────────────────────────────────
  { framework: 'NIST_800_53', control: 'AC-3', description: 'Access enforcement', giaComponent: 'TierAccessControl', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'AU-2', description: 'Audit events with cryptographic hash chain for tamper evidence', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'AU-10', description: 'Non-repudiation via SHA-256 hash-chained append-only ledger', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'IA-5(2)', description: 'WebAuthn/FIDO2 passkey authentication implemented; passkey requirement on MANDATORY gate approvals is config-gated (default off)', giaComponent: 'WebAuthn + MaiGate', status: 'PARTIAL' },
  { framework: 'NIST_800_53', control: 'CP-2', description: 'Contingency planning', giaComponent: 'Phoenix Recovery + SRT Pipeline', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'CP-9', description: 'System backup', giaComponent: 'Phoenix Snapshots (on-demand)', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'IR-4', description: 'Incident handling', giaComponent: 'SRT Incident Manager + Playbooks', status: 'IMPLEMENTED' },
  { framework: 'NIST_800_53', control: 'SA-12', description: 'Supply chain protection', giaComponent: 'Rolling Code Gate + GMP Hash Chain', status: 'IMPLEMENTED' },

  // ── LINDDUN Privacy Threat Modeling ─────────────────────────────────────────
  { framework: 'LINDDUN', control: 'L1 — Linking', description: 'Prevent linking data items to reveal identity or behavior patterns', giaComponent: 'Session Isolation + TierAccessControl', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'I1 — Identifying', description: 'Prevent direct identification of individuals from processed data', giaComponent: 'PII Redaction + Data Minimization', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'Nr1 — Non-repudiation', description: 'Ensure actions are attributable and undeniable for accountability', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'D1 — Detecting', description: 'Detect behavioral patterns that may reveal sensitive activities', giaComponent: 'Cerebro Signal Intelligence', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'Dc1 — Disclosure', description: 'Prevent unauthorized exposure of sensitive information', giaComponent: 'aRBAC + GMP Trust Levels', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'U1 — Unawareness', description: 'Ensure data subjects are aware of processing activities', giaComponent: 'Audit Chain + MAI Gate Transparency', status: 'IMPLEMENTED' },
  { framework: 'LINDDUN', control: 'Nc1 — Non-compliance', description: 'Ensure processing complies with privacy regulations and policies', giaComponent: 'ComplianceMapper + Policy Engine', status: 'IMPLEMENTED' },

  // ── MITRE ATLAS AI Threat Modeling ──────────────────────────────────────────
  { framework: 'MITRE_ATLAS', control: 'AML.T0015', description: 'Evade ML Model — adversarial inputs crafted to cause misclassification', giaComponent: 'Input Sanitization + SI-10 Validation', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0040', description: 'ML Model Inference API Access — unauthorized use of model inference', giaComponent: 'GovernedLLM Kernel + Budget Gate', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0043', description: 'Craft Adversarial Data — poisoned training/knowledge data injection', giaComponent: 'GMP Hash Sealing + Trust Levels', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0024', description: 'Exfiltration via ML Inference — extract sensitive data through model outputs', giaComponent: 'PII Redaction + Output Boundary', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0042', description: 'Verify Attack — adversary confirms attack success against AI system', giaComponent: 'InternalPenTester (deterministic control-presence probes — not adversarial breach simulation)', status: 'PARTIAL' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0048', description: 'Command and Control via AI API — use AI API as covert C2 channel', giaComponent: 'Scope Enforcement + Prohibited Actions', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0025', description: 'Prompt Injection — adversarial prompts to override model instructions', giaComponent: 'Kernel Input Sanitization + SI-10', status: 'IMPLEMENTED' },
  { framework: 'MITRE_ATLAS', control: 'AML.T0051', description: 'LLM Supply Chain Compromise — tampered models or knowledge artifacts', giaComponent: 'Rolling Code Gate + GMP Hash Chain', status: 'IMPLEMENTED' },

  // ── FedRAMP Controls (High baseline — key AI governance anchors) ─────────────
  { framework: 'FEDRAMP', control: 'AC-2', description: 'Account Management — provisioning, deprovisioning, and audit of user and agent accounts', giaComponent: 'TierAccessControl + ARBAC + User Management', status: 'IMPLEMENTED' },
  { framework: 'FEDRAMP', control: 'AU-2', description: 'Audit Events — cryptographic hash-chained audit trail for all governance events', giaComponent: 'ForensicLedger (hash-chained)', status: 'IMPLEMENTED' },
  { framework: 'FEDRAMP', control: 'CP-9', description: 'Information System Backup — hash-chained state snapshots (on-demand via phoenix_snapshot; no fixed cadence)', giaComponent: 'Phoenix Snapshot Engine', status: 'IMPLEMENTED' },
  { framework: 'FEDRAMP', control: 'CP-10', description: 'Information System Recovery — integrity verification on reconstitution (phoenix_verify_integrity)', giaComponent: 'Phoenix Recovery + Integrity Verifier', status: 'IMPLEMENTED' },
  { framework: 'FEDRAMP', control: 'IA-2(1)', description: 'Multi-Factor Authentication — WebAuthn/FIDO2 available for MANDATORY gate approvals; enforcement config-gated (default off), not enforced by default', giaComponent: 'WebAuthn + MaiGate', status: 'PARTIAL' },
  { framework: 'FEDRAMP', control: 'SI-4', description: 'Information System Monitoring — real-time signal intelligence, behavioral drift detection, colony pulse', giaComponent: 'Cerebro Signal Intelligence + Colony Monitor', status: 'IMPLEMENTED' },

  // ── OMB M-25-22: Driving Efficient Acquisition of AI in Government ───────────
  { framework: 'OMB_M_25_22', control: 'Sec 4(a)(i) — Data Non-Use', description: 'Prohibit vendor use of non-public agency data to train publicly available AI without agency consent', giaComponent: 'Knowledge Pack Isolation + Sealed GMP Trust Chain — agency data never exits governed boundary', status: 'IMPLEMENTED' },
  { framework: 'OMB_M_25_22', control: 'Sec 4(a)(ii) — Vendor Accountability', description: 'Agencies must retain testing and evaluation rights over acquired AI systems', giaComponent: 'ForensicLedger + InternalPenTester (control-presence probes) + Audit Pipeline — queryable evidence of system behavior', status: 'IMPLEMENTED' },
  { framework: 'OMB_M_25_22', control: 'Sec 4(a)(iii) — Transparency', description: 'AI system behavior must be explainable and traceable to acquiring agency', giaComponent: 'Chain of Reasoning + Retrieval Audit Bridge — every governed decision is replayable', status: 'IMPLEMENTED' },
  { framework: 'OMB_M_25_22', control: 'Sec 4(b) — Portability', description: 'Contracts must include data portability and vendor lock-in prevention provisions', giaComponent: 'Export Ledger + Vendor-Agnostic MCP Transport — governance layer is model-independent', status: 'IMPLEMENTED' },
  { framework: 'OMB_M_25_22', control: 'Sec 4(c) — Ongoing Monitoring', description: 'Agencies must maintain ongoing monitoring rights for AI system performance and cost-effectiveness', giaComponent: 'GIA Telemetry + Governance Scoring + ValueMetrics — live queryable governance state', status: 'IMPLEMENTED' },
  { framework: 'OMB_M_25_22', control: 'Sec 5 — Acquisition Risk Management', description: 'Risk management practices applied across AI acquisition lifecycle', giaComponent: 'MaiClassifier + RiskTierAssessment + assess_risk_tier MCP tool', status: 'IMPLEMENTED' },

  // ── HIPAA / HITECH — PHI Governance for Clinical AI ─────────────────────────
  { framework: 'HIPAA', control: '§164.312(b) — Audit Controls', description: 'Hardware, software, and procedural mechanisms to record and examine activity in systems containing PHI', giaComponent: 'ForensicLedger (hash-chained, append-only, queryable) — NIST AU-2/AU-10 aligned', status: 'IMPLEMENTED' },
  { framework: 'HIPAA', control: '§164.312(a)(1) — Access Control', description: 'Unique user identification, automatic logoff, and encryption for systems handling PHI', giaComponent: 'TierAccessControl + Session Timeout (ComplianceMode) + ARBAC scope enforcement', status: 'IMPLEMENTED' },
  { framework: 'HIPAA', control: '§164.312(e)(2)(i) — PHI Transmission Security', description: 'Guard against unauthorized access to PHI transmitted over electronic communications networks', giaComponent: 'PHI Redaction (piiDetected flag) + Output Boundary + MANDATORY elevation on PII-flagged decisions (pii_detected rule)', status: 'IMPLEMENTED' },
  { framework: 'HIPAA', control: '§164.306(a)(1) — Data Integrity', description: 'Protect PHI from improper alteration or destruction', giaComponent: 'SHA-256 Hash-Chained Ledger + GMP Trust Levels — tamper-evident record for every governed PHI interaction', status: 'IMPLEMENTED' },
  { framework: 'HIPAA', control: '§164.308(a)(1)(ii)(D) — Activity Review', description: 'Implement procedures to regularly review records of information system activity', giaComponent: 'Audit Pipeline + Cerebro Signal Intelligence + Anomaly Detection', status: 'IMPLEMENTED' },
  { framework: 'HIPAA', control: '§164.308(a)(5)(ii)(B) — Malicious Software Protection', description: 'Guard against malicious software including adversarial AI inputs and prompt injection', giaComponent: 'Kernel Input Sanitization + MITRE ATLAS AML.T0025 (Prompt Injection) mitigation', status: 'IMPLEMENTED' },

  // ── VHA Trustworthy AI — Six Principles ─────────────────────────────────────
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 1 — Purposeful', description: 'AI is used for a defined, mission-aligned purpose with explicit scope boundaries', giaComponent: 'Charter + Contract Templates — every agent operates under a defined scope contract', status: 'IMPLEMENTED' },
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 2 — Effective', description: 'AI performs as intended and delivers measurable, documented value', giaComponent: 'GovernanceScorer + ValueMetrics + record_value_metric MCP tool', status: 'IMPLEMENTED' },
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 3 — Safe', description: 'AI does not harm patients, staff, or clinical operations — high-risk actions are gated', giaComponent: 'MAI MANDATORY Gates + PHI Detection (piiDetected) + Human-in-the-loop approval flow', status: 'IMPLEMENTED' },
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 4 — Secure', description: 'AI is protected from misuse, adversarial manipulation, and unauthorized access', giaComponent: 'ARBAC + GovernedLLM Kernel + MITRE ATLAS design mapping (8 attack vectors) + Rolling Code Gate', status: 'IMPLEMENTED' },
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 5 — Understandable', description: 'AI decisions can be explained, traced, and reviewed by clinical and oversight teams', giaComponent: 'Chain of Reasoning + Retrieval Audit Bridge — every decision is replayable with full provenance', status: 'IMPLEMENTED' },
  { framework: 'VHA_TRUSTWORTHY_AI', control: 'Principle 6 — Equitable', description: 'AI does not perpetuate bias; drift and anomalous patterns are detected and routed to oversight', giaComponent: 'Cerebro Signal Intelligence + Disposition Monitor + colony_health drift detection', status: 'IMPLEMENTED' },
];

/** Filter the canonical table by framework id; 'ALL' or undefined returns everything (copy). */
export function getComplianceMappings(framework?: string): IComplianceMappingRow[] {
  if (!framework || framework === 'ALL') return [...COMPLIANCE_MAPPINGS];
  return COMPLIANCE_MAPPINGS.filter(m => m.framework === framework);
}
