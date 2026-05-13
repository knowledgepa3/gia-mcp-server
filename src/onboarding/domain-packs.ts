/**
 * @module    domain-packs
 * @layer     GOVERNANCE
 * @mai       ADVISORY — pack templates, sealed at onboarding
 * @audit     true — pack sealing recorded in ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Pre-built Governed Memory Pack templates for common client verticals.
 * Each template defines the domain SOPs, heuristics, anti-patterns, and
 * risk guardrails that get sealed into a GMP during onboarding.
 *
 * Clients receive domain-appropriate governance from day one.
 */

export interface DomainPackTemplate {
  packIdPrefix: string;
  type: 'DOMAIN_SOP' | 'RISK_GUARDRAILS' | 'PLAYBOOK';
  domain: string;
  displayName: string;
  description: string;
  trustLevel: 'ORG' | 'CASE';
  ttlHours: number;
  scope: string[];
  principles: string[];
  sop: string[];
  heuristics: string[];
  antiPatterns: string[];
  riskLevel: 'MANDATORY' | 'ADVISORY' | 'INFORMATIONAL';
  allowedRoles: string[];
}

// =============================================================================
// VA Claims Processing
// =============================================================================

export const VA_CLAIMS_SOP: DomainPackTemplate = {
  packIdPrefix: 'va-claims-sop',
  type: 'DOMAIN_SOP',
  domain: 'va-claims',
  displayName: 'VA Claims Processing',
  description: 'Standard operating procedures for VA disability claims analysis, evidence review, and submission preparation.',
  trustLevel: 'ORG',
  ttlHours: 2160, // 90 days
  scope: ['claims-intake', 'evidence-review', 'nexus-analysis', 'submission-prep'],
  principles: [
    'Veteran benefit-of-the-doubt doctrine (38 USC 5107b) — resolve ambiguity in veteran favor',
    'Never fabricate medical evidence or nexus opinions',
    'All claims assertions must cite specific evidence (C-file, DBQ, service record)',
    'PII/PHI never stored in client-side storage or logs',
    'Every claim decision classified M/A/I before execution',
  ],
  sop: [
    'Step 1: Intake — Collect DD-214, medical records, personal statement. Validate completeness.',
    'Step 2: Conditions — Map each claimed condition to ICD-10 and diagnostic code.',
    'Step 3: Evidence — Grade each evidence item (direct, secondary, presumptive). Identify gaps.',
    'Step 4: Nexus — For each condition, assess service-connection pathway. Flag missing nexus letters.',
    'Step 5: Rating — Estimate rating per 38 CFR Part 4 schedule. Apply bilateral factor where applicable.',
    'Step 6: Review — Human reviews all assertions before submission. MANDATORY gate.',
    'Step 7: Submit — Generate VA Form 21-526EZ. Record submission in audit ledger.',
  ],
  heuristics: [
    'If veteran served in combat zone + has PTSD diagnosis → strong presumptive case',
    'If service records show in-service event + current diagnosis + no nexus letter → recommend IMO',
    'If condition worsened during service → secondary service connection pathway',
    'If rating estimate > 70% → check TDIU eligibility',
    'If multiple conditions affect same body system → check combined rating with bilateral factor',
  ],
  antiPatterns: [
    'NEVER auto-submit claims without human review',
    'NEVER generate fake medical opinions or fabricate evidence',
    'NEVER store veteran SSN, full name + DOB together in client storage',
    'NEVER promise specific rating percentages to veterans',
    'NEVER bypass the nexus letter requirement with AI-generated medical opinions',
  ],
  riskLevel: 'MANDATORY',
  allowedRoles: ['claims-agent', 'supervisor', 'forensic-analyst'],
};

// =============================================================================
// Federal Business Development
// =============================================================================

export const FEDERAL_BD_SOP: DomainPackTemplate = {
  packIdPrefix: 'federal-bd-sop',
  type: 'DOMAIN_SOP',
  domain: 'federal-bd',
  displayName: 'Federal Business Development',
  description: 'SOPs for federal opportunity identification, capture management, and proposal development.',
  trustLevel: 'ORG',
  ttlHours: 2160,
  scope: ['opportunity-research', 'capture-management', 'proposal-development', 'compliance-review'],
  principles: [
    'All opportunity data sourced from authoritative sources (SAM.gov, USASpending, FPDS)',
    'Competitive intelligence gathered only from public sources — no unauthorized access',
    'Proposal content never plagiarized from competitors or prior submissions without rights',
    'Cost estimates based on documented rates and BOEs — no fabricated pricing',
    'Every bid/no-bid decision classified M/A/I and recorded',
  ],
  sop: [
    'Step 1: Pipeline — Monitor SAM.gov, GovWin, Bloomberg for opportunities matching client profile.',
    'Step 2: Qualify — Score opportunity (Pwin, revenue potential, strategic fit). Bid/no-bid gate.',
    'Step 3: Capture — Identify incumbents, teaming partners, key personnel. Build win strategy.',
    'Step 4: Proposal — Draft sections per RFP instructions. Compliance matrix tracking.',
    'Step 5: Review — Color team reviews (Pink, Red, Gold). Human approval before submission.',
    'Step 6: Submit — Final compliance check. Submit via designated portal. Record in ledger.',
  ],
  heuristics: [
    'If incumbent is strong + no differentiator → likely no-bid unless teaming',
    'If NAICS matches + past performance exists → strong qualify signal',
    'If proposal deadline < 15 days + no prior capture → high risk bid',
    'If contract value > $10M → MANDATORY executive review gate',
    'If set-aside applies + client qualifies → prioritize in pipeline',
  ],
  antiPatterns: [
    'NEVER fabricate past performance citations',
    'NEVER submit proposals without compliance matrix verification',
    'NEVER access competitor proprietary information',
    'NEVER auto-generate cost volumes without human BOE review',
    'NEVER bypass color team review process for contracts > $1M',
  ],
  riskLevel: 'ADVISORY',
  allowedRoles: ['bd-agent', 'capture-manager', 'proposal-manager', 'supervisor'],
};

// =============================================================================
// Healthcare Compliance
// =============================================================================

export const HEALTHCARE_COMPLIANCE_SOP: DomainPackTemplate = {
  packIdPrefix: 'healthcare-compliance-sop',
  type: 'RISK_GUARDRAILS',
  domain: 'healthcare',
  displayName: 'Healthcare Compliance Guardrails',
  description: 'HIPAA-aligned guardrails for healthcare AI operations. PHI handling, audit requirements, breach protocols.',
  trustLevel: 'ORG',
  ttlHours: 2160,
  scope: ['phi-handling', 'hipaa-compliance', 'audit-requirements', 'breach-response'],
  principles: [
    'Minimum necessary principle — only access PHI required for the specific task',
    'All PHI access logged with who, what, when, why',
    'PHI never stored in client-side storage, logs, or unencrypted channels',
    'Every PHI access decision classified MANDATORY',
    'Breach notification within 60 days per HIPAA Breach Notification Rule',
  ],
  sop: [
    'Step 1: Access Request — Validate requester role and minimum necessary scope.',
    'Step 2: Audit Log — Record PHI access with timestamp, user, purpose, data elements.',
    'Step 3: Processing — Process PHI in memory only. No persistent storage without encryption.',
    'Step 4: Output — Redact PHI from outputs unless explicitly required and authorized.',
    'Step 5: Retention — PHI retained per policy (min 6 years per HIPAA). Destroy per schedule.',
  ],
  heuristics: [
    'If output contains patient name + diagnosis → MANDATORY redaction review',
    'If bulk PHI export requested → MANDATORY supervisor approval',
    'If access pattern anomalous (volume, timing, scope) → flag for review',
    'If third-party sharing → verify BAA in place before any PHI transfer',
  ],
  antiPatterns: [
    'NEVER log PHI in application logs or error messages',
    'NEVER store PHI in browser localStorage, sessionStorage, or cookies',
    'NEVER transmit PHI over unencrypted channels',
    'NEVER share PHI with entities lacking a signed BAA',
    'NEVER use PHI for training AI models without explicit authorization and de-identification',
  ],
  riskLevel: 'MANDATORY',
  allowedRoles: ['clinician', 'compliance-officer', 'supervisor'],
};

// =============================================================================
// Financial Services
// =============================================================================

export const FINANCIAL_SERVICES_SOP: DomainPackTemplate = {
  packIdPrefix: 'financial-services-sop',
  type: 'RISK_GUARDRAILS',
  domain: 'finance',
  displayName: 'Financial Services Guardrails',
  description: 'Compliance guardrails for financial AI operations. Fiduciary duty, fair lending, anti-fraud.',
  trustLevel: 'ORG',
  ttlHours: 2160,
  scope: ['lending-decisions', 'risk-assessment', 'fraud-detection', 'regulatory-reporting'],
  principles: [
    'No automated lending decisions without human review — ECOA/fair lending compliance',
    'All risk scores must include explanation of factors — adverse action notice requirement',
    'Financial projections labeled as estimates with confidence intervals',
    'Customer financial data (account numbers, SSN, income) classified as PII',
    'Every financial decision classified M/A/I before execution',
  ],
  sop: [
    'Step 1: Data Collection — Gather applicant data per regulation (ECOA, FCRA). Consent required.',
    'Step 2: Risk Assessment — Run scoring model. Document all factors considered.',
    'Step 3: Decision — Human reviews model output. Adverse action notice if denied.',
    'Step 4: Documentation — Record decision rationale, model version, data sources.',
    'Step 5: Reporting — Generate required regulatory reports (HMDA, CRA).',
  ],
  heuristics: [
    'If lending decision → MANDATORY human review regardless of model confidence',
    'If applicant disputes → escalate to senior reviewer within 30 days',
    'If model flags potential fraud → MANDATORY investigation before action',
    'If demographic data correlates with decision → fair lending review required',
  ],
  antiPatterns: [
    'NEVER auto-approve or auto-deny loans without human review',
    'NEVER use prohibited factors (race, religion, national origin) in decisions',
    'NEVER store full account numbers in logs or client-side storage',
    'NEVER provide investment advice without appropriate licensing',
    'NEVER skip adverse action notices for denied applications',
  ],
  riskLevel: 'MANDATORY',
  allowedRoles: ['loan-officer', 'compliance-officer', 'supervisor'],
};

// =============================================================================
// Legal Operations
// =============================================================================

export const LEGAL_OPS_SOP: DomainPackTemplate = {
  packIdPrefix: 'legal-ops-sop',
  type: 'DOMAIN_SOP',
  domain: 'legal',
  displayName: 'Legal Operations',
  description: 'SOPs for legal document analysis, case research, and compliance review.',
  trustLevel: 'ORG',
  ttlHours: 2160,
  scope: ['document-review', 'case-research', 'compliance-analysis', 'contract-review'],
  principles: [
    'AI output is legal research assistance, not legal advice — always disclaim',
    'Attorney-client privilege must be preserved — never expose privileged communications',
    'All legal citations must be verified against authoritative sources',
    'No hallucinated case law — every citation must be real and verifiable',
    'Every legal assertion classified M/A/I before client delivery',
  ],
  sop: [
    'Step 1: Intake — Receive research request. Classify privilege status.',
    'Step 2: Research — Search authoritative legal databases. Cite specific sources.',
    'Step 3: Analysis — Draft memo with citations. Flag confidence level per assertion.',
    'Step 4: Verification — Cross-check all case citations exist and are current.',
    'Step 5: Review — Attorney reviews before client delivery. MANDATORY gate.',
  ],
  heuristics: [
    'If case citation not found in Westlaw/LexisNexis → flag as potentially hallucinated',
    'If legal question involves multiple jurisdictions → note conflicts of law',
    'If statute has been amended recently → verify current version',
    'If matter involves privilege → MANDATORY classification before any output',
  ],
  antiPatterns: [
    'NEVER present AI analysis as legal advice',
    'NEVER fabricate case citations or legal authorities',
    'NEVER expose attorney-client privileged communications',
    'NEVER auto-file legal documents without attorney review',
    'NEVER provide legal opinions on matters outside the research scope',
  ],
  riskLevel: 'MANDATORY',
  allowedRoles: ['attorney', 'paralegal', 'legal-analyst', 'supervisor'],
};

// =============================================================================
// Registry
// =============================================================================

export const DOMAIN_PACK_REGISTRY: Record<string, DomainPackTemplate> = {
  'va-claims': VA_CLAIMS_SOP,
  'federal-bd': FEDERAL_BD_SOP,
  'healthcare': HEALTHCARE_COMPLIANCE_SOP,
  'finance': FINANCIAL_SERVICES_SOP,
  'legal': LEGAL_OPS_SOP,
};

export function getAvailableDomains(): string[] {
  return Object.keys(DOMAIN_PACK_REGISTRY);
}

export function getDomainPack(domain: string): DomainPackTemplate | undefined {
  return DOMAIN_PACK_REGISTRY[domain];
}
