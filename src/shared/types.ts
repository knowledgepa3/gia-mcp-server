/**
 * @module    shared-types
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A — type definitions, no runtime operations
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

export enum MaiClassification {
  MANDATORY = 'MANDATORY',
  ADVISORY = 'ADVISORY',
  INFORMATIONAL = 'INFORMATIONAL',
}

export interface IMaiResult {
  classification: MaiClassification;
  confidence: number;
  rationale: string;
  elevatedFrom?: MaiClassification;
  elevationReason?: string;
  requiresGate: boolean;
}

export interface IMaiElevationRule {
  condition: string;
  elevateTo: MaiClassification;
  description: string;
}

export interface IMaiVerticalConfig {
  vertical: string;
  agentClassifications: Record<string, MaiClassification>;
  elevationRules: IMaiElevationRule[];
}

export type GateApprover = string | 'AUTO' | 'TIMEOUT' | 'AUTO-RUN';

export enum GateStatus {
  APPROVED = 'APPROVED',
  PENDING = 'PENDING',
  REJECTED = 'REJECTED',
  TIMED_OUT = 'TIMED_OUT',
}

export interface IGateDecision {
  gateId: string;
  classification: MaiClassification;
  status: GateStatus;
  approvedBy: GateApprover;
  timestamp: Date;
  rationale: string;
  autoRunMode: boolean;
  /** Cryptographic proof of human identity via WebAuthn/FIDO2 passkey assertion. */
  webauthnProof?: IWebAuthnProof;
  /** Break-glass emergency override metadata — heavily audited, mandatory post-review. */
  breakGlass?: {
    sessionId: string;
    approvedBy: string;
    justification: string;
    timestamp: string;
  };
}

/**
 * Cryptographic proof that a human identity was verified via WebAuthn
 * passkey assertion before approving a MANDATORY gate.
 *
 * Patent Claim 7, Layer 1: Passkey-authenticated human oversight gates.
 */
export interface IWebAuthnProof {
  /** Base64url credential ID of the passkey used */
  credentialId: string;
  /** Platform user ID who was verified */
  userId: string;
  /** ISO timestamp of when the assertion was verified */
  verifiedAt: string;
  /** Whether the cryptographic signature was verified against stored public key */
  signatureVerified: boolean;
}

export interface IGovernanceScore {
  integrity: number;
  accuracy: number;
  compliance: number;
  composite: number;
  weights: IScoreWeights;
  timestamp: Date;
  scoredBy: string;
  /**
   * True when integrity/accuracy/compliance were actually measured. False for
   * scoreDefault() not-scored sentinels (control-plane ops with nothing to
   * measure). Consumers MUST NOT treat a `scored === false` entry as a passing
   * measurement. Optional for backward compatibility (treat absent as scored).
   */
  scored?: boolean;
}

export interface IScoreWeights {
  integrity: number;
  accuracy: number;
  compliance: number;
}

export interface IThresholdReading {
  escalationRate: number;
  windowSize: number;
  windowStart: Date;
  windowEnd: Date;
  isHealthy: boolean;
  status: ThresholdStatus;
}

export enum ThresholdStatus {
  HEALTHY = 'HEALTHY',
  LOW_ESCALATION = 'LOW_ESCALATION',
  HIGH_ESCALATION = 'HIGH_ESCALATION',
  CRITICAL = 'CRITICAL',
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
}

export enum GiaLayer {
  CORE = 'CORE',
  MCP = 'MCP',
  VERTICAL = 'VERTICAL',
  COMPLIANCE = 'COMPLIANCE',
}

export enum EntryStatus {
  STARTED = 'STARTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  ESCALATED = 'ESCALATED',
}

export interface IAuditEntry {
  id: string;
  timestamp: Date;
  operation: string;
  layer: GiaLayer;
  maiLevel: MaiClassification;
  actor: string;
  status: EntryStatus;
  governanceScore?: IGovernanceScore;
  gateDecision?: IGateDecision;
  metadata: Record<string, unknown>;
  parentId?: string;
  /** Cross-ledger correlation ID - links MCP governance decisions to server-side HTTP request chains. */
  correlationId?: string;
  /** Delegation chain - traces this entry back to the human principal who authorized the agent action. */
  delegatedBy?: string;
  duration?: number;
  errorCode?: string;
  errorMessage?: string;
  /** SHA-256 hash of this entry's canonical data + previous hash. Forms tamper-evident chain. */
  entryHash?: string;
  /** SHA-256 hash of the immediately preceding entry in the append-only ledger. Genesis entry uses GENESIS_HASH. */
  previousHash?: string;
  /** Index position in the append-only ledger at time of hashing. */
  chainIndex?: number;
  /** Canonicalization epoch of entryHash: 1 = heterogeneous legacy bucket
   * (linkage-only verifiable), 2 = Ledger Canonical v2 (content-verifiable).
   * Populated on recovery from the algo_epoch column; stamped 2 on new writes. */
  algoEpoch?: number;
}

export interface IGovernedResult<T> {
  result: T;
  score: IGovernanceScore;
  classification: IMaiResult;
  auditId: string;
  gateDecision?: IGateDecision;
  timestamp: Date;
}

export enum AccessTier {
  SCOUT = 'SCOUT',
  OPERATOR = 'OPERATOR',
  COMMANDER = 'COMMANDER',
  ARCHITECT = 'ARCHITECT',
}

export enum DataClassification {
  PUBLIC = 'PUBLIC',
  CONTROLLED = 'CONTROLLED',
  SOVEREIGN = 'SOVEREIGN',
}

export interface IAuthResult {
  authenticated: boolean;
  tier: AccessTier;
  userId: string;
  permissions: string[];
}

export enum SupervisorAction {
  CONTINUE = 'CONTINUE',
  REPAIR = 'REPAIR',
  ESCALATE = 'ESCALATE',
  HALT = 'HALT',
}

export interface ISupervisorDecision {
  action: SupervisorAction;
  rationale: string;
  targetAgent: string;
  repairAttempts: number;
  maxRepairAttempts: number;
  timestamp: Date;
}

export enum ComplianceFramework {
  NIST_800_53 = 'NIST_800_53',
  NIST_AI_RMF = 'NIST_AI_RMF',
  EU_AI_ACT = 'EU_AI_ACT',
  ISO_42001 = 'ISO_42001',
  FEDRAMP = 'FEDRAMP',
  LINDDUN = 'LINDDUN',
  MITRE_ATLAS = 'MITRE_ATLAS',
  OMB_M_25_22 = 'OMB_M_25_22',
  HIPAA = 'HIPAA',
  VHA_TRUSTWORTHY_AI = 'VHA_TRUSTWORTHY_AI',
}

export interface IComplianceMapping {
  framework: ComplianceFramework;
  control: string;
  description: string;
  giaComponent: string;
  // DESIGN-MAPPING status — whether a GIA component is mapped to the control.
  // 'IMPLEMENTED' = the component exists and is mapped; it does NOT assert third-party
  // certification or measured runtime enforcement. Runtime-evidenced coverage is a
  // separate axis (ControlBinding, post-QA-B) — see map-compliance.ts MAPPING_DISCLAIMER.
  status: 'IMPLEMENTED' | 'PARTIAL' | 'PLANNED';
}

export enum ErrorSeverity {
  INFORMATIONAL = 'INFORMATIONAL',
  ADVISORY = 'ADVISORY',
  MANDATORY = 'MANDATORY',
}

export interface IDomainContext {
  domain: string;
  vertical?: string;
  piiDetected: boolean;
  sensitivityLevel: DataClassification;
  metadata: Record<string, unknown>;
}
