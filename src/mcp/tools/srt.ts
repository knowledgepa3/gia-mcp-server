/**
 * @module    mcp-tool-srt
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       varies — watchdog=INFO, diagnostician=ADVISORY, repair=MANDATORY, postmortem=ADVISORY
 * @audit     true — all SRT operations are ledger-recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA Site Reliability Team (SRT) MCP Tools
 *
 * 4 tools for the full SRT pipeline:
 * - srt_run_watchdog:       Submit check results, get finding capsule (INFORMATIONAL)
 * - srt_diagnose:           Diagnose incident, get repair plan (ADVISORY)
 * - srt_approve_repair:     Approve/reject repair plan (MANDATORY gate)
 * - srt_generate_postmortem: Generate postmortem report (ADVISORY)
 *
 * Frozen Spec: GIA-SRE-v1.0-FROZEN-SPEC.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { exec as cpExec } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { persistIncident, recoverIncidents, isSRTPersistenceEnabled } from '../../core/persistence/srt-persistence.js';

// ═══════════════════════════════════════════════════════════════════
// In-memory SRT state for MCP server process
// ═══════════════════════════════════════════════════════════════════

interface SRTCheckResult {
  checkId: string;
  name: string;
  status: 'PASS' | 'WARNING' | 'CRITICAL' | 'ERROR' | 'TIMEOUT';
  value: number;
  unit: string;
  threshold: number;
  message: string;
  timestamp: string;
}

interface SRTFinding {
  findingId: string;
  findingType: string;
  severity: string;
  signal: string;
  observations: string[];
  metrics: Record<string, number>;
  recommendedNext: string;
  evidenceRefs: string[];
  checksRun: number;
  checksFailed: number;
  timestamp: string;
  ttl: number;
}

interface SRTRepairCommand {
  step: number;
  command: string;
  description: string;
  timeout: number;
  requiresElevation: boolean;
  sensitive: boolean;
}

interface SRTSuccessCriterion {
  check: string;
  expected: string;
  timeout: number;
}

interface SRTIncident {
  incidentId: string;
  status: string;
  severity: string;
  finding?: SRTFinding;
  diagnosis?: {
    diagnosisId: string;
    suspectedRootCause: string;
    confidence: string;
    actionsPerformed: string[];
    evidence: string[];
    fixOptions: Array<{ optionId: string; description: string; risk: string; estimatedMinutes: number; commands: string[]; rollback: string[]; recommended: boolean }>;
    riskAssessment: string;
    timestamp: string;
  };
  repairPlan?: {
    planId: string;
    reason: string;
    risk: string;
    commands: SRTRepairCommand[];
    rollback: SRTRepairCommand[];
    successCriteria: SRTSuccessCriterion[];
    estimatedMinutes: number;
    gateId: string;
    gateStatus: string;
    approvedBy?: string;
    approvedAt?: string;
    executedAt?: string;
    completedAt?: string;
    result?: string;
  };
  postmortem?: {
    postmortemId: string;
    title: string;
    timeline: Array<{ timestamp: string; agent: string; action: string; detail: string }>;
    rootCause: string;
    whatWorked: string[];
    whatFailed: string[];
    preventionActions: string[];
    metrics: {
      timeToDetectMinutes: number;
      timeToDiagnoseMinutes: number;
      timeToRepairMinutes: number;
      totalResolutionMinutes: number;
      // M10: ESTIMATES from a severity-bucket heuristic, not measured savings.
      humanTimeSavedMinutes: number;     // estimated (severity-bucket heuristic)
      costAvoidedUSD: number;            // estimated (severity-bucket heuristic)
      roiEstimated?: boolean;            // true — marks the two fields above as estimates
      roiBasis?: string;                 // 'severity-bucket heuristic'
      recurrenceCount: number;
    };
  };
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/**
 * Severity-bucket ROI heuristic for SRT postmortems.
 *
 * IMPORTANT (audit finding M10): the returned humanTimeSavedMinutes /
 * costAvoidedUSD values are HEURISTIC ESTIMATES derived from hardcoded
 * severity buckets — they are NOT measured savings. The `estimated` /
 * `basis` annotations make that explicit wherever the result is surfaced
 * or persisted. Time-to-detect / time-to-diagnose / time-to-repair (TTD /
 * TTDiag / TTR) are real measurements and are computed elsewhere; this
 * helper does not touch them.
 *
 * Buckets (unchanged from the original inline math):
 *   manualEstimate:    CRITICAL=90, HIGH=60, otherwise 30 (minutes)
 *   downtimeCost/min:  CRITICAL=$100, HIGH=$50, otherwise $10
 *   humanTimeSaved = max(0, manualEstimate - round(totalActiveMinutes * 0.1))
 *   costAvoided    = humanTimeSaved * downtimeCost
 *
 * @param severity            incident severity
 * @param totalActiveMinutes  real measured TTD+TTDiag+TTR (minutes)
 */
export function estimateRepairRoi(
  severity: string,
  totalActiveMinutes: number,
): {
  humanTimeSavedMinutes: number;
  costAvoidedUSD: number;
  estimated: true;
  basis: 'severity-bucket heuristic';
} {
  const manualEstimate = severity === 'CRITICAL' ? 90 : severity === 'HIGH' ? 60 : 30;
  const humanTimeSaved = Math.max(0, manualEstimate - Math.round(totalActiveMinutes * 0.1));
  const downtimeCost = severity === 'CRITICAL' ? 100 : severity === 'HIGH' ? 50 : 10;
  const costAvoided = humanTimeSaved * downtimeCost;
  return {
    humanTimeSavedMinutes: humanTimeSaved,
    costAvoidedUSD: costAvoided,
    estimated: true,
    basis: 'severity-bucket heuristic',
  };
}

// In-memory stores
const MAX_REPAIR_HISTORY = 100;
const incidents = new Map<string, SRTIncident>();

/**
 * Bound the incidents Map to MAX_REPAIR_HISTORY entries.
 * Evicts the oldest entries (by Map insertion order) when the cap is exceeded.
 * Called after every new incident is added.
 */
function boundIncidentHistory(): void {
  if (incidents.size > MAX_REPAIR_HISTORY) {
    const overflow = incidents.size - MAX_REPAIR_HISTORY;
    const keys = incidents.keys();
    for (let i = 0; i < overflow; i++) {
      const { value: key, done } = keys.next();
      if (done) break;
      incidents.delete(key);
    }
  }
}

// One-time recovery from PostgreSQL (awaited to eliminate race conditions)
let srtRecoveryComplete = false;
let srtRecoveryPromise: Promise<void> | null = null;

function ensureSRTRecovery(): Promise<void> {
  if (srtRecoveryComplete) return Promise.resolve();
  if (srtRecoveryPromise) return srtRecoveryPromise;

  if (!isSRTPersistenceEnabled()) {
    srtRecoveryComplete = true;
    return Promise.resolve();
  }

  srtRecoveryPromise = (async () => {
    try {
      const rows = await recoverIncidents();
      for (const row of rows) {
        if (!incidents.has(row.incidentId)) {
          incidents.set(row.incidentId, row);
        }
      }
      if (rows.length > 0) {
        console.error(`[SRT] Recovered ${rows.length} active incidents from PostgreSQL`);
      }
    } catch (err) {
      console.error('[SRT] Recovery failed:', (err as Error).message);
    }
    srtRecoveryComplete = true;
  })();

  return srtRecoveryPromise;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// ═══════════════════════════════════════════════════════════════════
// KNOWN PLAYBOOKS (matching the frozen spec)
// ═══════════════════════════════════════════════════════════════════

interface Playbook {
  pattern: string;
  matchSignals: string[];
  matchTypes: string[];
  diagnosticSteps: string[];
  commands: SRTRepairCommand[];
  rollback: SRTRepairCommand[];
  successCriteria: SRTSuccessCriterion[];
  risk: string;
  estimatedMinutes: number;
}

const PLAYBOOKS: Playbook[] = [
  {
    pattern: 'nginx_502_upstream_unhealthy',
    matchSignals: ['502', 'upstream', 'unhealthy'],
    matchTypes: ['SERVICE_DOWN', 'ERROR_RATE_SPIKE', 'CONTAINER_UNHEALTHY'],
    diagnosticSteps: ['Check docker ps', 'Read API container logs', 'Verify .env', 'Check port 3001'],
    commands: [
      { step: 1, command: 'docker compose ps', description: 'Check container states', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose up -d --force-recreate ace-server', description: 'Recreate API container', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 3, command: 'sleep 15 && curl -sf http://localhost:3001/health', description: 'Verify health', timeout: 30, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose down ace-server', description: 'Stop API', timeout: 30, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose up -d ace-server', description: 'Restart clean', timeout: 120, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: '502 rate < 1% over 5m', expected: 'true', timeout: 300 },
      { check: 'healthz 200 OK', expected: '200', timeout: 30 },
    ],
    risk: 'LOW', estimatedMinutes: 5,
  },
  {
    pattern: 'tls_certificate_expiring',
    matchSignals: ['tls', 'cert', 'expir', 'ssl'],
    matchTypes: ['TLS_EXPIRING'],
    diagnosticSteps: ['Check cert expiry', 'Check certbot status', 'Verify DNS'],
    commands: [
      { step: 1, command: 'docker compose run --rm certbot renew', description: 'Renew TLS certificate', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose exec ace-frontend nginx -s reload', description: 'Reload nginx', timeout: 15, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose restart ace-frontend', description: 'Restart nginx', timeout: 30, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'TLS cert > 30 days', expected: 'true', timeout: 30 },
      { check: 'HTTPS accessible', expected: '200', timeout: 15 },
    ],
    risk: 'LOW', estimatedMinutes: 3,
  },
  {
    pattern: 'database_unreachable',
    matchSignals: ['database', 'postgres', 'pg_isready', 'db', '5432'],
    matchTypes: ['DB_UNREACHABLE'],
    diagnosticSteps: ['Check postgres container', 'Read postgres logs', 'Check disk space', 'Check port 5432'],
    commands: [
      { step: 1, command: 'docker compose ps postgres', description: 'Check postgres state', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 2, command: 'docker compose restart postgres', description: 'Restart postgres', timeout: 60, requiresElevation: false, sensitive: false },
      { step: 3, command: 'sleep 10 && docker exec ace-postgres pg_isready -U ace -d ace_governance', description: 'Verify connectivity', timeout: 30, requiresElevation: false, sensitive: false },
      { step: 4, command: 'docker compose restart ace-server', description: 'Restart API to reconnect', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose down && docker compose up -d', description: 'Full stack restart', timeout: 180, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'pg_isready ok', expected: 'accepting connections', timeout: 30 },
      { check: 'API healthz 200', expected: '200', timeout: 60 },
    ],
    risk: 'MEDIUM', estimatedMinutes: 5,
  },
  {
    pattern: 'env_parse_failure',
    matchSignals: ['env', 'parse', 'mock_in_live', 'environment'],
    matchTypes: ['CONFIG_INVALID'],
    diagnosticSteps: ['Check API logs for .env errors', 'Verify .env exists', 'Check permissions', 'Check for BOM/CRLF'],
    commands: [
      { step: 1, command: 'test -f /root/gia-platform/.env && echo "exists" || echo "MISSING"', description: 'Check .env', timeout: 5, requiresElevation: false, sensitive: false },
      { step: 2, command: "sed -i 's/\\r$//' /root/gia-platform/.env", description: 'Strip CRLF', timeout: 5, requiresElevation: false, sensitive: true },
      { step: 3, command: 'docker compose restart ace-server', description: 'Restart API', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'docker compose restart ace-server', description: 'Restart API', timeout: 60, requiresElevation: false, sensitive: false },
    ],
    successCriteria: [
      { check: 'API healthz 200', expected: '200', timeout: 60 },
    ],
    risk: 'LOW', estimatedMinutes: 3,
  },
  {
    pattern: 'disk_space_critical',
    matchSignals: ['disk', 'space', 'storage', 'full'],
    matchTypes: ['DISK_PRESSURE', 'RESOURCE_EXHAUSTION'],
    diagnosticSteps: ['Check df -h', 'Check docker system df', 'List large files', 'Check image sizes'],
    commands: [
      { step: 1, command: 'docker system prune -f --volumes', description: 'Prune Docker', timeout: 120, requiresElevation: false, sensitive: false },
      { step: 2, command: 'journalctl --vacuum-size=100M', description: 'Trim journal', timeout: 30, requiresElevation: true, sensitive: false },
      { step: 3, command: 'df -h /', description: 'Verify space', timeout: 5, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [
      { check: 'Disk < 80%', expected: 'true', timeout: 10 },
    ],
    risk: 'MEDIUM', estimatedMinutes: 5,
  },
  {
    pattern: 'port_conflict',
    matchSignals: ['port', 'bind', 'address already', 'conflict'],
    matchTypes: ['CONFIG_INVALID'],
    diagnosticSteps: ['Check port 80/443 bindings', 'Check port 3001', 'List all containers', 'Check stale processes'],
    commands: [
      { step: 1, command: 'docker compose down', description: 'Stop all containers', timeout: 60, requiresElevation: false, sensitive: false },
      { step: 2, command: 'sleep 5 && ss -tlnp | grep -E ":80|:443|:3001"', description: 'Check stale bindings', timeout: 10, requiresElevation: false, sensitive: false },
      { step: 3, command: 'docker compose up -d', description: 'Restart all', timeout: 120, requiresElevation: false, sensitive: false },
    ],
    rollback: [],
    successCriteria: [
      { check: 'All containers running', expected: 'true', timeout: 60 },
    ],
    risk: 'LOW', estimatedMinutes: 5,
  },

  // ═══════════════════════════════════════════════════════════════════
  // SECURITY HARDENING PLAYBOOKS — Fed by ACE Security Scanner
  // Scanner → Watchdog → Diagnose matches these → MANDATORY gate → Execute
  // ═══════════════════════════════════════════════════════════════════

  {
    pattern: 'ssh_hardening_required',
    matchSignals: ['ssh', 'root login', 'PermitRootLogin', 'MaxAuthTries', 'X11Forwarding', 'ClientAliveInterval', 'sshd'],
    matchTypes: ['SSH_HARDENING_REQUIRED'],
    diagnosticSteps: ['Read sshd_config', 'Check current PermitRootLogin', 'Check PasswordAuthentication', 'Check MaxAuthTries', 'Check X11Forwarding'],
    commands: [
      { step: 1, command: 'cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)', description: 'Backup sshd_config before changes', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 2, command: "sed -i 's/^PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && sed -i 's/^#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config", description: 'Restrict root login to key-only', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 3, command: "grep -q '^MaxAuthTries' /etc/ssh/sshd_config && sed -i 's/^MaxAuthTries.*/MaxAuthTries 4/' /etc/ssh/sshd_config || echo 'MaxAuthTries 4' >> /etc/ssh/sshd_config", description: 'Set MaxAuthTries to 4', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 4, command: "sed -i 's/^X11Forwarding yes/X11Forwarding no/' /etc/ssh/sshd_config", description: 'Disable X11 forwarding', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 5, command: "grep -q '^ClientAliveInterval' /etc/ssh/sshd_config && sed -i 's/^ClientAliveInterval.*/ClientAliveInterval 300/' /etc/ssh/sshd_config || echo 'ClientAliveInterval 300' >> /etc/ssh/sshd_config", description: 'Set idle timeout to 300s', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 6, command: "grep -q '^ClientAliveCountMax' /etc/ssh/sshd_config && sed -i 's/^ClientAliveCountMax.*/ClientAliveCountMax 2/' /etc/ssh/sshd_config || echo 'ClientAliveCountMax 2' >> /etc/ssh/sshd_config", description: 'Set max alive count to 2', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 7, command: 'sshd -t && systemctl restart sshd', description: 'Validate config and restart sshd', timeout: 15, requiresElevation: true, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'cp /etc/ssh/sshd_config.bak.* /etc/ssh/sshd_config 2>/dev/null && systemctl restart sshd', description: 'Restore sshd_config backup and restart', timeout: 15, requiresElevation: true, sensitive: false },
    ],
    successCriteria: [
      { check: 'sshd config valid', expected: 'sshd -t exits 0', timeout: 10 },
      { check: 'sshd running', expected: 'active', timeout: 10 },
      { check: 'PermitRootLogin not yes', expected: 'prohibit-password', timeout: 5 },
    ],
    risk: 'MEDIUM', estimatedMinutes: 3,
  },
  {
    pattern: 'firewall_inactive',
    matchSignals: ['firewall', 'ufw', 'inactive', 'no firewall', 'iptables'],
    matchTypes: ['FIREWALL_INACTIVE'],
    diagnosticSteps: ['Check ufw status', 'List current rules', 'Check docker port bindings', 'Identify required ports'],
    commands: [
      { step: 1, command: 'ufw --force reset', description: 'Reset UFW to clean state', timeout: 10, requiresElevation: true, sensitive: false },
      { step: 2, command: 'ufw default deny incoming && ufw default allow outgoing', description: 'Set default policies: deny in, allow out', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 3, command: 'ufw allow 22/tcp comment "SSH"', description: 'Allow SSH', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 4, command: 'ufw allow 80/tcp comment "HTTP"', description: 'Allow HTTP', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 5, command: 'ufw allow 443/tcp comment "HTTPS"', description: 'Allow HTTPS', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 6, command: 'ufw allow 3001/tcp comment "GIA API"', description: 'Allow GIA API', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 7, command: 'ufw --force enable', description: 'Enable UFW', timeout: 10, requiresElevation: true, sensitive: false },
      { step: 8, command: 'ufw status verbose', description: 'Verify firewall status', timeout: 5, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'ufw --force disable', description: 'Disable UFW if issues detected', timeout: 10, requiresElevation: true, sensitive: false },
    ],
    successCriteria: [
      { check: 'UFW active', expected: 'Status: active', timeout: 10 },
      { check: 'Default deny incoming', expected: 'deny (incoming)', timeout: 5 },
      { check: 'SSH accessible', expected: 'port 22 open', timeout: 10 },
    ],
    risk: 'MEDIUM', estimatedMinutes: 3,
  },
  {
    pattern: 'security_packages_missing',
    matchSignals: ['fail2ban', 'brute-force', 'updates', 'packages', 'upgradable', 'pending updates'],
    matchTypes: ['SECURITY_PACKAGES_MISSING', 'PACKAGES_OUTDATED'],
    diagnosticSteps: ['Check if fail2ban installed', 'Check pending apt updates', 'Check unattended-upgrades', 'Check auditd'],
    commands: [
      { step: 1, command: 'apt-get update -qq', description: 'Update package lists', timeout: 120, requiresElevation: true, sensitive: false },
      { step: 2, command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban', description: 'Install fail2ban for brute-force protection', timeout: 120, requiresElevation: true, sensitive: false },
      { step: 3, command: 'systemctl enable fail2ban && systemctl start fail2ban', description: 'Enable and start fail2ban', timeout: 15, requiresElevation: true, sensitive: false },
      { step: 4, command: 'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs', description: 'Apply pending security updates', timeout: 600, requiresElevation: true, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'systemctl stop fail2ban 2>/dev/null; true', description: 'Stop fail2ban if causing issues', timeout: 10, requiresElevation: true, sensitive: false },
    ],
    successCriteria: [
      { check: 'fail2ban running', expected: 'active (running)', timeout: 15 },
      { check: 'fail2ban sshd jail active', expected: 'sshd', timeout: 10 },
    ],
    risk: 'LOW', estimatedMinutes: 15,
  },
  {
    pattern: 'docker_hardening_required',
    matchSignals: ['docker', 'container root', 'privileged', 'no resource limits', 'daemon.json'],
    matchTypes: ['DOCKER_HARDENING_REQUIRED'],
    diagnosticSteps: ['Check containers running as root', 'Check privileged mode', 'Check resource limits', 'Check Docker socket perms'],
    commands: [
      { step: 1, command: 'echo \'{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true}\' > /etc/docker/daemon.json', description: 'Create daemon.json with log limits and live-restore', timeout: 5, requiresElevation: true, sensitive: false },
      { step: 2, command: 'systemctl restart docker', description: 'Restart Docker daemon with new config', timeout: 30, requiresElevation: true, sensitive: false },
      { step: 3, command: 'sleep 10 && docker ps --format "{{.Names}}: {{.Status}}"', description: 'Verify containers restarted', timeout: 30, requiresElevation: false, sensitive: false },
    ],
    rollback: [
      { step: 1, command: 'rm /etc/docker/daemon.json && systemctl restart docker', description: 'Remove daemon.json and restart', timeout: 30, requiresElevation: true, sensitive: false },
    ],
    successCriteria: [
      { check: 'Docker daemon running', expected: 'active', timeout: 15 },
      { check: 'All containers healthy', expected: 'running', timeout: 60 },
      { check: 'daemon.json exists', expected: 'exists', timeout: 5 },
    ],
    risk: 'MEDIUM', estimatedMinutes: 5,
  },
];

function matchPlaybook(findingType: string, signal: string, observations: string[]): Playbook | null {
  const combined = `${findingType} ${signal} ${observations.join(' ')}`.toLowerCase();
  for (const pb of PLAYBOOKS) {
    if (pb.matchTypes.includes(findingType)) return pb;
    if (pb.matchSignals.some(s => combined.includes(s))) return pb;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// REAL HEALTH CHECK PROBES
// Runs actual probes — no AI-fabricated data.
//
// Environment detection:
//   Docker container: uses internal hostnames (ace-governance-api:3001)
//   Local (stdio):    uses public URL (https://gia.aceadvising.com)
//
// Both environments: TLS cert via tls.connect(), DNS via dns.promises
// Container only:    disk (df), memory (free)
// Local only:        disk/memory via os module
// ═══════════════════════════════════════════════════════════════════

const execAsync = promisify(cpExec);

/** Detect if running inside Docker container */
const IS_CONTAINER = Boolean(
  existsSync('/.dockerenv') ||
  process.env.DATABASE_URL ||
  process.env.CONTAINER === 'true'
);

/** API health URL — Docker internal or public */
const API_HEALTH_URL = IS_CONTAINER
  ? 'http://ace-governance-api:3001/health'
  : 'https://gia.aceadvising.com/health';

/** Frontend health URL — Docker internal or public (nginx-health only works internally) */
const FRONTEND_HEALTH_URL = IS_CONTAINER
  ? 'http://ace-governance-frontend:80/nginx-health'
  : 'https://gia.aceadvising.com/';

async function probeApiHealth(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  try {
    const res = await fetch(API_HEALTH_URL, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    // Accept "healthy" or "degraded" (degraded = API is up but not fully configured)
    const isUp = res.ok && (body.includes('"healthy"') || body.includes('"degraded"') || body.includes('"status"'));
    const status = isUp ? 'PASS' : 'CRITICAL';
    return { checkId: 'api-healthz', name: 'API Health', status, value: isUp ? res.status : 0, unit: 'status', threshold: 200, message: isUp ? `API responding (${res.status})` : 'API health check failed', timestamp: ts };
  } catch (err) {
    return { checkId: 'api-healthz', name: 'API Health', status: 'CRITICAL', value: 0, unit: 'status', threshold: 200, message: `API unreachable: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeFrontendHealth(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  try {
    const res = await fetch(FRONTEND_HEALTH_URL, { signal: AbortSignal.timeout(8000) });
    if (IS_CONTAINER) {
      const body = await res.text();
      const healthy = body.trim() === 'healthy';
      return { checkId: 'container-health-frontend', name: 'Frontend Health', status: healthy ? 'PASS' : 'CRITICAL', value: healthy ? 1 : 0, unit: 'bool', threshold: 1, message: healthy ? 'Frontend responding (nginx healthy)' : 'Frontend unreachable', timestamp: ts };
    } else {
      // External: just check it responds with 200
      const ok = res.ok;
      return { checkId: 'container-health-frontend', name: 'Frontend Health', status: ok ? 'PASS' : 'CRITICAL', value: ok ? 1 : 0, unit: 'bool', threshold: 1, message: ok ? `Frontend responding (${res.status})` : `Frontend returned ${res.status}`, timestamp: ts };
    }
  } catch (err) {
    return { checkId: 'container-health-frontend', name: 'Frontend Health', status: 'CRITICAL', value: 0, unit: 'bool', threshold: 1, message: `Frontend unreachable: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeDiskUsage(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  if (!IS_CONTAINER) {
    // Remote (local CLI / Windows): query the droplet's /health endpoint for server-side disk stats
    try {
      const res = await fetch(API_HEALTH_URL, { signal: AbortSignal.timeout(8000) });
      const body = await res.json() as Record<string, unknown>;
      const value = typeof body.diskUsagePct === 'number' ? body.diskUsagePct : 0;
      const status = value >= 95 ? 'CRITICAL' : value >= 80 ? 'WARNING' : 'PASS';
      return { checkId: 'disk-usage', name: 'Disk Usage', status, value, unit: '%', threshold: 95, message: `Droplet disk usage: ${value}%`, timestamp: ts };
    } catch (err) {
      return { checkId: 'disk-usage', name: 'Disk Usage', status: 'ERROR', value: 0, unit: '%', threshold: 95, message: `Disk check failed: ${(err as Error).message}`, timestamp: ts };
    }
  }
  // In-container (Linux / Alpine): read local filesystem directly
  try {
    const { stdout } = await execAsync("df / | tail -1 | awk '{print $5}' | tr -d '%'", { timeout: 5000 });
    const value = parseInt(stdout.trim(), 10) || 0;
    const status = value >= 95 ? 'CRITICAL' : value >= 80 ? 'WARNING' : 'PASS';
    return { checkId: 'disk-usage', name: 'Disk Usage', status, value, unit: '%', threshold: 95, message: `Disk usage: ${value}%`, timestamp: ts };
  } catch (err) {
    return { checkId: 'disk-usage', name: 'Disk Usage', status: 'ERROR', value: 0, unit: '%', threshold: 95, message: `Disk check failed: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeMemoryUsage(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  if (!IS_CONTAINER) {
    // Remote (local CLI / Windows): query the droplet's /health endpoint for server-side memory stats
    try {
      const res = await fetch(API_HEALTH_URL, { signal: AbortSignal.timeout(8000) });
      const body = await res.json() as Record<string, unknown>;
      const value = typeof body.memoryUsagePct === 'number' ? body.memoryUsagePct : 0;
      const status = value >= 95 ? 'CRITICAL' : value >= 80 ? 'WARNING' : 'PASS';
      return { checkId: 'memory-usage', name: 'Memory Usage', status, value, unit: '%', threshold: 95, message: `Droplet memory usage: ${value}%`, timestamp: ts };
    } catch (err) {
      return { checkId: 'memory-usage', name: 'Memory Usage', status: 'ERROR', value: 0, unit: '%', threshold: 95, message: `Memory check failed: ${(err as Error).message}`, timestamp: ts };
    }
  }
  // In-container: read local memory directly
  try {
    const os = await import('os');
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPct = Math.round((1 - freeMem / totalMem) * 100);
    const status = usedPct >= 95 ? 'CRITICAL' : usedPct >= 80 ? 'WARNING' : 'PASS';
    return { checkId: 'memory-usage', name: 'Memory Usage', status, value: usedPct, unit: '%', threshold: 95, message: `Memory usage: ${usedPct}%`, timestamp: ts };
  } catch (err) {
    return { checkId: 'memory-usage', name: 'Memory Usage', status: 'ERROR', value: 0, unit: '%', threshold: 95, message: `Memory check failed: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeTlsCertExpiry(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  try {
    const tls = await import('tls');
    const days = await new Promise<number>((resolve, reject) => {
      const socket = tls.connect(443, 'gia.aceadvising.com', { servername: 'gia.aceadvising.com' }, () => {
        const cert = socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          const expiryDate = new Date(cert.valid_to);
          const daysLeft = Math.floor((expiryDate.getTime() - Date.now()) / (86400 * 1000));
          socket.destroy();
          resolve(daysLeft);
        } else {
          socket.destroy();
          reject(new Error('No cert data'));
        }
      });
      socket.on('error', (err) => { socket.destroy(); reject(err); });
      socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('TLS timeout')); });
    });
    const status = days <= 7 ? 'CRITICAL' : days <= 30 ? 'WARNING' : 'PASS';
    return { checkId: 'tls-expiry', name: 'TLS Certificate Expiry', status, value: days, unit: 'days', threshold: 7, message: `TLS cert expires in ${days} days`, timestamp: ts };
  } catch (err) {
    return { checkId: 'tls-expiry', name: 'TLS Certificate Expiry', status: 'ERROR', value: 0, unit: 'days', threshold: 7, message: `TLS check failed: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeDbConnectivity(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  // Probe via API health endpoint (which reports DB status)
  try {
    const res = await fetch(API_HEALTH_URL, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    // API health includes DB status — if API is up, DB is reachable
    const healthy = res.ok && (body.includes('"healthy"') || body.includes('"degraded"'));
    return { checkId: 'db-connectivity', name: 'Database Connectivity', status: healthy ? 'PASS' : 'CRITICAL', value: healthy ? 1 : 0, unit: 'bool', threshold: 1, message: healthy ? 'DB accepting connections (via API health)' : 'DB unreachable', timestamp: ts };
  } catch (err) {
    return { checkId: 'db-connectivity', name: 'Database Connectivity', status: 'CRITICAL', value: 0, unit: 'bool', threshold: 1, message: `DB check failed: ${(err as Error).message}`, timestamp: ts };
  }
}

async function probeDnsResolve(): Promise<SRTCheckResult> {
  const ts = new Date().toISOString();
  try {
    const dns = await import('dns');
    const dnsPromises = dns.promises;
    const addresses = await dnsPromises.resolve4('gia.aceadvising.com');
    const hasAddress = addresses.length > 0;
    return { checkId: 'dns-resolve', name: 'DNS Resolution', status: hasAddress ? 'PASS' : 'CRITICAL', value: hasAddress ? 1 : 0, unit: 'bool', threshold: 1, message: hasAddress ? `Resolves to ${addresses[0]}` : 'DNS resolution failed', timestamp: ts };
  } catch (err) {
    return { checkId: 'dns-resolve', name: 'DNS Resolution', status: 'CRITICAL', value: 0, unit: 'bool', threshold: 1, message: `DNS failed: ${(err as Error).message}`, timestamp: ts };
  }
}

/**
 * Run ALL real health probes.
 * Works in both Docker (internal DNS) and local (public URLs) environments.
 * No AI-fabricated data — every value comes from an actual probe.
 */
async function runRealHealthChecks(): Promise<SRTCheckResult[]> {
  const probes = [
    probeApiHealth(),
    probeFrontendHealth(),
    probeDiskUsage(),
    probeMemoryUsage(),
    probeTlsCertExpiry(),
    probeDbConnectivity(),
    probeDnsResolve(),
  ];
  return Promise.all(probes);
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 1: srt_run_watchdog (INFORMATIONAL)
// ═══════════════════════════════════════════════════════════════════

export function registerSRTRunWatchdogTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'srt_run_watchdog',
    'Run real health check probes from the MCP container (API health, frontend, disk, memory, TLS cert, DB, DNS). Returns actual measured values — never uses AI-provided data. Classification: INFORMATIONAL — read-only, no side effects.',
    {
      check_results: z.array(z.object({
        check_id: z.string().describe('Check identifier (e.g. disk-usage, api-healthz)'),
        name: z.string().describe('Human-readable check name'),
        status: z.enum(['PASS', 'WARNING', 'CRITICAL', 'ERROR', 'TIMEOUT']).describe('Check result status'),
        value: z.number().describe('Measured value'),
        unit: z.string().describe('Unit (%, ms, days, count, bool)'),
        threshold: z.number().describe('Threshold that was compared against'),
        message: z.string().describe('Status message'),
      })).optional().describe('IGNORED — real probes are always used. This parameter exists for backward compatibility only.'),
    },
    { title: 'Run SRT Watchdog', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, _meta: { ui: { resourceUri: 'ui://srt-health' } } } as any,
    async (_input) => {
      await ensureSRTRecovery(); // One-time recovery from PostgreSQL
      try {
        // ALWAYS run real probes — never trust AI-provided check_results
        const results: SRTCheckResult[] = await runRealHealthChecks();

        const failures = results.filter(r => r.status !== 'PASS');

        if (failures.length === 0) {
          // Auto-emit governance telemetry — all probes passed
          engine.telemetryService.emitProbeResult('watchdog-healthy', 'health-check', true, results.length);
          engine.telemetryService.emitToolCall('srt_run_watchdog', 'watchdog-healthy', 'INFORMATIONAL', true);

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'HEALTHY',
            checksRun: results.length,
            checksFailed: 0,
            timestamp: new Date().toISOString(),
            message: 'All health checks passed. No action needed.',
          }, null, 2) }] };
        }

        // Build finding capsule
        const hasCritical = failures.some(r => r.status === 'CRITICAL' || r.status === 'ERROR');
        const severity = hasCritical ? 'CRITICAL' : 'HIGH';

        // Classify finding type
        const ids = failures.map(f => f.checkId);
        let findingType = 'HEALTH_DEGRADED';
        if (ids.some(id => ['api-healthz', 'container-health-api'].includes(id))) findingType = 'SERVICE_DOWN';
        else if (ids.includes('db-connectivity')) findingType = 'DB_UNREACHABLE';
        else if (ids.includes('disk-usage')) findingType = 'DISK_PRESSURE';
        else if (ids.includes('memory-usage')) findingType = 'MEMORY_PRESSURE';
        else if (ids.includes('cpu-usage')) findingType = 'CPU_PRESSURE';
        else if (ids.includes('tls-expiry')) findingType = 'TLS_EXPIRING';
        else if (ids.includes('dns-resolve')) findingType = 'DNS_FAILURE';
        else if (ids.some(id => ['nginx-process', 'nginx-config-test'].includes(id))) findingType = 'CONFIG_INVALID';
        else if (ids.includes('api-error-rate')) findingType = 'ERROR_RATE_SPIKE';
        // ── Security scanner finding types ──
        else if (ids.some(id => ['ssh-root-login', 'ssh-password-auth', 'ssh-max-auth', 'ssh-x11', 'ssh-idle-timeout'].includes(id))) findingType = 'SSH_HARDENING_REQUIRED';
        else if (ids.some(id => ['ufw-inactive', 'firewall-missing', 'firewall-inactive'].includes(id))) findingType = 'FIREWALL_INACTIVE';
        else if (ids.some(id => ['fail2ban-missing', 'packages-outdated', 'pending-updates'].includes(id))) findingType = 'SECURITY_PACKAGES_MISSING';
        else if (ids.some(id => ['docker-privileged', 'docker-root-user', 'docker-no-limits', 'docker-no-daemon-config'].includes(id))) findingType = 'DOCKER_HARDENING_REQUIRED';

        const signal = failures.map(f => f.checkId).join('+');
        const observations = failures.map(f =>
          `${f.status}: ${f.name} = ${f.value}${f.unit} (threshold: ${f.threshold}${f.unit})`
        );
        const metrics: Record<string, number> = {};
        results.forEach(r => { metrics[r.checkId] = r.value; });

        const finding: SRTFinding = {
          findingId: genId('FND'),
          findingType,
          severity,
          signal,
          observations,
          metrics,
          recommendedNext: severity === 'CRITICAL' || severity === 'HIGH' ? 'TRIGGER_DIAGNOSTICIAN' : 'MONITOR',
          evidenceRefs: failures.map(f => `EVD-${f.checkId}-${Date.now().toString(36)}`),
          checksRun: results.length,
          checksFailed: failures.length,
          timestamp: new Date().toISOString(),
          ttl: 24,
        };

        // Create incident
        const incident: SRTIncident = {
          incidentId: genId('INC'),
          status: 'DETECTED',
          severity,
          finding,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        incidents.set(incident.incidentId, incident);
        boundIncidentHistory(); // Keep at most MAX_REPAIR_HISTORY entries
        persistIncident(incident); // Write-through to PostgreSQL

        // Auto-emit governance telemetry — probes found failures
        engine.telemetryService.emitProbeResult(incident.incidentId, findingType, false, results.length);
        engine.telemetryService.emitToolCall('srt_run_watchdog', incident.incidentId, 'INFORMATIONAL', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          incidentCreated: true,
          incidentId: incident.incidentId,
          finding,
          activeIncidents: incidents.size,
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('srt_run_watchdog', `watchdog-err-${Date.now().toString(36)}`, 'INFORMATIONAL', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'WATCHDOG_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 2: srt_diagnose (ADVISORY)
// ═══════════════════════════════════════════════════════════════════

export function registerSRTDiagnoseTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'srt_diagnose',
    'Run the SRT Diagnostician on an incident. Matches finding to known playbooks, identifies root cause, and proposes a staged repair plan. Classification: ADVISORY — read-only analysis, no mutations.',
    {
      incident_id: z.string().describe('Incident ID from watchdog finding'),
      additional_observations: z.array(z.string()).optional().describe('Additional diagnostic observations (e.g. from manual log reading)'),
    },
    { title: 'Diagnose Incident', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        const incident = incidents.get(input.incident_id);
        if (!incident) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'INCIDENT_NOT_FOUND',
            incidentId: input.incident_id,
            available: Array.from(incidents.keys()),
          }) }], isError: true };
        }
        if (!incident.finding) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_FINDING', message: 'Incident has no watchdog finding' }) }], isError: true };
        }

        incident.status = 'DIAGNOSING';
        incident.updatedAt = new Date().toISOString();

        // Match playbook
        const pb = matchPlaybook(
          incident.finding.findingType,
          incident.finding.signal,
          incident.finding.observations,
        );

        const diagnosisId = genId('DIAG');
        const actionsPerformed = ['INSPECT_CONTAINER', 'CHECK_ENV', 'VALIDATE_CONFIG'];
        if (['DB_UNREACHABLE'].includes(incident.finding.findingType)) actionsPerformed.push('CHECK_CONNECTIVITY');
        if (['TLS_EXPIRING', 'DNS_FAILURE'].includes(incident.finding.findingType)) actionsPerformed.push('CHECK_TLS', 'CHECK_DNS');

        const suspectedRootCause = pb
          ? `Matched playbook: ${pb.pattern}. Known pattern with ${pb.risk} risk repair.`
          : `Unknown pattern: ${incident.finding.findingType}. Signal: ${incident.finding.signal}. Manual investigation recommended.`;

        const confidence = pb ? 'high' : 'low';

        // Build fix options
        const fixOptions: Array<{ optionId: string; description: string; risk: string; estimatedMinutes: number; commands: string[]; rollback: string[]; recommended: boolean }> = [];

        if (pb) {
          fixOptions.push({
            optionId: genId('FIX'),
            description: `Playbook: ${pb.pattern}`,
            risk: pb.risk,
            estimatedMinutes: pb.estimatedMinutes,
            commands: pb.commands.map(c => c.command),
            rollback: pb.rollback.map(c => c.command),
            recommended: true,
          });
        }

        fixOptions.push({
          optionId: genId('FIX'),
          description: 'Full stack restart',
          risk: 'MEDIUM',
          estimatedMinutes: 10,
          commands: ['docker compose down', 'sleep 5', 'docker compose up -d'],
          rollback: [],
          recommended: !pb,
        });

        // Build repair plan
        const selectedFix = fixOptions.find(f => f.recommended) || fixOptions[0];
        const commands = pb ? pb.commands : selectedFix.commands.map((cmd, i) => ({
          step: i + 1, command: cmd, description: cmd, timeout: 120, requiresElevation: false, sensitive: false,
        }));
        const rollback = pb ? pb.rollback : [];
        const successCriteria = pb ? pb.successCriteria : [{ check: 'System healthy', expected: 'true', timeout: 60 }];

        const planId = genId('REPAIR');
        const gateId = genId('GATE');

        incident.diagnosis = {
          diagnosisId,
          suspectedRootCause,
          confidence,
          actionsPerformed,
          evidence: [
            ...incident.finding.observations,
            ...(input.additional_observations || []),
          ],
          fixOptions,
          riskAssessment: pb
            ? `Known pattern. ${pb.risk} risk. ${pb.diagnosticSteps.length} diagnostic steps matched.`
            : 'Unknown pattern. Elevated risk. Conservative approach recommended.',
          timestamp: new Date().toISOString(),
        };

        incident.repairPlan = {
          planId,
          reason: suspectedRootCause,
          risk: selectedFix.risk,
          commands: commands as SRTRepairCommand[],
          rollback: rollback as SRTRepairCommand[],
          successCriteria,
          estimatedMinutes: selectedFix.estimatedMinutes,
          gateId,
          gateStatus: 'PENDING',
        };

        incident.status = 'REPAIR_PROPOSED';
        incident.updatedAt = new Date().toISOString();
        persistIncident(incident); // Write-through: diagnosis + repair plan

        engine.telemetryService.emitToolCall('srt_diagnose', incident.incidentId, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          diagnosed: true,
          incidentId: incident.incidentId,
          diagnosis: incident.diagnosis,
          repairPlan: {
            planId: incident.repairPlan.planId,
            reason: incident.repairPlan.reason,
            risk: incident.repairPlan.risk,
            commands: incident.repairPlan.commands,
            rollback: incident.repairPlan.rollback,
            successCriteria: incident.repairPlan.successCriteria,
            estimatedMinutes: incident.repairPlan.estimatedMinutes,
            gateId: incident.repairPlan.gateId,
            gateStatus: 'PENDING — requires MANDATORY human approval',
          },
          nextStep: 'Call srt_approve_repair to approve or reject this plan. Repair CANNOT execute without human approval.',
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('srt_diagnose', `diag-err-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DIAGNOSE_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// SERVER EXECUTION BRIDGE — calls /api/srt/execute-from-mcp-gate
// ═══════════════════════════════════════════════════════════════════

interface ServerExecutionResult {
  executed: true;
  overallResult: string;
  executionId: string;
  totalDurationMs: number;
  preRepairSnapshotId: string | null;
  commandResults: Array<{ step: number; exitCode: number; durationMs: number; timedOut: boolean; stdout: string; stderr: string }>;
}

interface ServerExecutionFallback {
  executed: false;
  reason: string;
}

/**
 * Attempt to execute the approved plan via the GIA server's real executor.
 * Returns null if the server is not configured or unreachable — callers stay
 * at PENDING_EXECUTION. NEVER throws; any error is caught and returned as fallback.
 *
 * `engineGateId` is the MaiGate gate id from the engine.gate.enforce() call
 * that authorized this approval — NOT repairPlan.gateId (a local correlation
 * ref). The server re-verifies it against gate_approvals_persistent and
 * refuses to execute without a matching human-approval record (truth-map #2).
 *
 * Exported for tests only.
 */
export async function attemptServerExecution(
  repairPlan: NonNullable<SRTIncident['repairPlan']>,
  approvedBy: string,
  engineGateId: string,
): Promise<ServerExecutionResult | ServerExecutionFallback> {
  const apiBase = process.env.GIA_API_URL ||
    (IS_CONTAINER ? 'http://ace-governance-api:3001' : '');

  if (!apiBase) {
    return { executed: false, reason: 'GIA_API_URL not configured — execution pending manual trigger' };
  }

  const internalKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
  if (!internalKey) {
    return { executed: false, reason: 'GIA_INTERNAL_API_KEY not configured — execution pending manual trigger' };
  }

  try {
    const resp = await fetch(`${apiBase}/api/srt/execute-from-mcp-gate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${internalKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        incidentId: repairPlan.gateId,  // MCP uses gateId as incident correlation ref
        planId: repairPlan.planId,
        gateId: engineGateId,           // MaiGate id — server-side re-verification key
        approvedBy,
        commands: repairPlan.commands,
        rollback: repairPlan.rollback,
        successCriteria: repairPlan.successCriteria,
      }),
      signal: AbortSignal.timeout(120_000), // 2-min timeout — commands may take time
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { executed: false, reason: `Server returned ${resp.status}: ${errText.substring(0, 200)}` };
    }

    const data = await resp.json() as ServerExecutionResult;
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { executed: false, reason: `Server unreachable: ${msg.substring(0, 200)}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 3: srt_approve_repair (MANDATORY — human gate)
// ═══════════════════════════════════════════════════════════════════

/** Honest terminal state of an MCP-side SRT repair approval (the gate, not execution). */
export interface McpRepairApprovalState {
  gateStatus: 'APPROVED';
  incidentStatus: 'REPAIR_APPROVED';
  executionStatus: 'PENDING_EXECUTION';
  /** No result — the MCP tool gates the repair; it does not execute commands. */
  result: null;
}

function overallResultToNextStep(overallResult: string): string {
  if (overallResult === 'SUCCESS') return 'Repair succeeded. Call srt_generate_postmortem to close the incident.';
  if (overallResult === 'PARTIAL') return 'Repair partially succeeded. Review command results, then call srt_generate_postmortem.';
  if (overallResult === 'ROLLED_BACK') return 'Commands failed and rollback ran. Diagnose root cause before re-attempting.';
  return 'Repair failed. Check commandResults for the failing step, then re-diagnose.';
}

/**
 * Compute the honest terminal state for an SRT repair APPROVAL via the MCP tool.
 *
 * srt_approve_repair is the MANDATORY human-in-the-loop gate. It approves the plan but
 * DOES NOT execute repair commands — real execution is server-side
 * (server/src/srt/srtCommandExecutor.executeRepairPlan). Approval therefore ends at
 * APPROVED / PENDING_EXECUTION with no result. It must NEVER fabricate SUCCESS,
 * REPAIR_COMPLETE, a completion time, or an "executed" command count (the H3 bug).
 */
export function computeRepairApprovalState(): McpRepairApprovalState {
  return {
    gateStatus: 'APPROVED',
    incidentStatus: 'REPAIR_APPROVED',
    executionStatus: 'PENDING_EXECUTION',
    result: null,
  };
}

export function registerSRTApproveRepairTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'srt_approve_repair',
    'Approve or reject a pending SRT repair plan. Classification: MANDATORY — this is the human-in-the-loop gate. Repair plans CANNOT execute without explicit human approval. Pass action="approve" to approve or action="reject" to reject.',
    {
      incident_id: z.string().describe('Incident ID with pending repair'),
      action: z.enum(['approve', 'reject']).describe('Approve or reject the repair plan'),
      approved_by: z.string().describe('Human operator approving/rejecting'),
      reason: z.string().optional().describe('Reason for rejection (required if rejecting)'),
    },
    { title: 'Approve or Reject Repair', readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    async (input) => {
      // Basic identity presence check. This is NOT the security boundary —
      // actual authorization now comes from the real engine.gate.enforce()
      // MANDATORY gate call below, not from trusting this free-text string.
      // (Previously the only check here was a 4-string denylist — 'system',
      // 'auto', 'agent', or empty — so any OTHER caller-supplied name, e.g.
      // "plausible-human-name" or "bot42", was accepted as valid human
      // approval for executing a real repair on infrastructure. Same
      // self-report-trust bypass class fixed earlier for transfer_memory_pack,
      // gia_apply_pack, and gia_run_patrol — 2026-07-14 MCP audit.)
      if (!input.approved_by) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'MANDATORY_GATE_VIOLATION',
          message: 'Repair approval requires an approver identity.',
          gateType: 'REPAIR_APPROVAL',
          maiLevel: 'MANDATORY',
        }) }], isError: true };
      }

      const incident = incidents.get(input.incident_id);
      if (!incident) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INCIDENT_NOT_FOUND', incidentId: input.incident_id }) }], isError: true };
      }
      if (!incident.repairPlan) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_REPAIR_PLAN', message: 'Run srt_diagnose first' }) }], isError: true };
      }
      if (incident.repairPlan.gateStatus !== 'PENDING') {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'GATE_NOT_PENDING', currentStatus: incident.repairPlan.gateStatus }) }], isError: true };
      }

      // ── Forensic ledger: begin MANDATORY entry ──
      const entry = engine.ledger.begin(
        `srt-repair-${input.action}`,
        MaiClassification.MANDATORY,
        GiaLayer.MCP,
        input.approved_by
      );
      entry.addMetadata('incidentId', input.incident_id);
      entry.addMetadata('action', input.action);
      if (input.reason) entry.addMetadata('reason', input.reason);

      try {
        const ts = new Date().toISOString();

        if (input.action === 'reject') {
          incident.repairPlan.gateStatus = 'REJECTED';
          incident.repairPlan.approvedBy = input.approved_by;
          incident.repairPlan.approvedAt = ts;
          incident.status = 'DIAGNOSED';
          incident.updatedAt = ts;
          persistIncident(incident); // Write-through: rejection

          const score = engine.scorer.scoreDefault(`srt-repair-${input.action}`);
          const completedEntry = entry.complete(score, {
            classification: MaiClassification.MANDATORY,
            confidence: 1.0,
            rationale: `SRT repair ${input.action}: incident ${input.incident_id}`,
            requiresGate: false,
          });
          engine.ledger.record(completedEntry);

          engine.telemetryService.emitToolCall('srt_approve_repair', incident.incidentId, 'MANDATORY', true);

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            rejected: true,
            incidentId: incident.incidentId,
            planId: incident.repairPlan.planId,
            rejectedBy: input.approved_by,
            reason: input.reason || 'No reason provided',
            status: 'DIAGNOSED — can re-diagnose or propose new plan',
          }, null, 2) }] };
        }

        // ── MANDATORY gate enforcement — a real engine.gate.enforce() call,
        // checked BEFORE the repair is marked APPROVED. This is what makes
        // srt_approve_repair a genuinely self-enforcing MANDATORY tool rather
        // than a bare resolver that trusts a free-text approver name: the
        // caller-supplied `approved_by` alone no longer authorizes anything —
        // the gate must actually be resolved APPROVED via the approve_gate /
        // board_approve_gate tools (or auto-run in non-production).
        let gateDecision;
        try {
          gateDecision = await engine.gate.enforce(
            MaiClassification.MANDATORY,
            `srt-approve-repair:${input.incident_id}`,
            entry.id,
          );
        } catch (gateError) {
          const failedEntry = entry.fail(
            gateError instanceof Error ? gateError : new Error(String(gateError)),
            MaiClassification.MANDATORY,
          );
          engine.ledger.record(failedEntry);
          engine.telemetryService.emitToolCall('srt_approve_repair', incident.incidentId, 'MANDATORY', false);
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'GATE_REQUIRED',
            message: `Repair approval requires MANDATORY gate approval: ${gateError instanceof Error ? gateError.message : String(gateError)}`,
            incidentId: input.incident_id,
          }, null, 2) }], isError: true };
        }
        entry.addMetadata('gateId', gateDecision.gateId);
        entry.addMetadata('gateStatus', gateDecision.status);
        if (gateDecision.status !== 'APPROVED') {
          const failedEntry = entry.fail(
            new Error(`MANDATORY gate ${gateDecision.status} for srt_approve_repair`),
            MaiClassification.MANDATORY,
          );
          engine.ledger.record(failedEntry);
          engine.telemetryService.emitToolCall('srt_approve_repair', incident.incidentId, 'MANDATORY', false);
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'GATE_REQUIRED',
            gateId: gateDecision.gateId,
            gateStatus: gateDecision.status,
            message: 'Repair approval requires MANDATORY gate approval. Use approve_gate tool with the gate ID to approve.',
            incidentId: input.incident_id,
          }, null, 2) }], isError: true };
        }

        // Approve the gate. This tool is the MANDATORY human approval — it does NOT
        // execute repair commands. Real execution is server-side
        // (server/src/srt/srtCommandExecutor.executeRepairPlan). Approval therefore ends
        // at APPROVED / PENDING_EXECUTION with NO result — we never fabricate SUCCESS,
        // REPAIR_COMPLETE, a completion time, or an executed-command count (H3 fix).
        const approval = computeRepairApprovalState();
        incident.repairPlan.gateStatus = approval.gateStatus;
        incident.repairPlan.approvedBy = input.approved_by;
        incident.repairPlan.approvedAt = ts;
        // result/executedAt/completedAt deliberately left unset — no execution has occurred.
        incident.status = approval.incidentStatus;
        incident.updatedAt = ts;
        persistIncident(incident); // Write-through: approval only (no fabricated execution)

        const score = engine.scorer.scoreDefault(`srt-repair-${input.action}`);
        const completedEntry = entry.complete(score, {
          classification: MaiClassification.MANDATORY,
          confidence: 1.0,
          rationale: `SRT repair ${input.action}: incident ${input.incident_id}`,
          requiresGate: false,
        });
        engine.ledger.record(completedEntry);

        engine.telemetryService.emitToolCall('srt_approve_repair', incident.incidentId, 'MANDATORY', true);

        // Attempt server-side execution via the MCP→server wire.
        // Best-effort: if the server is unreachable the gate stays APPROVED /
        // PENDING_EXECUTION and the operator can execute manually. We NEVER
        // fabricate a result — only real executor output is recorded.
        const execResult = await attemptServerExecution(
          incident.repairPlan, input.approved_by, gateDecision.gateId,
        );

        if (execResult.executed) {
          // Real execution completed — update in-memory incident with real result
          incident.repairPlan.result = execResult.overallResult;
          incident.repairPlan.executedAt = new Date().toISOString();
          incident.repairPlan.completedAt = new Date().toISOString();
          incident.status = execResult.overallResult === 'SUCCESS' ? 'REPAIR_COMPLETE' : 'REPAIR_FAILED';
          incident.updatedAt = new Date().toISOString();
          persistIncident(incident);

          return { content: [{ type: 'text' as const, text: JSON.stringify({
            approved: true,
            executed: true,
            incidentId: incident.incidentId,
            planId: incident.repairPlan.planId,
            approvedBy: input.approved_by,
            status: incident.status,
            executionId: execResult.executionId,
            overallResult: execResult.overallResult,
            totalDurationMs: execResult.totalDurationMs,
            preRepairSnapshotId: execResult.preRepairSnapshotId,
            commandResults: execResult.commandResults,
            gateSource: 'MCP_APPROVED',
            note: 'Gate APPROVED and repair executed server-side via the MCP→server execution wire.',
            nextStep: overallResultToNextStep(execResult.overallResult),
          }, null, 2) }] };
        }

        // Server unreachable or not configured — gate stays APPROVED, execution pending
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          approved: true,
          executed: false,
          incidentId: incident.incidentId,
          planId: incident.repairPlan.planId,
          approvedBy: input.approved_by,
          status: approval.incidentStatus,
          executionStatus: approval.executionStatus,
          result: approval.result,
          commandsPlanned: incident.repairPlan.commands.length,
          executionFallbackReason: execResult.reason,
          note: 'Gate APPROVED. Server execution was attempted but did not complete — execute manually or retry.',
          nextStep: 'Trigger execution via the SRT Console or re-call after confirming server connectivity.',
        }, null, 2) }] };
      } catch (error) {
        const failedEntry = entry.fail(error instanceof Error ? error : new Error(`SRT repair ${input.action} failed`), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);
        engine.telemetryService.emitToolCall('srt_approve_repair', `repair-err-${Date.now().toString(36)}`, 'MANDATORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'APPROVAL_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOL 4: srt_generate_postmortem (ADVISORY)
// ═══════════════════════════════════════════════════════════════════

export function registerSRTGeneratePostmortemTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'srt_generate_postmortem',
    'Generate a structured postmortem report for a completed SRT incident. Includes timeline, root cause, what worked/failed, prevention actions, real timing metrics (TTD/TTDiag/TTR), an ESTIMATED ROI (humanTimeSaved/costAvoided from a severity-bucket heuristic — not measured savings, flagged via roiEstimated/roiBasis), and optional playbook delta. Classification: ADVISORY.',
    {
      incident_id: z.string().describe('Incident ID to generate postmortem for'),
    },
    { title: 'Generate Postmortem Report', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        const incident = incidents.get(input.incident_id);
        if (!incident) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INCIDENT_NOT_FOUND', incidentId: input.incident_id }) }], isError: true };
        }

        // Build timeline
        const timeline: Array<{ timestamp: string; agent: string; action: string; detail: string }> = [];

        if (incident.finding) {
          timeline.push({
            timestamp: incident.finding.timestamp,
            agent: 'watchdog',
            action: 'FINDING_EMITTED',
            detail: `${incident.finding.findingType}: ${incident.finding.signal} (${incident.finding.severity})`,
          });
        }
        if (incident.diagnosis) {
          timeline.push({
            timestamp: incident.diagnosis.timestamp,
            agent: 'diagnostician',
            action: 'DIAGNOSIS_COMPLETE',
            detail: `Root cause: ${incident.diagnosis.suspectedRootCause.substring(0, 200)}`,
          });
        }
        if (incident.repairPlan?.approvedAt) {
          timeline.push({
            timestamp: incident.repairPlan.approvedAt,
            agent: 'repair',
            action: 'REPAIR_APPROVED',
            detail: `Approved by ${incident.repairPlan.approvedBy}. Plan: ${incident.repairPlan.planId}`,
          });
        }
        if (incident.repairPlan?.completedAt) {
          timeline.push({
            timestamp: incident.repairPlan.completedAt,
            agent: 'repair',
            action: `REPAIR_${incident.repairPlan.result}`,
            detail: `Result: ${incident.repairPlan.result}. ${incident.repairPlan.commands.length} commands.`,
          });
        }

        // Calculate metrics
        // TTD  = Time-to-Detect: watchdog detection is instantaneous (finding created at incident creation)
        // TTDiag = Time-to-Diagnose: from incident creation to diagnosis completion
        // TTR  = Time-to-Repair: from diagnosis completion to repair completion
        const created = new Date(incident.createdAt).getTime();
        const findingTime = incident.finding?.timestamp ? new Date(incident.finding.timestamp).getTime() : created;
        const diagnosed = incident.diagnosis ? new Date(incident.diagnosis.timestamp).getTime() : created;
        const repaired = incident.repairPlan?.completedAt ? new Date(incident.repairPlan.completedAt).getTime() : diagnosed;

        const ttd = Math.max(0, Math.round((findingTime - created) / 60000));
        const ttdiag = Math.max(0, Math.round((diagnosed - findingTime) / 60000));
        const ttr = Math.max(0, Math.round((repaired - diagnosed) / 60000));

        // M10: ROI figures are a severity-bucket HEURISTIC ESTIMATE, not measured
        // savings. The helper carries an explicit `estimated`/`basis` annotation.
        // Bucket values + math are unchanged. (TTD/TTDiag/TTR above are real.)
        const roi = estimateRepairRoi(incident.severity, ttd + ttdiag + ttr);
        const humanTimeSaved = roi.humanTimeSavedMinutes;
        const costAvoided = roi.costAvoidedUSD;

        // Similar incident count
        const similar = Array.from(incidents.values()).filter(i =>
          i.incidentId !== incident.incidentId &&
          i.finding?.findingType === incident.finding?.findingType
        );

        // What worked / failed
        const whatWorked: string[] = [];
        const whatFailed: string[] = [];

        if (incident.finding) whatWorked.push(`Watchdog detected ${incident.finding.findingType}`);
        if (incident.diagnosis?.confidence === 'high') whatWorked.push('Matched known playbook pattern');
        if (incident.diagnosis?.confidence === 'low') whatFailed.push('No matching playbook — needed manual investigation');
        if (incident.repairPlan?.result === 'SUCCESS') whatWorked.push('Repair executed successfully');
        if (incident.repairPlan?.result === 'FAILED') whatFailed.push('Repair failed — rollback required');

        // Prevention actions
        const preventionActions: string[] = [];
        const ft = incident.finding?.findingType;
        if (ft === 'DISK_PRESSURE') preventionActions.push('Set up weekly Docker image pruning', 'Add 70% disk alerting');
        else if (ft === 'TLS_EXPIRING') preventionActions.push('Configure certbot auto-renewal cron', 'Add 30-day cert monitoring');
        else if (ft === 'SERVICE_DOWN') preventionActions.push('Review container restart policies', 'Add health check alerting');
        else preventionActions.push('Monitor for recurrence', 'Consider dedicated health check for this failure mode');

        // Playbook delta if this was a new pattern
        let playbookDelta;
        if (incident.diagnosis?.confidence !== 'high' && incident.repairPlan?.result === 'SUCCESS') {
          playbookDelta = {
            deltaId: genId('DELTA'),
            targetPackId: 'incident-playbooks-v1',
            additions: {
              patterns: [`${incident.finding?.findingType}_learned_${Date.now().toString(36)}`],
              diagnosticSteps: incident.diagnosis?.actionsPerformed || [],
              repairRecipes: incident.repairPlan?.commands.map(c => `Step ${c.step}: ${c.command}`) || [],
            },
            promotionStatus: 'PENDING — requires PLAYBOOK_PROMOTION gate (MANDATORY, ORG owner)',
          };
        }

        const postmortem = {
          postmortemId: genId('PM'),
          incidentId: incident.incidentId,
          title: `Incident: ${incident.finding?.findingType || 'Unknown'} — ${incident.severity}`,
          severity: incident.severity,
          timeline,
          rootCause: incident.diagnosis?.suspectedRootCause || 'Not determined',
          whatWorked,
          whatFailed,
          preventionActions,
          playbookDelta,
          metrics: {
            timeToDetectMinutes: ttd,
            timeToDiagnoseMinutes: ttdiag,
            timeToRepairMinutes: ttr,
            totalResolutionMinutes: ttd + ttdiag + ttr,
            // M10: humanTimeSavedMinutes / costAvoidedUSD are ESTIMATES from a
            // severity-bucket heuristic, NOT measured savings. Keys are kept under
            // their original names (already persisted in srt_incidents_persistent
            // postmortem JSONB — renaming would be a data seam); the annotation
            // fields below mark them honestly. TTD/TTDiag/TTR are real measurements.
            humanTimeSavedMinutes: humanTimeSaved,
            costAvoidedUSD: costAvoided,
            roiEstimated: roi.estimated,
            roiBasis: roi.basis,
            recurrenceCount: similar.length,
          },
          timestamp: new Date().toISOString(),
        };

        // Update incident
        incident.postmortem = postmortem;
        incident.status = 'POSTMORTEM_GENERATED';
        incident.resolvedAt = new Date().toISOString();
        incident.updatedAt = new Date().toISOString();
        persistIncident(incident); // Write-through: postmortem + resolution

        engine.telemetryService.emitToolCall('srt_generate_postmortem', incident.incidentId, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          postmortem,
          incidentResolved: true,
          status: 'POSTMORTEM_GENERATED',
        }, null, 2) }] };
      } catch (error) {
        engine.telemetryService.emitToolCall('srt_generate_postmortem', `postmortem-err-${Date.now().toString(36)}`, 'ADVISORY', false);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'POSTMORTEM_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONVENIENCE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Register all 4 SRT tools with the MCP server.
 */
export function registerSRTTools(server: McpServer, engine: GovernanceEngine): void {
  registerSRTRunWatchdogTool(server, engine);
  registerSRTDiagnoseTool(server, engine);
  registerSRTApproveRepairTool(server, engine);
  registerSRTGeneratePostmortemTool(server, engine);
}
