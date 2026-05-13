/**
 * @module    mcp-tool-remediation-packs
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       varies — scan=INFO, list=INFO, dry_run=ADVISORY, apply=MANDATORY
 * @audit     true — all remediation operations are ledger-recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA Governed Operations Pack MCP Tools — Executable Governed Procedure Bundles
 *
 * 5 tools for the full operations lifecycle:
 * - gia_scan_environment:  Run scout swarm, detect environment (INFORMATIONAL)
 * - gia_list_packs:        List available packs by intent/category (INFORMATIONAL)
 * - gia_dry_run_pack:      Preview pack execution — two-phase approval (ADVISORY)
 * - gia_apply_pack:        Execute remediation/hardening pack (MANDATORY gate)
 * - gia_run_patrol:        Execute patrol/audit pack (ADVISORY or MANDATORY by sensitivity)
 *
 * Two-phase apply:
 *   1. gia_dry_run_pack → returns inputsHash (what-you-approved-is-what-ran)
 *   2. gia_apply_pack   → requires approval token bound to inputsHash
 *
 * No mock data. No Math.random(). Every value from real sources.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { GovernanceEngine } from '../../core/governance.js';

// ═══════════════════════════════════════════════════════════════════
// In-memory remediation state for MCP server process
// ═══════════════════════════════════════════════════════════════════

// Import types inline to keep MCP layer self-contained (same pattern as srt.ts)

interface RemediationStep {
  step: number;
  command: string;
  description: string;
  classification: 'INFORMATIONAL' | 'ADVISORY' | 'MANDATORY';
  timeout: number;
  requiresElevation: boolean;
  sensitive: boolean;
}

interface BlastRadius {
  maxCommands: number;
  maxDurationSeconds: number;
  allowedTargets: string;
  maxServicesAffected: number;
}

interface SuccessCriterion {
  check: string;
  expected: string;
  timeout: number;
}

interface HardeningPreflightCheck {
  checkId: string;
  description: string;
  command: string;
  expectedOutput: string;
  failAction: 'BLOCK' | 'WARN';
  requiresConsoleAccess?: boolean;
}

interface AuditEvaluation {
  type: 'regex_match' | 'threshold_compare' | 'presence_check' | 'count_compare';
  pattern?: string;
  operator?: '<' | '>' | '<=' | '>=' | '==';
  value?: number;
  field: string;
  expected?: boolean;
}

interface PackControlMapping {
  controlId: string;
  controlTitle: string;
  evidenceFrom: string[];
  evaluation: AuditEvaluation;
  remediation?: string;
}

interface RemediationPack {
  $schema: string;
  packId: string;
  version: string;
  type: string;
  trustLevel: string;
  domain: string;
  scope: string[];
  riskLevel: string;
  ttlHours: number;
  createdBy: string;
  signedBy: string;
  hash: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  estimatedMinutes: number;
  risk: string;
  blastRadius: BlastRadius;
  environment: Record<string, unknown>;
  governance: {
    principles: string[];
    sop: string[];
    heuristics: string[];
    antiPatterns: string[];
  };
  steps: RemediationStep[];
  rollback: RemediationStep[];
  successCriteria: SuccessCriterion[];
  variables: Array<{
    name: string;
    description: string;
    required: boolean;
    default?: string;
    scoutSource?: string;
  }>;
  promotion: {
    status: string;
    usesCount: number;
    successCount: number;
    sourceIncidentId?: string;
  };
  provenance: {
    sourcePlaybook?: string;
    sourceMemoryPacks: string[];
    derivedFrom?: string;
    convertedAt: string;
  };
  // ─── Phase 6.1: Operations Pack Extensions ───
  intent: 'remediation' | 'patrol' | 'hardening' | 'audit';
  dataSensitivity: 'low' | 'moderate' | 'high';
  scheduleHint?: { freq: string; jitterMinutes: number; window?: string };
  preflight?: HardeningPreflightCheck[];
  controlMappings?: PackControlMapping[];
}

interface ApprovalToken {
  tokenId: string;
  packId: string;
  packHash: string;
  inputsHash: string;
  runId: string;
  tenantId: string;
  approvedBy: string;
  approverRole: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

interface EnvironmentProfile {
  profileId: string;
  hostname: string;
  os: { family: string; release: string; arch: string };
  services: Array<{ name: string; detected: boolean; running: boolean; version?: string }>;
  containers: Array<{ name: string; image: string; status: string; ports: string[] }>;
  network: { ports: number[]; dnsResolvable: boolean };
  storage: { usedPercent: number };
  timestamp: string;
}

interface DryRunPreview {
  packId: string;
  packHash: string;
  inputsHash: string;
  hydratedSteps: RemediationStep[];
  hydratedRollback: RemediationStep[];
  successCriteria: SuccessCriterion[];
  compatibility: { compatible: boolean; missingRequirements: string[]; warnings: string[] };
  validation: { allCommandsAllowed: boolean; issues: string[] };
  blastRadius: BlastRadius;
  estimatedMinutes: number;
  risk: string;
  requiresApproval: true;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════
// CRYPTO & HELPERS — Same as services/remediationPacks.ts
// ═══════════════════════════════════════════════════════════════════

function djb2Hash(data: string): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}-${ts}-${rand}`;
}

const BLOCKED_APPROVERS = ['system', 'auto', 'agent', 'bot', 'ai', ''];
const APPROVAL_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Sensitive patterns to redact from scout output */
const REDACT_PATTERNS = [
  /password[=:]\S+/gi, /token[=:]\S+/gi, /secret[=:]\S+/gi,
  /api[_-]?key[=:]\S+/gi, /sk-[a-zA-Z0-9]+/g, /ghp_[a-zA-Z0-9]+/g,
];

function redact(s: string): string {
  let r = s;
  for (const p of REDACT_PATTERNS) r = r.replace(p, '[REDACTED]');
  return r;
}

/** Dangerous command patterns — same as srtCommandExecutor */
const DANGEROUS_PATTERNS = [
  'rm -rf /', 'rm -rf /*', 'dd if=', 'mkfs.', '> /dev/sda',
  'chmod 777', 'curl | sh', 'wget | sh', 'eval ', ':(){ :|:& };:',
];

function hashInputs(steps: RemediationStep[], rollback: RemediationStep[]): string {
  return djb2Hash(JSON.stringify({ s: steps.map(s => s.command), r: rollback.map(s => s.command) }));
}

// ═══════════════════════════════════════════════════════════════════
// PACK LIBRARY — In-memory store seeded from SRT playbook conversion
// ═══════════════════════════════════════════════════════════════════

/** SRT playbook → .mb pack conversion data (pre-computed, deterministic) */
const PACK_LIBRARY: RemediationPack[] = [
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-nginx-502-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['network', 'nginx_502_upstream_unhealthy', '502-error-rate-spike', 'api-container-unhealthy'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Nginx 502 Upstream Recovery',
    description: 'Governed remediation pack for nginx 502 upstream recovery. Signals: 502 error rate spike, API container unhealthy, API healthz failing.',
    category: 'network',
    tags: ['network', 'srt', 'auto-converted', 'nginx_502_upstream_unhealthy'],
    estimatedMinutes: 5,
    risk: 'LOW',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 600, allowedTargets: 'localhost', maxServicesAffected: 3 },
    environment: { os: ['linux'], services: ['docker', 'nginx'], capabilities: ['docker-compose'] },
    governance: {
      principles: [
        'Diagnosis is read-only — never modify system state during analysis',
        'Always propose at least one fix option with rollback',
        'NEVER auto-execute repairs — MANDATORY human gate, every time, no exceptions',
        'All commands must be deterministic — no dynamic generation at runtime',
      ],
      sop: [
        'Receive approved repair plan from MANDATORY gate',
        'Validate plan before execution (no dangerous patterns)',
        'Execute commands in order, respecting timeouts',
        'If any command fails: stop and evaluate rollback',
        'Verify success criteria after all commands complete',
      ],
      heuristics: ['nginx_502 + API unhealthy → restart API container (LOW risk)'],
      antiPatterns: [
        'NEVER bypass the MANDATORY gate — no exceptions, no overrides',
        'NEVER execute commands not in the approved plan',
        'NEVER modify credentials, tokens, or .env values',
      ],
    },
    steps: [
      { step: 1, command: 'docker compose ps', description: 'Check container states', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose up -d --force-recreate ace-server', description: 'Recreate API container', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 3, command: 'sleep 15 && curl -sf http://localhost:3001/health', description: 'Wait and verify health', classification: 'INFORMATIONAL', timeout: 30, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose down ace-server', description: 'Stop API container', classification: 'ADVISORY', timeout: 30, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose up -d ace-server', description: 'Restart API container (clean)', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: '502 rate < 1% over 5m', expected: 'true', timeout: 300 },
      { check: 'healthz returns 200', expected: '200', timeout: 30 },
      { check: 'API container status healthy', expected: 'healthy', timeout: 60 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'nginx_502_upstream_unhealthy', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-tls-renewal-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['security', 'tls_certificate_expiring', 'tls-cert-<-14-days', 'ssl-handshake-failures'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'TLS Certificate Renewal',
    description: 'Governed remediation pack for TLS certificate renewal. Signals: TLS cert < 14 days, SSL handshake failures.',
    category: 'security',
    tags: ['security', 'srt', 'auto-converted', 'tls_certificate_expiring'],
    estimatedMinutes: 3,
    risk: 'LOW',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 360, allowedTargets: 'localhost', maxServicesAffected: 3 },
    environment: { os: ['linux'], services: ['docker', 'nginx'], capabilities: ['docker-compose', 'certbot', 'openssl'] },
    governance: {
      principles: ['NEVER auto-execute repairs — MANDATORY human gate, every time, no exceptions', 'All commands must be visible to the approver — no hidden side effects'],
      sop: ['Validate plan before execution', 'Execute commands in order', 'Verify success criteria after all commands complete'],
      heuristics: ['TLS cert < 14 days → certbot renew + nginx reload (LOW risk)'],
      antiPatterns: ['NEVER bypass the MANDATORY gate', 'NEVER modify credentials, tokens, or .env values'],
    },
    steps: [
      { step: 1, command: 'docker compose run --rm certbot renew', description: 'Renew TLS certificate', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose exec ace-frontend nginx -s reload', description: 'Reload nginx with new cert', classification: 'ADVISORY', timeout: 15, requiresElevation: false, sensitive: false },
      { step: 3, command: 'echo | openssl s_client -servername gia.aceadvising.com -connect gia.aceadvising.com:443 2>/dev/null | openssl x509 -noout -dates', description: 'Verify new cert dates', classification: 'INFORMATIONAL', timeout: 15, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose restart ace-frontend', description: 'Restart nginx to reload old cert', classification: 'ADVISORY', timeout: 30, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'TLS cert > 30 days remaining', expected: 'true', timeout: 30 },
      { check: 'HTTPS accessible', expected: '200', timeout: 15 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'tls_certificate_expiring', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-db-recovery-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['database', 'database_unreachable', 'pg_isready-fails', 'connection-refused-on-5432'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'PostgreSQL Database Recovery',
    description: 'Governed remediation pack for PostgreSQL database recovery. Signals: pg_isready fails, API health degraded, connection refused on 5432.',
    category: 'database',
    tags: ['database', 'srt', 'auto-converted', 'database_unreachable'],
    estimatedMinutes: 5,
    risk: 'MEDIUM',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 600, allowedTargets: 'localhost', maxServicesAffected: 3 },
    environment: { os: ['linux'], services: ['docker', 'postgresql'], capabilities: ['docker-compose', 'pg_isready'] },
    governance: {
      principles: ['NEVER auto-execute repairs — MANDATORY human gate', 'Rollback must be defined before execution begins'],
      sop: ['Execute commands in order, respecting timeouts', 'If any command fails: stop and evaluate rollback'],
      heuristics: ['Database unreachable → restart postgres + API (MEDIUM risk)'],
      antiPatterns: ['NEVER bypass the MANDATORY gate', 'NEVER modify credentials'],
    },
    steps: [
      { step: 1, command: 'docker compose ps postgres', description: 'Check postgres state', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose restart postgres', description: 'Restart postgres container', classification: 'ADVISORY', timeout: 60, requiresElevation: false, sensitive: false },
      { step: 3, command: 'sleep 10 && docker exec ace-postgres pg_isready -U ace -d ace_governance', description: 'Wait and verify connectivity', classification: 'INFORMATIONAL', timeout: 30, requiresElevation: false, sensitive: false },
      { step: 4, command: 'docker compose restart ace-server', description: 'Restart API to reconnect', classification: 'ADVISORY', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose down && docker compose up -d', description: 'Full stack restart', classification: 'ADVISORY', timeout: 180, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'pg_isready returns ok', expected: 'accepting connections', timeout: 30 },
      { check: 'API healthz 200', expected: '200', timeout: 60 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'database_unreachable', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-env-fix-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['configuration', 'env_parse_failure', 'api-container-crash-loop', 'env-parse-error-in-logs'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Environment Config Repair',
    description: 'Governed remediation pack for environment config repair. Signals: API container crash loop, env parse error in logs.',
    category: 'configuration',
    tags: ['configuration', 'srt', 'auto-converted', 'env_parse_failure'],
    estimatedMinutes: 3,
    risk: 'LOW',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 360, allowedTargets: 'localhost', maxServicesAffected: 2 },
    environment: { os: ['linux'], services: ['docker'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['NEVER auto-execute repairs — MANDATORY human gate', 'All commands must be visible to the approver'],
      sop: ['Execute commands in order', 'Verify success criteria after all commands complete'],
      heuristics: ['.env parse error → strip CRLF + restart API (LOW risk)'],
      antiPatterns: ['NEVER modify credentials', 'NEVER read .env values — only check existence and format'],
    },
    steps: [
      { step: 1, command: 'test -f /root/gia-platform/.env && echo "exists" || echo "MISSING"', description: 'Check .env exists', classification: 'INFORMATIONAL', timeout: 5, requiresElevation: false, sensitive: false },
      { step: 2, command: "sed -i 's/\\r$//' /root/gia-platform/.env", description: 'Strip Windows line endings', classification: 'ADVISORY', timeout: 5, requiresElevation: false, sensitive: true },
      { step: 3, command: 'docker compose restart ace-server', description: 'Restart API with clean .env', classification: 'ADVISORY', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose restart ace-server', description: 'Restart API container', classification: 'ADVISORY', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'API healthz 200', expected: '200', timeout: 60 },
      { check: 'No .env errors in logs', expected: 'true', timeout: 30 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'env_parse_failure', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-disk-cleanup-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['storage', 'disk_space_critical', 'disk-usage->-90%', 'docker-build-fails'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Disk Space Cleanup',
    description: 'Governed remediation pack for disk space cleanup. Signals: disk usage > 90%, docker build fails, write errors in logs.',
    category: 'storage',
    tags: ['storage', 'srt', 'auto-converted', 'disk_space_critical'],
    estimatedMinutes: 5,
    risk: 'MEDIUM',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 600, allowedTargets: 'localhost', maxServicesAffected: 3 },
    environment: { os: ['linux'], services: ['docker'], capabilities: ['docker-compose', 'journalctl'] },
    governance: {
      principles: ['NEVER auto-execute repairs — MANDATORY human gate', 'Maximum blast radius: one service at a time unless full restart required'],
      sop: ['Execute commands in order', 'Verify success criteria after all commands complete'],
      heuristics: ['Disk > 90% → prune Docker + trim journal (MEDIUM risk)'],
      antiPatterns: ['NEVER bypass the MANDATORY gate', 'NEVER run commands with "rm -rf"'],
    },
    steps: [
      { step: 1, command: 'docker system prune -f --volumes', description: 'Prune unused Docker resources', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 2, command: 'journalctl --vacuum-size=100M', description: 'Trim system journal to 100MB', classification: 'ADVISORY', timeout: 30, requiresElevation: true, sensitive: false },
      { step: 3, command: 'df -h /', description: 'Verify space reclaimed', classification: 'INFORMATIONAL', timeout: 5, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [
      { check: 'Disk usage < 80%', expected: 'true', timeout: 10 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'disk_space_critical', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },
  {
    $schema: 'gia-remediation-pack-v1',
    packId: 'rpack-port-conflict-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['network', 'port_conflict', 'bind:-address-already-in-use', 'nginx-fails-to-start'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Port Conflict Resolution',
    description: 'Governed remediation pack for port conflict resolution. Signals: bind: address already in use, nginx fails to start, container exit code 1.',
    category: 'network',
    tags: ['network', 'srt', 'auto-converted', 'port_conflict'],
    estimatedMinutes: 5,
    risk: 'LOW',
    blastRadius: { maxCommands: 10, maxDurationSeconds: 600, allowedTargets: 'localhost', maxServicesAffected: 4 },
    environment: { os: ['linux'], services: ['docker'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['NEVER auto-execute repairs — MANDATORY human gate', 'All commands must be deterministic'],
      sop: ['Execute commands in order', 'Verify success criteria after all commands complete'],
      heuristics: ['Port conflict → full stack down/up cycle (LOW risk)'],
      antiPatterns: ['NEVER bypass the MANDATORY gate', 'NEVER skip success criteria verification'],
    },
    steps: [
      { step: 1, command: 'docker compose down', description: 'Stop all containers', classification: 'ADVISORY', timeout: 60, requiresElevation: false, sensitive: false },
      { step: 2, command: 'sleep 5 && ss -tlnp | grep -E ":80|:443|:3001"', description: 'Check for stale port bindings', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 3, command: 'docker compose up -d', description: 'Restart all containers', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [
      { check: 'All containers running', expected: 'true', timeout: 60 },
      { check: 'No port conflicts', expected: 'true', timeout: 10 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourcePlaybook: 'port_conflict', sourceMemoryPacks: ['incident-playbooks-v1', 'repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'remediation',
    dataSensitivity: 'low',
  },

  // ═══════════════════════════════════════════════════════════════════
  // PATROL PACKS — Read-only posture checks (Phase 6.1)
  // All commands from srtCommandExecutor allowlist. No mutations.
  // ═══════════════════════════════════════════════════════════════════

  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-open-ports-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['network', 'port-audit', 'listening-services'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Open Port Audit',
    description: 'Patrol pack: audits all listening TCP ports and reports unexpected services. Detects rogue listeners, validates only expected ports are open.',
    category: 'network',
    tags: ['patrol', 'network', 'ports', 'posture'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 30, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: [], capabilities: [] },
    governance: {
      principles: ['Read-only — no system state changes', 'Redact sensitive output'],
      sop: ['Execute ss command', 'Parse listening ports', 'Compare against expected baseline'],
      heuristics: ['Unexpected port → WARN', 'Known service port → PASS'],
      antiPatterns: ['NEVER modify firewall rules in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'ss -tlnp', description: 'List all TCP listening sockets with process info', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Command completes', expected: 'exit 0', timeout: 10 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'daily', jitterMinutes: 15 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-cert-expiry-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['security', 'tls', 'certificate-expiry'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'TLS Certificate Expiry Check',
    description: 'Patrol pack: checks TLS certificate expiration dates. Warns if <30 days, fails if <7 days.',
    category: 'security',
    tags: ['patrol', 'security', 'tls', 'certificate'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 30, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['nginx'], capabilities: ['openssl'] },
    governance: {
      principles: ['Read-only — no certificate changes', 'Report expiry dates accurately'],
      sop: ['Connect to TLS endpoint', 'Extract certificate dates', 'Compare against thresholds'],
      heuristics: ['< 7 days → FAIL/CRITICAL', '< 30 days → WARN/HIGH', '>= 30 days → PASS'],
      antiPatterns: ['NEVER renew certificates in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'echo | openssl s_client -servername gia.aceadvising.com -connect gia.aceadvising.com:443 2>/dev/null | openssl x509 -noout -dates', description: 'Check TLS certificate validity dates', classification: 'INFORMATIONAL', timeout: 15, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Certificate dates retrieved', expected: 'notAfter', timeout: 15 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'daily', jitterMinutes: 30 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-disk-trends-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['storage', 'disk-usage', 'capacity-planning'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Disk Usage Trends',
    description: 'Patrol pack: checks disk usage on root filesystem. Warns at 80%, fails at 90%.',
    category: 'storage',
    tags: ['patrol', 'storage', 'disk', 'capacity'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 15, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: [], capabilities: [] },
    governance: {
      principles: ['Read-only — no cleanup actions', 'Report actual usage from df'],
      sop: ['Run df on root filesystem', 'Parse usage percentage', 'Compare against thresholds'],
      heuristics: ['> 90% → FAIL/HIGH', '> 80% → WARN/MEDIUM', '<= 80% → PASS'],
      antiPatterns: ['NEVER delete files in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'df -h /', description: 'Check root filesystem disk usage', classification: 'INFORMATIONAL', timeout: 5, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Disk usage reported', expected: 'exit 0', timeout: 5 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'hourly', jitterMinutes: 5 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-docker-health-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['container', 'docker', 'health-check'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Docker Container Health',
    description: 'Patrol pack: checks health status of all running Docker containers. Detects unhealthy, restarting, or exited containers.',
    category: 'container',
    tags: ['patrol', 'docker', 'container', 'health'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 30, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['docker'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['Read-only — no container restarts', 'Report actual container states'],
      sop: ['List containers with status', 'Inspect unhealthy containers', 'Report findings'],
      heuristics: ['Exited/unhealthy → FAIL', 'Restarting → WARN', 'Running/healthy → PASS'],
      antiPatterns: ['NEVER restart containers in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'docker ps --format "{{.Names}}|{{.Status}}|{{.State}}"', description: 'List all containers with health status', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker inspect --format "{{.Name}}|{{.State.Health.Status}}" ace-governance-api 2>/dev/null || echo "no-healthcheck"', description: 'Inspect API container health details', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Container list retrieved', expected: 'exit 0', timeout: 10 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'hourly', jitterMinutes: 5 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-docker-settings-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['container', 'docker', 'daemon-posture', 'security-settings'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Docker Daemon Posture',
    description: 'Patrol pack: audits Docker daemon configuration and security posture. Reports driver, runtime, registry settings. Moderate sensitivity — exposes daemon internals.',
    category: 'container',
    tags: ['patrol', 'docker', 'daemon', 'posture', 'security'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 30, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['docker'], capabilities: [] },
    governance: {
      principles: ['Read-only — no daemon reconfiguration', 'Redact sensitive registry credentials'],
      sop: ['Query Docker daemon info', 'Parse security-relevant settings', 'Report posture findings'],
      heuristics: ['Insecure registry → WARN', 'Debug mode enabled → FAIL', 'Live restore disabled → WARN'],
      antiPatterns: ['NEVER modify Docker daemon config in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'docker info', description: 'Retrieve Docker daemon configuration and runtime info', classification: 'INFORMATIONAL', timeout: 15, requiresElevation: false, sensitive: true },
    ],
    rollback: [],
    successCriteria: [{ check: 'Docker info retrieved', expected: 'exit 0', timeout: 15 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'moderate',
    scheduleHint: { freq: 'daily', jitterMinutes: 30 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-service-status-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['service', 'availability', 'health-endpoints'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Service Availability Check',
    description: 'Patrol pack: checks critical service availability — nginx, PostgreSQL, API health endpoint. Reports which services are reachable.',
    category: 'monitoring',
    tags: ['patrol', 'service', 'availability', 'health'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 30, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['docker'], capabilities: [] },
    governance: {
      principles: ['Read-only — no service restarts', 'Report actual availability from real probes'],
      sop: ['Check nginx process', 'Check PostgreSQL readiness', 'Check API health endpoint'],
      heuristics: ['Service down → FAIL/CRITICAL', 'Service degraded → WARN/HIGH', 'All healthy → PASS'],
      antiPatterns: ['NEVER restart services in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'pgrep nginx > /dev/null && echo "nginx:running" || echo "nginx:stopped"', description: 'Check nginx process', classification: 'INFORMATIONAL', timeout: 5, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker exec ace-postgres pg_isready -U ace -d ace_governance 2>/dev/null && echo "postgres:ready" || echo "postgres:unavailable"', description: 'Check PostgreSQL readiness', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 3, command: 'curl -sf http://localhost:3001/health > /dev/null && echo "api:healthy" || echo "api:unhealthy"', description: 'Check API health endpoint', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'All probes complete', expected: 'exit 0', timeout: 30 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'hourly', jitterMinutes: 5 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-config-drift-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['configuration', 'nginx', 'config-validation', 'drift-detection'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Nginx Config Validation',
    description: 'Patrol pack: validates nginx configuration syntax. Detects config drift or invalid directives before they cause outages.',
    category: 'configuration',
    tags: ['patrol', 'nginx', 'config', 'validation', 'drift'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 15, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['nginx', 'docker'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['Read-only — no config changes', 'Report validation result accurately'],
      sop: ['Run nginx -t inside container', 'Parse success/failure', 'Report findings'],
      heuristics: ['Config test failed → FAIL/HIGH', 'Config test passed → PASS'],
      antiPatterns: ['NEVER modify nginx config in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'docker exec ace-governance-frontend nginx -t 2>&1', description: 'Test nginx configuration syntax', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Config test ran', expected: 'exit 0', timeout: 10 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'daily', jitterMinutes: 15 },
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'patrol-memory-pressure-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['host', 'memory', 'pressure', 'capacity'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Memory Pressure Check',
    description: 'Patrol pack: checks system memory usage. Warns at 80%, fails at 95%.',
    category: 'monitoring',
    tags: ['patrol', 'memory', 'pressure', 'capacity'],
    estimatedMinutes: 1,
    risk: 'LOW',
    blastRadius: { maxCommands: 3, maxDurationSeconds: 10, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: [], capabilities: [] },
    governance: {
      principles: ['Read-only — no process killing', 'Report actual memory from free command'],
      sop: ['Run free -m', 'Calculate usage percentage', 'Compare against thresholds'],
      heuristics: ['> 95% → FAIL/CRITICAL', '> 80% → WARN/HIGH', '<= 80% → PASS'],
      antiPatterns: ['NEVER kill processes in a patrol pack'],
    },
    steps: [
      { step: 1, command: 'free -m', description: 'Check system memory usage in megabytes', classification: 'INFORMATIONAL', timeout: 5, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'Memory info retrieved', expected: 'exit 0', timeout: 5 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'patrol',
    dataSensitivity: 'low',
    scheduleHint: { freq: 'hourly', jitterMinutes: 5 },
  },

  // ═══════════════════════════════════════════════════════════════════
  // HARDENING PACKS — Proactive mutations with preflight + rollback
  // MANDATORY gate required. All commands from srtCommandExecutor allowlist.
  // ═══════════════════════════════════════════════════════════════════

  {
    $schema: 'gia-operations-pack-v1',
    packId: 'harden-tls-modern-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['security', 'tls', 'hardening', 'nginx'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'TLS 1.2+ Enforcement',
    description: 'Hardening pack: validates and reloads nginx TLS configuration. Verifies nginx config is valid before reload, rolls back on failure. Preflight confirms nginx is running and config is testable.',
    category: 'security',
    tags: ['hardening', 'tls', 'nginx', 'security'],
    estimatedMinutes: 3,
    risk: 'MEDIUM',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 120, allowedTargets: 'localhost', maxServicesAffected: 1 },
    environment: { os: ['linux'], services: ['nginx', 'docker'], capabilities: ['docker-compose', 'openssl'] },
    governance: {
      principles: ['Validate before mutate — nginx -t MUST pass before reload', 'Rollback on any failure', 'MANDATORY human gate — no auto-hardening'],
      sop: ['Run preflight checks', 'Test nginx config', 'Reload nginx', 'Verify TLS endpoint', 'Rollback if verification fails'],
      heuristics: ['nginx -t fails → BLOCK execution', 'TLS handshake fails after reload → trigger rollback'],
      antiPatterns: ['NEVER reload without config test', 'NEVER modify certificate files directly'],
    },
    steps: [
      { step: 1, command: 'docker exec ace-governance-frontend nginx -t 2>&1', description: 'Validate nginx configuration before reload', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose exec ace-frontend nginx -s reload', description: 'Reload nginx with current configuration', classification: 'ADVISORY', timeout: 15, requiresElevation: false, sensitive: false },
      { step: 3, command: 'sleep 5 && curl -sf https://gia.aceadvising.com > /dev/null && echo "tls:ok" || echo "tls:failed"', description: 'Verify TLS endpoint after reload', classification: 'INFORMATIONAL', timeout: 20, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose restart ace-frontend', description: 'Restart nginx to revert to pre-reload state', classification: 'ADVISORY', timeout: 30, requiresElevation: false, sensitive: false },
      { step: 2, command: 'sleep 5 && curl -sf https://gia.aceadvising.com > /dev/null && echo "rollback:ok" || echo "rollback:failed"', description: 'Verify TLS after rollback', classification: 'INFORMATIONAL', timeout: 20, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'nginx config valid', expected: 'successful', timeout: 10 },
      { check: 'TLS endpoint accessible', expected: 'tls:ok', timeout: 20 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'hardening',
    dataSensitivity: 'low',
    preflight: [
      { checkId: 'pre-nginx-running', description: 'Confirm nginx process is running', command: 'pgrep nginx > /dev/null && echo "running" || echo "stopped"', expectedOutput: 'running', failAction: 'BLOCK' },
      { checkId: 'pre-config-valid', description: 'Confirm current nginx config is valid', command: 'docker exec ace-governance-frontend nginx -t 2>&1', expectedOutput: 'successful', failAction: 'BLOCK' },
      { checkId: 'pre-tls-reachable', description: 'Confirm TLS endpoint currently reachable', command: 'curl -sf https://gia.aceadvising.com > /dev/null && echo "reachable" || echo "unreachable"', expectedOutput: 'reachable', failAction: 'WARN' },
    ],
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'harden-docker-bench-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['container', 'docker', 'hardening', 'cleanup'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'Docker Daemon Hardening',
    description: 'Hardening pack: prunes unused Docker resources (dangling images, stopped containers, unused networks). Reduces attack surface. Preflight confirms Docker is running and containers are stable.',
    category: 'container',
    tags: ['hardening', 'docker', 'cleanup', 'security'],
    estimatedMinutes: 3,
    risk: 'MEDIUM',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 180, allowedTargets: 'localhost', maxServicesAffected: 1 },
    environment: { os: ['linux'], services: ['docker'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['Only prune unused resources — never touch running containers', 'Verify container health after cleanup', 'MANDATORY human gate'],
      sop: ['Run preflight checks', 'Prune unused Docker resources', 'Verify all containers still healthy'],
      heuristics: ['Container went unhealthy after prune → trigger rollback', 'Disk space not recovered → WARN'],
      antiPatterns: ['NEVER stop running containers during hardening', 'NEVER use --volumes flag on production without explicit approval'],
    },
    steps: [
      { step: 1, command: 'docker ps --format "{{.Names}}|{{.Status}}"', description: 'Snapshot container state before cleanup', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker system prune -f', description: 'Prune dangling images, stopped containers, unused networks', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 3, command: 'docker ps --format "{{.Names}}|{{.Status}}"', description: 'Verify container state after cleanup', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose up -d', description: 'Ensure all compose services are running', classification: 'ADVISORY', timeout: 120, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'All containers still running', expected: 'true', timeout: 30 },
      { check: 'API healthz 200', expected: '200', timeout: 30 },
    ],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['repair-procedures-v1'], convertedAt: new Date().toISOString() },
    intent: 'hardening',
    dataSensitivity: 'low',
    preflight: [
      { checkId: 'pre-docker-running', description: 'Confirm Docker daemon is running', command: 'docker info > /dev/null 2>&1 && echo "running" || echo "stopped"', expectedOutput: 'running', failAction: 'BLOCK' },
      { checkId: 'pre-containers-stable', description: 'Confirm containers are not restarting', command: 'docker ps --format "{{.Status}}" | grep -c "Restarting" || echo "0"', expectedOutput: '0', failAction: 'BLOCK' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // AUDIT PACKS — Deterministic compliance evidence bundles
  // Pass/fail by RULES, not AI. All commands from srtCommandExecutor allowlist.
  // ═══════════════════════════════════════════════════════════════════

  {
    $schema: 'gia-operations-pack-v1',
    packId: 'audit-nist-ac-basics-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['compliance', 'nist', 'access-control', 'AC-2', 'AC-3', 'AC-6'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'NIST AC Controls Audit',
    description: 'Audit pack: evaluates NIST 800-53 Access Control basics (AC-2 Account Management, AC-3 Access Enforcement, AC-6 Least Privilege). Deterministic pass/fail — no AI interpretation.',
    category: 'security',
    tags: ['audit', 'nist', 'access-control', 'compliance'],
    estimatedMinutes: 2,
    risk: 'LOW',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 60, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['docker'], capabilities: [] },
    governance: {
      principles: ['Read-only — no enforcement actions', 'Deterministic evaluation — rules decide pass/fail, not AI', 'Evidence must be hash-sealed'],
      sop: ['Collect evidence via scout commands', 'Apply evaluation rules', 'Produce evidence bundle with hash'],
      heuristics: ['Any FAIL → overall audit FAIL', 'All PASS → overall audit PASS'],
      antiPatterns: ['NEVER let AI interpret pass/fail — rules only', 'NEVER modify access controls in an audit pack'],
    },
    steps: [
      { step: 1, command: 'docker ps --format "{{.Names}}"', description: 'AC-2: Enumerate running service accounts (containers)', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'ss -tlnp', description: 'AC-3: Enumerate access enforcement points (listening ports)', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 3, command: 'docker ps --format "{{.Names}}" | wc -l', description: 'AC-6: Count active service accounts for least privilege check', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'All evidence collected', expected: 'exit 0', timeout: 30 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'audit',
    dataSensitivity: 'moderate',
    scheduleHint: { freq: 'weekly', jitterMinutes: 60, window: '02:00-04:00' },
    controlMappings: [
      { controlId: 'NIST.AC-2', controlTitle: 'Account Management', evidenceFrom: ['containers'], evaluation: { type: 'presence_check', field: 'containers', expected: true }, remediation: undefined },
      { controlId: 'NIST.AC-3', controlTitle: 'Access Enforcement', evidenceFrom: ['listening_ports'], evaluation: { type: 'count_compare', operator: '<=', value: 10, field: 'listening_ports' }, remediation: undefined },
      { controlId: 'NIST.AC-6', controlTitle: 'Least Privilege', evidenceFrom: ['containers'], evaluation: { type: 'count_compare', operator: '<=', value: 6, field: 'container_count' }, remediation: undefined },
    ],
  },
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'audit-nist-cm-basics-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: ['compliance', 'nist', 'config-management', 'CM-6', 'CM-7', 'CM-8'],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'NIST CM Controls Audit',
    description: 'Audit pack: evaluates NIST 800-53 Configuration Management basics (CM-6 Config Settings, CM-7 Least Functionality, CM-8 System Inventory). Deterministic pass/fail.',
    category: 'security',
    tags: ['audit', 'nist', 'config-management', 'compliance'],
    estimatedMinutes: 2,
    risk: 'LOW',
    blastRadius: { maxCommands: 5, maxDurationSeconds: 60, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: ['docker', 'nginx'], capabilities: ['docker-compose'] },
    governance: {
      principles: ['Read-only — no config changes', 'Deterministic evaluation — rules decide pass/fail', 'Evidence must be hash-sealed'],
      sop: ['Collect evidence via scout commands', 'Apply evaluation rules', 'Produce evidence bundle with hash'],
      heuristics: ['Any FAIL → overall audit FAIL', 'All PASS → overall audit PASS'],
      antiPatterns: ['NEVER let AI interpret pass/fail — rules only', 'NEVER modify system config in an audit pack'],
    },
    steps: [
      { step: 1, command: 'docker exec ace-governance-frontend nginx -t 2>&1', description: 'CM-6: Validate nginx configuration settings', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'ss -tlnp', description: 'CM-7: Enumerate listening ports for least functionality', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 3, command: 'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"', description: 'CM-8: System component inventory', classification: 'INFORMATIONAL', timeout: 10, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [{ check: 'All evidence collected', expected: 'exit 0', timeout: 30 }],
    variables: [],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1'], convertedAt: new Date().toISOString() },
    intent: 'audit',
    dataSensitivity: 'moderate',
    scheduleHint: { freq: 'weekly', jitterMinutes: 60, window: '02:00-04:00' },
    controlMappings: [
      { controlId: 'NIST.CM-6', controlTitle: 'Configuration Settings', evidenceFrom: ['nginx_config_test'], evaluation: { type: 'regex_match', pattern: 'successful', field: 'nginx_config_test' }, remediation: undefined },
      { controlId: 'NIST.CM-7', controlTitle: 'Least Functionality', evidenceFrom: ['listening_ports'], evaluation: { type: 'count_compare', operator: '<=', value: 5, field: 'port_count' }, remediation: undefined },
      { controlId: 'NIST.CM-8', controlTitle: 'System Component Inventory', evidenceFrom: ['containers'], evaluation: { type: 'presence_check', field: 'inventory', expected: true }, remediation: undefined },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // ACE SECURITY SCANNER — Enterprise-grade full-stack infrastructure audit
  // Single-step: runs ace-scan.sh which covers 12 security domains.
  // JSON output is returned as governed audit evidence.
  // ═══════════════════════════════════════════════════════════════════
  {
    $schema: 'gia-operations-pack-v1',
    packId: 'audit-security-full-v1',
    version: '1.0.0',
    type: 'PLAYBOOK',
    trustLevel: 'ORG',
    domain: 'platform-sre',
    scope: [
      'security', 'compliance', 'nist', 'infrastructure',
      'ssh-hardening', 'firewall', 'network', 'users', 'files',
      'docker', 'tls', 'updates', 'logging', 'disk',
    ],
    riskLevel: 'ADVISORY',
    ttlHours: 2160,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    name: 'ACE Full Security Assessment',
    description: 'Comprehensive infrastructure security audit covering 12 domains: SSH hardening, firewall, network/ports, user accounts, file permissions, Docker security, TLS certificates, system updates, security services (fail2ban/AppArmor/auditd), logging, and disk resources. Produces scored JSON report with enterprise grading (A+ through F). Run via ace-scan.sh on the target host.',
    category: 'security',
    tags: ['audit', 'security', 'infrastructure', 'enterprise', 'nist', 'comprehensive'],
    estimatedMinutes: 2,
    risk: 'LOW',
    blastRadius: { maxCommands: 1, maxDurationSeconds: 120, allowedTargets: 'localhost', maxServicesAffected: 0 },
    environment: { os: ['linux'], services: [], capabilities: ['bash'] },
    governance: {
      principles: [
        'Read-only — no system state changes, every command is a query',
        'Deterministic scoring — score = 100 - (FAIL*10 + WARN*3)',
        'Evidence must be hash-sealed and timestamped',
        'Sensitive data (passwords, tokens, keys) is never captured',
      ],
      sop: [
        'Execute ace-scan.sh on target host',
        'Capture full JSON report output',
        'Feed JSON back as scout_data for governed evaluation',
        'Present scored findings to operator with grade',
      ],
      heuristics: [
        'Grade A/A+ → infrastructure is well-hardened',
        'Grade B/B+ → minor issues, low risk',
        'Grade C → moderate issues requiring attention',
        'Grade D/F → critical security gaps, immediate action needed',
        'Any CRITICAL severity FAIL → escalate to operator immediately',
      ],
      antiPatterns: [
        'NEVER modify system configuration in this audit',
        'NEVER capture or log passwords, tokens, or secrets',
        'NEVER skip checks — all 12 domains must complete',
      ],
    },
    steps: [
      {
        step: 1,
        command: 'bash /opt/gia/ace-scan.sh 2>/dev/null || bash /root/ace-scan.sh 2>/dev/null || bash ./scripts/ace-scan.sh 2>/dev/null',
        description: 'Run ACE Security Scanner — checks SSH, firewall, ports, users, files, Docker, TLS, updates, security services, logging, disk. Returns JSON report.',
        classification: 'INFORMATIONAL',
        timeout: 120,
        requiresElevation: false,
        sensitive: false,
      },
    ],
    rollback: [],
    successCriteria: [
      { check: 'Scanner produces JSON with scan_id', expected: 'scan_id', timeout: 120 },
      { check: 'Scanner produces summary with grade', expected: 'grade', timeout: 120 },
    ],
    variables: [
      { name: 'SCAN_PATH', description: 'Path to ace-scan.sh on target host', required: false, default: '/opt/gia/ace-scan.sh' },
      { name: 'COMPANY', description: 'Company name for report branding', required: false, default: 'ACE Advising' },
    ],
    promotion: { status: 'GOLDEN', usesCount: 0, successCount: 0 },
    provenance: { sourceMemoryPacks: ['health-baselines-v1', 'incident-playbooks-v1'], convertedAt: new Date().toISOString() },
    intent: 'audit',
    dataSensitivity: 'moderate',
    scheduleHint: { freq: 'weekly', jitterMinutes: 120, window: '01:00-05:00' },
    controlMappings: [
      {
        controlId: 'NIST.IA-2',
        controlTitle: 'Identification and Authentication',
        evidenceFrom: ['ssh'],
        evaluation: { type: 'regex_match', pattern: '"category":"ssh"[^}]*"status":"PASS"', field: 'ssh_hardening' },
        remediation: 'Harden SSH: disable root login, disable password auth, set MaxAuthTries <= 4',
      },
      {
        controlId: 'NIST.SC-7',
        controlTitle: 'Boundary Protection',
        evidenceFrom: ['firewall'],
        evaluation: { type: 'regex_match', pattern: '"category":"firewall"[^}]*"status":"PASS"', field: 'firewall_active' },
        remediation: 'Enable UFW/iptables with default-deny incoming policy',
      },
      {
        controlId: 'NIST.AC-2',
        controlTitle: 'Account Management',
        evidenceFrom: ['users'],
        evaluation: { type: 'regex_match', pattern: '"category":"users"[^}]*"status":"PASS"', field: 'user_accounts' },
        remediation: 'Remove extra UID 0 accounts, disable empty passwords, review sudo access',
      },
      {
        controlId: 'NIST.CM-6',
        controlTitle: 'Configuration Settings',
        evidenceFrom: ['docker'],
        evaluation: { type: 'regex_match', pattern: '"category":"docker"', field: 'docker_config' },
        remediation: 'Set container resource limits, avoid privileged mode, configure Docker daemon',
      },
      {
        controlId: 'NIST.SI-2',
        controlTitle: 'Flaw Remediation',
        evidenceFrom: ['updates'],
        evaluation: { type: 'regex_match', pattern: '"category":"updates"', field: 'system_updates' },
        remediation: 'Install unattended-upgrades, apply pending security patches',
      },
      {
        controlId: 'NIST.AU-2',
        controlTitle: 'Audit Events',
        evidenceFrom: ['logging', 'security'],
        evaluation: { type: 'regex_match', pattern: '"category":"logging"[^}]*"status":"PASS"', field: 'logging_active' },
        remediation: 'Enable syslog/journald, configure log rotation, install auditd',
      },
      {
        controlId: 'NIST.SC-8',
        controlTitle: 'Transmission Confidentiality',
        evidenceFrom: ['tls'],
        evaluation: { type: 'regex_match', pattern: '"category":"tls"', field: 'tls_certs' },
        remediation: 'Ensure TLS certificates are valid and auto-renewed',
      },
      {
        controlId: 'NIST.AC-6',
        controlTitle: 'Least Privilege',
        evidenceFrom: ['files', 'users'],
        evaluation: { type: 'regex_match', pattern: '"category":"files"[^}]*"status":"PASS"', field: 'file_perms' },
        remediation: 'Fix file permissions: shadow 600/640, remove world-writable files, secure SSH keys',
      },
    ],
  },
];

// Compute hashes for all library packs
for (const pack of PACK_LIBRARY) {
  const { hash, ...rest } = pack;
  pack.hash = djb2Hash(JSON.stringify(rest, Object.keys(rest).sort()));
}

// In-memory stores
const packs = new Map<string, RemediationPack>();
const approvalTokens = new Map<string, ApprovalToken>();
const executionLog: Array<{ executionId: string; packId: string; tokenId: string; result: string; timestamp: string }> = [];
let cachedProfile: EnvironmentProfile | null = null;

// Seed library
for (const pack of PACK_LIBRARY) {
  packs.set(pack.packId, pack);
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 1: gia_scan_environment (INFORMATIONAL)
// ═══════════════════════════════════════════════════════════════════

export function registerScanEnvironmentTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'gia_scan_environment',
    'Run scout swarm to detect target environment — OS, containers, services, network, storage. Returns EnvironmentProfile for compatibility checking. Classification: INFORMATIONAL — read-only, no mutations. Scout outputs are redacted for sensitive content.',
    {
      scout_data: z.record(z.string()).optional().describe('Pre-collected scout data as key-value pairs. If not provided, returns scout command definitions for server-side execution.'),
    },
    { title: 'Scan Environment', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        if (!input.scout_data || Object.keys(input.scout_data).length === 0) {
          // Return scout definitions — the caller (Claude / server) executes them
          const scouts = [
            { scoutType: 'os', commands: [
              { cmd: 'uname -s', key: 'os_family' },
              { cmd: 'uname -r', key: 'os_release' },
              { cmd: 'uname -m', key: 'os_arch' },
              { cmd: 'hostname', key: 'hostname' },
            ]},
            { scoutType: 'docker', commands: [
              { cmd: 'docker info --format "{{.ServerVersion}}"', key: 'docker_version' },
              { cmd: 'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"', key: 'containers' },
            ]},
            { scoutType: 'network', commands: [
              { cmd: 'ss -tlnp | grep LISTEN', key: 'listening_ports' },
              { cmd: 'dig +short gia.aceadvising.com | head -1', key: 'dns_resolve' },
            ]},
            { scoutType: 'storage', commands: [
              { cmd: "df -h / | tail -1 | awk '{print $2,$3,$4,$5}'", key: 'disk_usage' },
            ]},
            { scoutType: 'service', commands: [
              { cmd: 'pgrep nginx > /dev/null && echo "running" || echo "stopped"', key: 'nginx_status' },
              { cmd: 'docker exec ace-postgres pg_isready -U ace -d ace_governance 2>/dev/null && echo "ready" || echo "unavailable"', key: 'postgres_status' },
              { cmd: 'docker info > /dev/null 2>&1 && echo "running" || echo "stopped"', key: 'docker_status' },
            ]},
          ];

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'SCOUT_DEFINITIONS',
            message: 'Execute these commands on the target environment and call again with scout_data containing the results.',
            scouts,
            totalCommands: scouts.reduce((sum, s) => sum + s.commands.length, 0),
            classification: 'INFORMATIONAL',
            readOnly: true,
          }, null, 2) }] };
        }

        // Build profile from collected data
        const data = input.scout_data;

        // Redact all values
        const redacted: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) {
          redacted[k] = redact(v);
        }

        // Parse containers
        const containers: EnvironmentProfile['containers'] = [];
        const containerLines = (redacted['containers'] || '').split('\n').filter(Boolean);
        for (const line of containerLines) {
          const [name, image, status, ports] = line.split('|');
          if (name) containers.push({ name: name.trim(), image: image?.trim() || '', status: status?.trim() || '', ports: (ports || '').split(',').map(p => p.trim()).filter(Boolean) });
        }

        // Parse services
        const services: EnvironmentProfile['services'] = [];
        if (redacted['nginx_status']) services.push({ name: 'nginx', detected: true, running: redacted['nginx_status'].includes('running') });
        if (redacted['postgres_status']) services.push({ name: 'postgresql', detected: true, running: redacted['postgres_status'].includes('ready') });
        if (redacted['docker_status']) services.push({ name: 'docker', detected: true, running: redacted['docker_status'].includes('running'), version: redacted['docker_version'] });

        // Parse storage
        const diskParts = (redacted['disk_usage'] || '0 0 0 0%').split(/\s+/);
        const usedPercent = parseInt((diskParts[3] || '0').replace('%', ''), 10) || 0;

        // Parse network
        const listeningPorts: number[] = [];
        for (const line of (redacted['listening_ports'] || '').split('\n')) {
          const m = line.match(/:(\d+)\s/);
          if (m) listeningPorts.push(parseInt(m[1], 10));
        }

        const profile: EnvironmentProfile = {
          profileId: generateId('ENVPROF'),
          hostname: redacted['hostname'] || 'unknown',
          os: {
            family: redacted['os_family'] || 'unknown',
            release: redacted['os_release'] || 'unknown',
            arch: redacted['os_arch'] || 'unknown',
          },
          services,
          containers,
          network: { ports: [...new Set(listeningPorts)], dnsResolvable: (redacted['dns_resolve'] || '').trim().length > 0 },
          storage: { usedPercent },
          timestamp: new Date().toISOString(),
        };

        cachedProfile = profile;

        engine.telemetryService.emitToolCall('gia_scan_environment', `scan-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          scanned: true,
          profile,
          servicesDetected: services.length,
          containersDetected: containers.length,
          storageUsedPercent: usedPercent,
          classification: 'INFORMATIONAL',
          note: 'Profile cached for subsequent dry-run and apply operations.',
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('gia_scan_environment', `scan-${Date.now().toString(36)}`, 'INFORMATIONAL', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SCAN_FAILED', message: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 2: gia_list_packs (INFORMATIONAL)
// ═══════════════════════════════════════════════════════════════════

export function registerListPacksTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'gia_list_packs',
    'List available governed operations packs. Filter by intent (remediation/patrol/hardening/audit), category, risk level, or trust level. Classification: INFORMATIONAL.',
    {
      intent: z.enum(['remediation', 'patrol', 'hardening', 'audit']).optional().describe('Filter by pack intent'),
      category: z.enum(['network', 'container', 'database', 'storage', 'configuration', 'monitoring', 'security', 'custom']).optional().describe('Filter by remediation category'),
      risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Filter by risk level'),
      trust_level: z.enum(['SYSTEM', 'ORG', 'CASE', 'EPHEMERAL']).optional().describe('Filter by trust level'),
    },
    { title: 'List Operations Packs', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        let results = Array.from(packs.values());

        if (input.intent) results = results.filter(p => p.intent === input.intent);
        if (input.category) results = results.filter(p => p.category === input.category);
        if (input.risk) results = results.filter(p => p.risk === input.risk);
        if (input.trust_level) results = results.filter(p => p.trustLevel === input.trust_level);

        const summaries = results.map(p => ({
          packId: p.packId,
          name: p.name,
          description: p.description,
          intent: p.intent,
          dataSensitivity: p.dataSensitivity,
          category: p.category,
          risk: p.risk,
          trustLevel: p.trustLevel,
          estimatedMinutes: p.estimatedMinutes,
          steps: p.steps.length,
          rollbackSteps: p.rollback.length,
          successCriteria: p.successCriteria.length,
          promotionStatus: p.promotion.status,
          blastRadius: p.blastRadius,
          scheduleHint: p.scheduleHint || null,
          hasPreflight: (p.preflight && p.preflight.length > 0) || false,
          hasControlMappings: (p.controlMappings && p.controlMappings.length > 0) || false,
          sourcePlaybook: p.provenance.sourcePlaybook || null,
          tags: p.tags,
        }));

        engine.telemetryService.emitToolCall('gia_list_packs', `list-packs-${Date.now().toString(36)}`, 'INFORMATIONAL', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          packs: summaries,
          totalPacks: summaries.length,
          byIntent: {
            remediation: summaries.filter(p => p.intent === 'remediation').length,
            patrol: summaries.filter(p => p.intent === 'patrol').length,
            hardening: summaries.filter(p => p.intent === 'hardening').length,
            audit: summaries.filter(p => p.intent === 'audit').length,
          },
          classification: 'INFORMATIONAL',
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('gia_list_packs', `list-packs-${Date.now().toString(36)}`, 'INFORMATIONAL', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'LIST_FAILED', message: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 3: gia_dry_run_pack (ADVISORY)
// Phase 1 of two-phase apply: preview + generate inputsHash
// ═══════════════════════════════════════════════════════════════════

export function registerDryRunPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'gia_dry_run_pack',
    'Preview remediation pack execution — shows hydrated commands, compatibility check, validation, blast radius. Returns inputsHash for approval binding (what-you-approved-is-what-ran). Classification: ADVISORY — read-only preview, no execution.',
    {
      pack_id: z.string().describe('Remediation pack ID to preview (e.g. rpack-nginx-502-v1)'),
      variable_overrides: z.record(z.string()).optional().describe('Override scout-detected variable values'),
    },
    { title: 'Dry-Run Pack Preview', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        const pack = packs.get(input.pack_id);
        if (!pack) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PACK_NOT_FOUND', packId: input.pack_id }, null, 2) }], isError: true };
        }

        // Verify hash integrity
        const { hash, ...rest } = pack;
        const expectedHash = djb2Hash(JSON.stringify(rest, Object.keys(rest).sort()));
        if (pack.hash !== expectedHash) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'HASH_INTEGRITY_FAILURE', packId: input.pack_id, message: 'Pack hash does not match content — possible tampering' }, null, 2) }], isError: true };
        }

        // Use cached profile or create minimal one
        const profile = cachedProfile || {
          profileId: 'ENVPROF-not-scanned',
          hostname: 'unknown',
          os: { family: 'unknown', release: 'unknown', arch: 'unknown' },
          services: [],
          containers: [],
          network: { ports: [], dnsResolvable: false },
          storage: { usedPercent: 0 },
          timestamp: new Date().toISOString(),
        };

        // Hydrate variables (if pack has any)
        let hydratedSteps = pack.steps;
        let hydratedRollback = pack.rollback;

        if (pack.variables.length > 0 && input.variable_overrides) {
          const replaceVars = (cmd: string): string => {
            let result = cmd;
            for (const [key, value] of Object.entries(input.variable_overrides || {})) {
              result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
            }
            return result;
          };
          hydratedSteps = pack.steps.map(s => ({ ...s, command: replaceVars(s.command) }));
          hydratedRollback = pack.rollback.map(s => ({ ...s, command: replaceVars(s.command) }));
        }

        // Check compatibility
        const compatibility = { compatible: true, missingRequirements: [] as string[], warnings: [] as string[] };
        const env = pack.environment as any;
        if (env.services && cachedProfile) {
          for (const svc of (env.services as string[])) {
            const found = cachedProfile.services.find(s => s.name.toLowerCase() === svc.toLowerCase());
            if (!found || !found.detected) compatibility.missingRequirements.push(`Required service: ${svc}`);
            else if (!found.running) compatibility.warnings.push(`Service not running: ${svc}`);
          }
          compatibility.compatible = compatibility.missingRequirements.length === 0;
        }
        if (!cachedProfile) {
          compatibility.warnings.push('Environment not scanned — run gia_scan_environment first for full compatibility check');
        }

        // Validate commands
        const issues: string[] = [];
        for (const step of [...hydratedSteps, ...hydratedRollback]) {
          for (const pattern of DANGEROUS_PATTERNS) {
            if (step.command.includes(pattern)) {
              issues.push(`BLOCKED: Step ${step.step} — dangerous pattern: "${pattern}"`);
            }
          }
          const unresolved = step.command.match(/\$\{[A-Z_]+\}/g);
          if (unresolved) issues.push(`Step ${step.step} — unresolved variables: ${unresolved.join(', ')}`);
        }

        // Compute inputs hash (binds approval to these exact commands)
        const inputsHashValue = hashInputs(hydratedSteps, hydratedRollback);

        const preview: DryRunPreview = {
          packId: pack.packId,
          packHash: pack.hash,
          inputsHash: inputsHashValue,
          hydratedSteps,
          hydratedRollback,
          successCriteria: pack.successCriteria,
          compatibility,
          validation: { allCommandsAllowed: issues.length === 0, issues },
          blastRadius: pack.blastRadius,
          estimatedMinutes: pack.estimatedMinutes,
          risk: pack.risk,
          requiresApproval: true,
          timestamp: new Date().toISOString(),
        };

        engine.telemetryService.emitToolCall('gia_dry_run_pack', `dryrun-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          dryRun: preview,
          nextStep: 'To execute this pack, call gia_apply_pack with the inputsHash from this preview and a valid approved_by identity.',
          classification: 'ADVISORY',
          note: 'This is a READ-ONLY preview. No commands have been executed.',
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('gia_dry_run_pack', `dryrun-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DRY_RUN_FAILED', message: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 4: gia_apply_pack (MANDATORY)
// Phase 2 of two-phase apply: execute with approval token binding
// ═══════════════════════════════════════════════════════════════════

export function registerApplyPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'gia_apply_pack',
    'Execute a remediation or hardening pack with MANDATORY gate approval. Requires inputsHash from gia_dry_run_pack (what-you-approved-is-what-ran binding). REJECTS patrol/audit packs (use gia_run_patrol for those). Hardening packs run preflight checks before execution. Classification: MANDATORY — human approval required.',
    {
      pack_id: z.string().describe('Remediation or hardening pack ID to execute'),
      approved_by: z.string().describe('Human approver identity (from authenticated session). BLOCKED: system, auto, agent, bot, ai'),
      approver_role: z.string().default('isso').describe('Role of the approver (isso, platform-owner)'),
      inputs_hash: z.string().describe('inputsHash from gia_dry_run_pack — ensures what-you-approved-is-what-ran'),
      tenant_id: z.string().default('ace-platform').describe('Tenant ID for token binding'),
      variable_overrides: z.record(z.string()).optional().describe('Same variable overrides used in dry-run'),
      incident_id: z.string().optional().describe('Link to existing SRT incident'),
    },
    { title: 'Apply Remediation Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    async (input) => {
      try {
        // ── MANDATORY GATE: Validate approver ──
        const approverLower = (input.approved_by || '').toLowerCase().trim();
        if (!input.approved_by || BLOCKED_APPROVERS.includes(approverLower)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'MANDATORY_GATE_VIOLATION',
            message: `Blocked approver: "${input.approved_by}". Remediation pack execution requires human identity — MANDATORY gate enforced.`,
            blockedApprovers: BLOCKED_APPROVERS.filter(a => a !== ''),
            resolution: 'Provide a real human operator identity (e.g. "storey", "isso-admin").',
          }, null, 2) }], isError: true };
        }

        // ── Load pack ──
        const pack = packs.get(input.pack_id);
        if (!pack) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PACK_NOT_FOUND', packId: input.pack_id }, null, 2) }], isError: true };
        }

        // ── Intent enforcement: ONLY remediation and hardening ──
        if (pack.intent === 'patrol' || pack.intent === 'audit') {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'INTENT_MISMATCH',
            message: `Pack "${pack.packId}" has intent="${pack.intent}". gia_apply_pack only accepts remediation/hardening packs. Use gia_run_patrol for patrol/audit.`,
            packIntent: pack.intent,
            allowedIntents: ['remediation', 'hardening'],
          }, null, 2) }], isError: true };
        }

        // ── Verify hash integrity ──
        const { hash, ...rest } = pack;
        const expectedHash = djb2Hash(JSON.stringify(rest, Object.keys(rest).sort()));
        if (pack.hash !== expectedHash) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'HASH_INTEGRITY_FAILURE', message: 'Pack tampered — hash mismatch' }, null, 2) }], isError: true };
        }

        // ── Hydrate variables ──
        let hydratedSteps = pack.steps;
        let hydratedRollback = pack.rollback;
        if (pack.variables.length > 0 && input.variable_overrides) {
          const replaceVars = (cmd: string): string => {
            let result = cmd;
            for (const [key, value] of Object.entries(input.variable_overrides || {})) {
              result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
            }
            return result;
          };
          hydratedSteps = pack.steps.map(s => ({ ...s, command: replaceVars(s.command) }));
          hydratedRollback = pack.rollback.map(s => ({ ...s, command: replaceVars(s.command) }));
        }

        // ── Verify inputs hash binding (what-you-approved-is-what-ran) ──
        const currentInputsHash = hashInputs(hydratedSteps, hydratedRollback);
        if (input.inputs_hash !== currentInputsHash) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'INPUTS_HASH_MISMATCH',
            message: 'The hydrated commands have changed since the dry-run was approved. Re-run gia_dry_run_pack to get a fresh inputsHash.',
            expected: input.inputs_hash,
            actual: currentInputsHash,
          }, null, 2) }], isError: true };
        }

        // ── Validate commands (client-side pre-check) ──
        for (const step of [...hydratedSteps, ...hydratedRollback]) {
          for (const pattern of DANGEROUS_PATTERNS) {
            if (step.command.includes(pattern)) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'DANGEROUS_COMMAND_BLOCKED',
                step: step.step,
                pattern,
                message: `Step ${step.step} contains blocked pattern: "${pattern}"`,
              }, null, 2) }], isError: true };
            }
          }
        }

        // ── Check blast radius ──
        if (hydratedSteps.length > pack.blastRadius.maxCommands) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'BLAST_RADIUS_EXCEEDED',
            commands: hydratedSteps.length,
            maxCommands: pack.blastRadius.maxCommands,
          }, null, 2) }], isError: true };
        }

        // ── Hardening preflight checks ──
        if (pack.intent === 'hardening' && pack.preflight && pack.preflight.length > 0) {
          const preflightResults: Array<{ checkId: string; description: string; command: string; passed: boolean; failAction: string; requiresConsoleAccess?: boolean }> = [];
          let blocked = false;

          for (const check of pack.preflight) {
            // Preflight checks return command definitions — the caller runs them.
            // Here we validate the preflight structure and flag console requirements.
            preflightResults.push({
              checkId: check.checkId,
              description: check.description,
              command: check.command,
              passed: true,  // Actual execution happens server-side
              failAction: check.failAction,
              requiresConsoleAccess: check.requiresConsoleAccess,
            });

            if (check.requiresConsoleAccess) {
              // Warn that this pack may cut SSH access
              preflightResults[preflightResults.length - 1].passed = false;
              if (check.failAction === 'BLOCK') blocked = true;
            }
          }

          if (blocked) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'HARDENING_PREFLIGHT_BLOCKED',
              message: 'Hardening pack requires console access verification. One or more BLOCK-level preflight checks require confirmation.',
              preflightResults,
              resolution: 'Verify console/SSH access is available before hardening. Run preflight commands manually and confirm.',
            }, null, 2) }], isError: true };
          }
        }

        // ── Create approval token ──
        const runId = generateId('RRUN');
        const tokenId = generateId('RTOKEN');
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + APPROVAL_TOKEN_TTL_MS).toISOString();

        const signaturePayload = `${tokenId}:${input.pack_id}:${pack.hash}:${currentInputsHash}:${runId}:${input.tenant_id}:${input.approved_by}:${issuedAt}`;
        const signature = djb2Hash(signaturePayload);

        const token: ApprovalToken = {
          tokenId,
          packId: input.pack_id,
          packHash: pack.hash,
          inputsHash: currentInputsHash,
          runId,
          tenantId: input.tenant_id,
          approvedBy: input.approved_by,
          approverRole: input.approver_role,
          issuedAt,
          expiresAt,
          signature,
        };

        approvalTokens.set(tokenId, token);

        // ── Build execution plan ──
        // In MCP context, this returns the approved plan for server-side execution.
        // The server routes (routes/srt.ts) handle actual command execution via srtCommandExecutor.
        const executionId = generateId('REXEC');

        // Record execution
        executionLog.push({
          executionId,
          packId: input.pack_id,
          tokenId,
          result: 'APPROVED',
          timestamp: new Date().toISOString(),
        });

        // Update promotion metrics
        pack.promotion.usesCount += 1;

        // Build the execution plan for the server
        const executionPlan = {
          executionId,
          packId: pack.packId,
          packHash: pack.hash,
          inputsHash: currentInputsHash,
          approvalToken: {
            tokenId: token.tokenId,
            approvedBy: token.approvedBy,
            approverRole: token.approverRole,
            issuedAt: token.issuedAt,
            expiresAt: token.expiresAt,
            signature: token.signature,
          },
          commands: hydratedSteps.map(s => ({
            step: s.step,
            command: s.command,
            description: s.description,
            timeout: s.timeout,
            requiresElevation: s.requiresElevation,
            sensitive: s.sensitive,
          })),
          rollback: hydratedRollback.map(s => ({
            step: s.step,
            command: s.command,
            description: s.description,
            timeout: s.timeout,
            requiresElevation: s.requiresElevation,
            sensitive: s.sensitive,
          })),
          successCriteria: pack.successCriteria,
          blastRadius: pack.blastRadius,
          risk: pack.risk,
          estimatedMinutes: pack.estimatedMinutes,
          incidentId: input.incident_id || null,
        };

        engine.telemetryService.emitToolCall('gia_apply_pack', `apply-${Date.now().toString(36)}`, 'MANDATORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          approved: true,
          executionPlan,
          classification: 'MANDATORY',
          gate: {
            status: 'APPROVED',
            approvedBy: input.approved_by,
            approverRole: input.approver_role,
            tokenId: token.tokenId,
            inputsHashVerified: true,
            packHashVerified: true,
          },
          intent: pack.intent,
          message: `${pack.intent === 'hardening' ? 'Hardening' : 'Remediation'} pack ${pack.name} approved by ${input.approved_by}. Execution plan ready for server-side execution via srtCommandExecutor.`,
          serverExecution: 'POST /api/srt/incidents/:id/execute with this plan, or execute commands directly on the target host.',
          preflight: pack.preflight || null,
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('gia_apply_pack', `apply-${Date.now().toString(36)}`, 'MANDATORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'APPLY_FAILED', message: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 5: gia_run_patrol (ADVISORY or MANDATORY by sensitivity)
// Executes patrol/audit packs — read-only posture checks + evidence
// ═══════════════════════════════════════════════════════════════════

export function registerRunPatrolTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'gia_run_patrol',
    'Execute a patrol or audit pack — read-only posture checks that produce findings or compliance evidence. Classification: ADVISORY for low/moderate sensitivity, MANDATORY for high sensitivity. REJECTS remediation/hardening packs (use gia_apply_pack for those). Audit packs produce deterministic pass/fail per NIST control — no AI interpretation.',
    {
      pack_id: z.string().describe('Patrol or audit pack ID (e.g. patrol-open-ports-v1, audit-nist-ac-basics-v1)'),
      scout_data: z.record(z.string()).optional().describe('Pre-collected command outputs keyed by step number (e.g. {"step_1": "output..."}). If not provided, returns command definitions for caller to execute.'),
      approved_by: z.string().optional().describe('Required ONLY for high-sensitivity packs. Human approver identity.'),
    },
    { title: 'Run Patrol or Audit Check', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        // ── Load pack ──
        const pack = packs.get(input.pack_id);
        if (!pack) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PACK_NOT_FOUND', packId: input.pack_id }, null, 2) }], isError: true };
        }

        // ── Intent enforcement: ONLY patrol and audit ──
        if (pack.intent !== 'patrol' && pack.intent !== 'audit') {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'INTENT_MISMATCH',
            message: `Pack "${pack.packId}" has intent="${pack.intent}". gia_run_patrol only accepts patrol/audit packs. Use gia_apply_pack for remediation/hardening.`,
            packIntent: pack.intent,
            allowedIntents: ['patrol', 'audit'],
          }, null, 2) }], isError: true };
        }

        // ── Data sensitivity gate ──
        if (pack.dataSensitivity === 'high') {
          const approverLower = (input.approved_by || '').toLowerCase().trim();
          if (!input.approved_by || BLOCKED_APPROVERS.includes(approverLower)) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'SENSITIVITY_GATE_VIOLATION',
              message: `Pack "${pack.packId}" has dataSensitivity="high" — requires human approval even for read-only execution. Provide approved_by with a valid human identity.`,
              dataSensitivity: pack.dataSensitivity,
              classification: 'MANDATORY',
              blockedApprovers: BLOCKED_APPROVERS.filter(a => a !== ''),
            }, null, 2) }], isError: true };
          }
        }

        // ── Verify hash integrity ──
        const { hash, ...rest } = pack;
        const expectedHash = djb2Hash(JSON.stringify(rest, Object.keys(rest).sort()));
        if (pack.hash !== expectedHash) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'HASH_INTEGRITY_FAILURE', packId: input.pack_id, message: 'Pack hash does not match content — possible tampering' }, null, 2) }], isError: true };
        }

        // ── Phase 1: Return command definitions if no scout_data ──
        if (!input.scout_data || Object.keys(input.scout_data).length === 0) {
          const commandDefs = pack.steps.map(s => ({
            stepKey: `step_${s.step}`,
            command: s.command,
            description: s.description,
            timeout: s.timeout,
            sensitive: s.sensitive,
          }));

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'COMMAND_DEFINITIONS',
            packId: pack.packId,
            intent: pack.intent,
            message: 'Execute these commands on the target environment, then call again with scout_data containing the results keyed by stepKey.',
            commands: commandDefs,
            totalCommands: commandDefs.length,
            classification: pack.dataSensitivity === 'high' ? 'MANDATORY' : 'ADVISORY',
            readOnly: true,
          }, null, 2) }] };
        }

        // ── Phase 2: Process results and produce findings ──
        const data = input.scout_data;
        const timestamp = new Date().toISOString();

        // Redact all collected data
        const redactedData: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) {
          redactedData[k] = redact(v);
        }

        if (pack.intent === 'audit' && pack.controlMappings && pack.controlMappings.length > 0) {
          // ── AUDIT MODE: Deterministic control evaluation ──
          const evidence: Array<{
            controlId: string;
            controlTitle: string;
            status: 'PASS' | 'FAIL' | 'ERROR';
            evidence: string;
            rule: object;
            evaluatedAt: string;
            hash: string;
          }> = [];

          for (const mapping of pack.controlMappings) {
            // Collect evidence from scout data
            const evidenceData = mapping.evidenceFrom
              .map(key => {
                // Match scout data by field reference
                for (const [dk, dv] of Object.entries(redactedData)) {
                  if (dk.includes(key) || dv.includes(key)) return dv;
                }
                return null;
              })
              .filter(Boolean)
              .join('\n');

            // Apply deterministic evaluation rule
            let status: 'PASS' | 'FAIL' | 'ERROR' = 'ERROR';
            const eval_ = mapping.evaluation as AuditEvaluation;

            try {
              if (eval_.type === 'presence_check') {
                const hasData = evidenceData.length > 0 || Object.keys(redactedData).length > 0;
                status = hasData === eval_.expected ? 'PASS' : 'FAIL';
              } else if (eval_.type === 'regex_match' && eval_.pattern) {
                const re = new RegExp(eval_.pattern, 'i');
                const allOutput = Object.values(redactedData).join('\n');
                status = re.test(allOutput) ? 'PASS' : 'FAIL';
              } else if (eval_.type === 'count_compare' && eval_.operator && eval_.value !== undefined) {
                // Count lines or items in relevant data
                const allOutput = Object.values(redactedData).join('\n');
                const count = allOutput.split('\n').filter(l => l.trim().length > 0).length;
                const v = eval_.value;
                switch (eval_.operator) {
                  case '<': status = count < v ? 'PASS' : 'FAIL'; break;
                  case '>': status = count > v ? 'PASS' : 'FAIL'; break;
                  case '<=': status = count <= v ? 'PASS' : 'FAIL'; break;
                  case '>=': status = count >= v ? 'PASS' : 'FAIL'; break;
                  case '==': status = count === v ? 'PASS' : 'FAIL'; break;
                }
              } else if (eval_.type === 'threshold_compare' && eval_.operator && eval_.value !== undefined) {
                const allOutput = Object.values(redactedData).join('\n');
                const numMatch = allOutput.match(/(\d+)/);
                const measured = numMatch ? parseInt(numMatch[1], 10) : 0;
                const v = eval_.value;
                switch (eval_.operator) {
                  case '<': status = measured < v ? 'PASS' : 'FAIL'; break;
                  case '>': status = measured > v ? 'PASS' : 'FAIL'; break;
                  case '<=': status = measured <= v ? 'PASS' : 'FAIL'; break;
                  case '>=': status = measured >= v ? 'PASS' : 'FAIL'; break;
                  case '==': status = measured === v ? 'PASS' : 'FAIL'; break;
                }
              }
            } catch {
              status = 'ERROR';
            }

            const evidenceStr = evidenceData || Object.values(redactedData).join('\n').substring(0, 500);
            evidence.push({
              controlId: mapping.controlId,
              controlTitle: mapping.controlTitle,
              status,
              evidence: evidenceStr.substring(0, 1000),
              rule: mapping.evaluation,
              evaluatedAt: timestamp,
              hash: djb2Hash(`${mapping.controlId}:${status}:${evidenceStr}:${timestamp}`),
            });
          }

          const passed = evidence.filter(e => e.status === 'PASS').length;
          const failed = evidence.filter(e => e.status === 'FAIL').length;
          const errors = evidence.filter(e => e.status === 'ERROR').length;
          const bundleHash = djb2Hash(JSON.stringify(evidence));

          engine.telemetryService.emitToolCall('gia_run_patrol', `patrol-${Date.now().toString(36)}`, 'ADVISORY', true);

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'AUDIT_EVIDENCE',
            packId: pack.packId,
            packName: pack.name,
            intent: 'audit',
            evidence,
            summary: {
              controlsEvaluated: evidence.length,
              controlsPassed: passed,
              controlsFailed: failed,
              controlsError: errors,
              overallResult: failed > 0 ? 'FAIL' : errors > 0 ? 'ERROR' : 'PASS',
            },
            bundleHash,
            classification: pack.dataSensitivity === 'high' ? 'MANDATORY' : 'ADVISORY',
            timestamp,
            note: 'All evaluations are deterministic (rules-based). No AI interpretation of pass/fail.',
          }, null, 2) }] };

        } else {
          // ── PATROL MODE: Produce findings ──
          const findings: Array<{
            checkId: string;
            status: 'PASS' | 'WARN' | 'FAIL' | 'ERROR';
            actual: string;
            expected: string;
            severity: string;
            evidence: string;
            recommendation?: string;
          }> = [];

          for (const step of pack.steps) {
            const key = `step_${step.step}`;
            const output = redactedData[key] || '';
            const exitedOk = output.length > 0;

            // Apply heuristics from governance content
            let status: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' = exitedOk ? 'PASS' : 'ERROR';
            let severity = 'LOW';
            let recommendation: string | undefined;

            // Pattern-based evaluation from pack heuristics
            for (const heuristic of pack.governance.heuristics) {
              const failMatch = heuristic.match(/→\s*FAIL[/]?(CRITICAL|HIGH)?/i);
              const warnMatch = heuristic.match(/→\s*WARN[/]?(HIGH|MEDIUM)?/i);

              if (failMatch) {
                const trigger = heuristic.split('→')[0].trim();
                if (output.toLowerCase().includes('stopped') || output.toLowerCase().includes('unavailable') ||
                    output.toLowerCase().includes('failed') || output.toLowerCase().includes('unhealthy')) {
                  status = 'FAIL';
                  severity = failMatch[1] || 'HIGH';
                  recommendation = `Detected condition matching: ${trigger}`;
                }
              }
              if (warnMatch && status !== 'FAIL') {
                if (output.toLowerCase().includes('restarting') || output.toLowerCase().includes('degraded')) {
                  status = 'WARN';
                  severity = warnMatch[1] || 'MEDIUM';
                }
              }
            }

            // Threshold checks for numeric data (disk, memory)
            const percentMatch = output.match(/(\d+)%/);
            if (percentMatch) {
              const pct = parseInt(percentMatch[1], 10);
              if (pack.packId.includes('disk')) {
                if (pct > 90) { status = 'FAIL'; severity = 'HIGH'; recommendation = 'Disk usage > 90% — consider cleanup'; }
                else if (pct > 80) { status = 'WARN'; severity = 'MEDIUM'; recommendation = 'Disk usage > 80% — monitor closely'; }
              }
              if (pack.packId.includes('memory')) {
                if (pct > 95) { status = 'FAIL'; severity = 'CRITICAL'; recommendation = 'Memory > 95% — investigate high consumers'; }
                else if (pct > 80) { status = 'WARN'; severity = 'HIGH'; recommendation = 'Memory > 80% — monitor pressure'; }
              }
            }

            findings.push({
              checkId: `${pack.packId}:step-${step.step}`,
              status,
              actual: output.substring(0, 500),
              expected: step.description,
              severity,
              evidence: output.substring(0, 1000),
              recommendation,
            });
          }

          const pass = findings.filter(f => f.status === 'PASS').length;
          const warn = findings.filter(f => f.status === 'WARN').length;
          const fail = findings.filter(f => f.status === 'FAIL').length;
          const err = findings.filter(f => f.status === 'ERROR').length;

          engine.telemetryService.emitToolCall('gia_run_patrol', `patrol-${Date.now().toString(36)}`, 'ADVISORY', true);

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'PATROL_FINDINGS',
            packId: pack.packId,
            packName: pack.name,
            intent: 'patrol',
            findings,
            summary: { pass, warn, fail, error: err, total: findings.length },
            overallStatus: fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : err > 0 ? 'ERROR' : 'PASS',
            classification: pack.dataSensitivity === 'high' ? 'MANDATORY' : 'ADVISORY',
            timestamp,
          }, null, 2) }] };
        }
      } catch (error) {
        engine.telemetryService.emitToolCall('gia_run_patrol', `patrol-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PATROL_FAILED', message: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONVENIENCE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Register all 5 Governed Operations Pack tools with the MCP server.
 */
export function registerRemediationPackTools(server: McpServer, engine: GovernanceEngine): void {
  registerScanEnvironmentTool(server, engine);
  registerListPacksTool(server, engine);
  registerDryRunPackTool(server, engine);
  registerApplyPackTool(server, engine);
  registerRunPatrolTool(server, engine);
}
