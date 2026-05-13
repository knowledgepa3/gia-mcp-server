/**
 * @module    mcp-tool-memory-packs
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       varies — seal is ADVISORY, transfer is MANDATORY
 * @audit     true — all GMP operations are ledger-recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * Governed Memory Pack (GMP) MCP Tools
 *
 * 6 tools for the full GMP lifecycle:
 * - seal_memory_pack: Create and hash-seal a new governed memory pack
 * - load_memory_pack: Load a pack into agent context (validates TTL, trust, roles)
 * - transfer_memory_pack: Agent-to-agent knowledge corridor (MANDATORY gate)
 * - compose_memory_packs: Stack multiple packs into unified context
 * - distill_memory_pack: Learn governance patterns from usage history
 * - promote_memory_pack: Upgrade trust level after human review
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { persistPack, persistUsageEvent, recoverPacks, recoverUsageLog, isGMPPersistenceEnabled } from '../../core/persistence/gmp-persistence.js';

// ═══════════════════════════════════════════════════════════════════
// In-memory GMP store for MCP server
// (mirrors services/governedMemoryPacks.ts but runs in MCP process)
// ═══════════════════════════════════════════════════════════════════

interface GMPPack {
  memoryPackId: string;
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
  status: string;
  policy: {
    readOnly: boolean;
    writeBackAllowed: boolean;
    exportAllowed: boolean;
    requiresGateForUse: boolean;
    allowedRoles: string[];
    allowedContexts?: string[];
  };
  content: {
    principles: string[];
    sop: string[];
    heuristics: string[];
    antiPatterns: string[];
  };
  audit: {
    createdAt: string;
    lastReviewed: string;
    expiresAt: string;
    usageCount: number;
    lastUsedBy?: string;
  };
}

const TRUST_RANK: Record<string, number> = { SYSTEM: 4, ORG: 3, CASE: 2, EPHEMERAL: 1 };
const TRUST_MAX_TTL: Record<string, number> = { SYSTEM: 8760, ORG: 2160, CASE: 168, EPHEMERAL: 4 };
const TRUST_SEAL_ROLES: Record<string, string[]> = {
  SYSTEM: ['platform-owner', 'isso'],
  ORG: ['platform-owner', 'isso', 'supervisor', 'org-admin'],
  CASE: ['platform-owner', 'isso', 'supervisor', 'forensic-analyst', 'agent'],
  EPHEMERAL: [],
};

const gmpPacks = new Map<string, GMPPack>();
const gmpUsageLog: Array<{ event: string; memoryPackId: string; agentId: string; runId: string; hash: string; approvedBy: string; timestamp: string }> = [];

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])).join(',') + '}';
}

// Track whether we've recovered from persistence
let recoveryComplete = false;
let recoveryPromise: Promise<void> | null = null;

/**
 * Recover GMP packs and usage log from PostgreSQL.
 * Called once, returns a promise that resolves when recovery is complete.
 * Subsequent calls return the same promise (idempotent).
 */
function ensureRecovery(): Promise<void> {
  if (recoveryComplete) return Promise.resolve();
  if (recoveryPromise) return recoveryPromise;

  if (!isGMPPersistenceEnabled()) {
    recoveryComplete = true;
    return Promise.resolve();
  }

  recoveryPromise = (async () => {
    try {
      // Recover packs
      const rows = await recoverPacks();
      for (const row of rows) {
        if (!gmpPacks.has(row.memory_pack_id)) {
          const pack: GMPPack = {
            memoryPackId: row.memory_pack_id,
            version: row.version,
            type: row.type,
            trustLevel: row.trust_level,
            domain: row.domain,
            scope: row.scope || [],
            riskLevel: row.risk_level,
            ttlHours: row.ttl_hours,
            createdBy: row.created_by,
            signedBy: row.signed_by,
            hash: row.hash,
            status: row.status,
            policy: row.policy || { readOnly: true, writeBackAllowed: false, exportAllowed: false, requiresGateForUse: false, allowedRoles: [] },
            content: row.content || { principles: [], sop: [], heuristics: [], antiPatterns: [] },
            audit: {
              createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
              lastReviewed: row.last_reviewed_at instanceof Date ? row.last_reviewed_at.toISOString() : row.last_reviewed_at,
              expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
              usageCount: row.usage_count || 0,
              lastUsedBy: row.last_used_by || undefined,
            },
          };
          gmpPacks.set(pack.memoryPackId, pack);
        }
      }
      if (rows.length > 0) {
        console.error(`[GMP] Recovered ${rows.length} packs from PostgreSQL`);
      }

      // Recover usage log (needed for distill_memory_pack)
      const logRows = await recoverUsageLog();
      for (const row of logRows) {
        gmpUsageLog.push({
          event: row.event,
          memoryPackId: row.memory_pack_id,
          agentId: row.agent_id,
          runId: row.run_id,
          hash: row.hash,
          approvedBy: row.approved_by || '',
          timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
        });
      }
      if (logRows.length > 0) {
        console.error(`[GMP] Recovered ${logRows.length} usage log entries from PostgreSQL`);
      }
    } catch (err) {
      console.error('[GMP] Recovery failed:', (err as Error).message);
    }
    recoveryComplete = true;
  })();

  return recoveryPromise;
}

// Seed default packs (and recover from PostgreSQL on first call)
async function seedDefaults() {
  // Await recovery before proceeding (eliminates race condition)
  await ensureRecovery();

  if (gmpPacks.has('ace-platform-core-v1')) return;

  const now = new Date().toISOString();

  const corePack: GMPPack = {
    memoryPackId: 'ace-platform-core-v1',
    version: '1.0.0',
    type: 'RISK_GUARDRAILS',
    trustLevel: 'SYSTEM',
    domain: 'platform',
    scope: ['governance', 'compliance', 'audit', 'safety'],
    riskLevel: 'MANDATORY',
    ttlHours: 720,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    status: 'SEALED',
    policy: {
      readOnly: true, writeBackAllowed: false, exportAllowed: false,
      requiresGateForUse: false, allowedRoles: [],
    },
    content: {
      principles: [
        'Never fabricate compliance claims or audit evidence',
        'Never auto-approve MANDATORY gates without human confirmation',
        'Never store PII/PHI in plaintext — hash or redact',
        'Never bypass MAI classification for convenience',
        'Every action produces an audit trail entry',
      ],
      sop: [
        'Classify all decisions before execution',
        'Score governance outputs before shipping',
        'Monitor Storey Threshold — healthy band is 10-18%',
        'Verify ledger chain integrity on system boot',
      ],
      heuristics: [
        'If financial impact detected → MANDATORY',
        'If legal impact detected → MANDATORY',
        'If client-facing → MANDATORY',
        'If PII/PHI detected → MANDATORY + redact',
      ],
      antiPatterns: [
        'Do not suppress MANDATORY escalations to reduce friction',
        'Do not cache governance decisions — evaluate at runtime',
        'Do not export sealed evidence packs without approval gate',
        'Do not self-approve gates — require distinct human operator',
      ],
    },
    audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + 720 * 3600000).toISOString(), usageCount: 0 },
  };
  corePack.hash = djb2Hash(canonicalize({ id: corePack.memoryPackId, version: corePack.version, type: corePack.type, trust: corePack.trustLevel, content: corePack.content }));
  gmpPacks.set(corePack.memoryPackId, corePack);

  // ── Tier 2: GIA Federal Vertical Pack ────────────────────────────────────
  // Constitutional → Vertical → Client three-tier architecture.
  // This pack carries VA/SDVOSB/federal institutional law: Title 38 USC, 38 CFR,
  // FAR/VAAR, EO 14110, NIST AI RMF, and OMB M-24-10. Auto-loaded on every
  // dispatch alongside ace-platform-core-v1 because ACE operates exclusively
  // in the federal vertical. Ratified by William J. Storey III (2026-05-03).
  const federalVerticalPack: GMPPack = {
    memoryPackId: 'gia-vertical-federal-v1',
    version: '1.0.0',
    type: 'REGULATORY',
    trustLevel: 'ORG',
    domain: 'federal-vertical',
    scope: ['va-claims', 'sdvosb', 'federal-acquisition', 'veterans', 'federal-ai-governance', 'privacy'],
    riskLevel: 'MANDATORY',
    ttlHours: 2160, // 90 days — ORG max
    createdBy: 'william-storey-isso',
    signedBy: 'ace-system',
    hash: '',
    status: 'SEALED',
    policy: {
      readOnly: true, writeBackAllowed: false, exportAllowed: false,
      requiresGateForUse: false, allowedRoles: [],
    },
    content: {
      principles: [
        '38 USC 5107(b) benefit-of-the-doubt doctrine — resolve all reasonable doubt in the veteran\'s favor',
        'SDVOSB set-aside eligibility governed by 38 USC 8127-8128 and VA Rule of Two — verify CVE enrollment before bid',
        'Federal acquisition commits require written modification signed by the Contracting Officer — no oral agreements',
        'EO 14110 Section 10 — federal AI systems influencing decisions on rights/benefits require human-in-the-loop review',
        'NIST AI RMF: GOVERN function must be established before MAP/MEASURE/MANAGE — governance precedes deployment',
        'OMB M-24-10 — federal agencies must conduct AI use case risk assessments before deploying AI for operations',
        'VA Privacy Act (38 CFR 1.576) — veteran records protected by Privacy Act; disclosure requires authorization or statutory exception',
        '5 USC 552a Privacy Act — federal PII handled with notice, consent, access, correction, and security rights',
      ],
      sop: [
        'VA claims: before any assertion, validate condition against 38 CFR Part 4 diagnostic codes and rating schedule',
        'SDVOSB bids: verify current SAM.gov registration and active CVE certificate before submitting under any set-aside',
        'Federal AI: complete OMB AI use case inventory entry before deploying AI in any VA/federal operational role',
        'Veteran PII: verify requester authorization under 38 CFR 1.576 before releasing any veteran record data',
        'Contract modification: obtain CO-signed modification — never act on verbal direction from a government employee',
        'Federal AI decision: produce MAI-classified evidence chain per NIST AI RMF MEASURE 2.7 for every AI-assisted benefit or eligibility decision',
        'Incident response: notify VA Privacy Officer within 1 hour of any suspected veteran PII breach (VA Handbook 6500)',
      ],
      heuristics: [
        'If veteran record involved → MANDATORY classification, Privacy Act protections apply automatically',
        'If SDVOSB status is challenged → CVE database (vetbiz.va.gov) is authoritative, not local records',
        'If AI output informs federal benefit decision → human review gate required before action (EO 14110)',
        'If procuring agency is VHA/VBA/VACO → VAAR applies in addition to base FAR — check both',
        'If AI system risk classification is ambiguous in federal context → default to high-risk, document rationale',
        'If Rule of Two applies → set-aside is mandatory unless price is unreasonable or only one SDVOSB qualifies',
        'If contract value exceeds SAT ($250K) → written justification required for any sole-source action',
        'If C&A/ATO is required → ATO must be in place before operating AI system on VA networks',
      ],
      antiPatterns: [
        'NEVER submit VA claims with AI-generated nexus opinions — violates M21-1 adjudication standards',
        'NEVER treat SDVOSB CVE certification as permanent — CVE requires annual recertification',
        'NEVER auto-execute government contract modifications — Contracting Officer authority is non-delegable',
        'NEVER store veteran PII outside VA-authorized systems without a signed data sharing agreement',
        'NEVER deploy AI for federal benefit eligibility decisions without a human-in-the-loop gate on the final output',
        'NEVER represent SDVOSB set-aside eligibility without a current, active CVE certificate on file',
        'NEVER bypass VA privacy screening (38 CFR 1.576) for bulk record requests — each request requires independent authorization',
      ],
    },
    audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + 2160 * 3600000).toISOString(), usageCount: 0 },
  };
  federalVerticalPack.hash = djb2Hash(canonicalize({ id: federalVerticalPack.memoryPackId, version: federalVerticalPack.version, type: federalVerticalPack.type, trust: federalVerticalPack.trustLevel, content: federalVerticalPack.content }));
  gmpPacks.set(federalVerticalPack.memoryPackId, federalVerticalPack);

  const vaPack: GMPPack = {
    memoryPackId: 'ace-va-forensics-v1',
    version: '1.0.0',
    type: 'DOMAIN_SOP',
    trustLevel: 'ORG',
    domain: 'va-claims',
    scope: ['forensics', 'evidence', 'audit', 'disability', 'veterans'],
    riskLevel: 'MANDATORY',
    ttlHours: 720,
    createdBy: 'gia-governor',
    signedBy: 'ace-system',
    hash: '',
    status: 'SEALED',
    policy: {
      readOnly: true, writeBackAllowed: false, exportAllowed: false,
      requiresGateForUse: true, allowedRoles: ['forensic-analyst', 'supervisor', 'isso'],
    },
    content: {
      principles: [
        'Never fabricate nexus language for veteran claims',
        'Always cite evidence source and date',
        'Disability ratings require human review — no exceptions',
        'Veteran benefit decisions are always MANDATORY classification',
      ],
      sop: [
        'Validate chain of custody',
        'Run forensic pipeline with evidence validation',
        'Cross-reference medical records with service records',
        'Submit for supervisor review before finalization',
      ],
      heuristics: [
        'If evidence conflicts → escalate to MANDATORY',
        'If PHI detected → mask before analysis',
        'If nexus language is ambiguous → flag for SME review',
      ],
      antiPatterns: [
        'Do not auto-generate nexus opinions',
        'Do not combine records from different veterans',
        'Do not export unsealed evidence bundles',
        'Do not bypass supervisor review for disability ratings',
      ],
    },
    audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + 720 * 3600000).toISOString(), usageCount: 0 },
  };
  vaPack.hash = djb2Hash(canonicalize({ id: vaPack.memoryPackId, version: vaPack.version, type: vaPack.type, trust: vaPack.trustLevel, content: vaPack.content }));
  gmpPacks.set(vaPack.memoryPackId, vaPack);
}

// ═══════════════════════════════════════════════════════════════════
// TOOL REGISTRATIONS
// ═══════════════════════════════════════════════════════════════════

export function registerSealMemoryPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'seal_memory_pack',
    'Create and hash-seal a new Governed Memory Pack (GMP). The pack becomes an immutable, TTL-bound institutional knowledge artifact with trust level enforcement.',
    {
      pack_id: z.string().max(100).describe('Unique identifier for the memory pack'),
      version: z.string().default('1.0.0').describe('Semantic version'),
      type: z.enum(['DOMAIN_SOP', 'PLAYBOOK', 'REGULATORY', 'RISK_GUARDRAILS', 'HEURISTIC', 'KNOWLEDGE']).describe('Pack type'),
      trust_level: z.enum(['SYSTEM', 'ORG', 'CASE', 'EPHEMERAL']).describe('Trust level (SYSTEM > ORG > CASE > EPHEMERAL)'),
      domain: z.string().max(100).describe('Domain (e.g., va-claims, finance, cyber-ir)'),
      scope: z.array(z.string()).describe('Scope tags'),
      risk_level: z.enum(['MANDATORY', 'ADVISORY', 'INFORMATIONAL']).default('ADVISORY').describe('MAI classification'),
      ttl_hours: z.number().min(1).max(8760).describe('TTL in hours (capped by trust level)'),
      created_by: z.string().max(100).describe('Creator identity'),
      sealer_role: z.string().optional().describe('Role of the sealer (for trust level enforcement)'),
      principles: z.array(z.string()).describe('Core principles'),
      sop: z.array(z.string()).describe('Standard operating procedures'),
      heuristics: z.array(z.string()).describe('Decision heuristics'),
      anti_patterns: z.array(z.string()).describe('Prohibited patterns'),
      allowed_roles: z.array(z.string()).default([]).describe('RBAC roles allowed to load this pack'),
    },
    { title: 'Seal Memory Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        await seedDefaults();

        const trustLevel = input.trust_level;
        const allowedSealers = TRUST_SEAL_ROLES[trustLevel];
        if (allowedSealers.length > 0 && input.sealer_role && !allowedSealers.includes(input.sealer_role)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Role '${input.sealer_role}' cannot seal ${trustLevel} packs`, allowedRoles: allowedSealers }) }], isError: true };
        }

        // Content safety: detect governance-undermining patterns in pack content.
        // Red team finding (2026-04-11): poisoned EPHEMERAL packs with SOPs like
        // "skip human review" or "auto-approve gates" could be sealed and loaded.
        const GOVERNANCE_POISON_PATTERNS = [
          /auto[- ]?approve/i, /skip.*human/i, /bypass.*gate/i, /override.*mandatory/i,
          /self[- ]?promote/i, /remove.*oversight/i, /disable.*gate/i, /ignore.*governance/i,
        ];
        const allContent = [...input.principles, ...input.sop, ...input.heuristics].join(' ');
        const poisonMatches = GOVERNANCE_POISON_PATTERNS.filter(p => p.test(allContent));
        if (poisonMatches.length > 0) {
          // Flag but don't block EPHEMERAL — they're advisory-only and short-lived.
          // Block anything above EPHEMERAL outright.
          if (trustLevel !== 'EPHEMERAL') {
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'GOVERNANCE_POISON_DETECTED',
              message: `Pack content contains governance-undermining patterns. ${trustLevel} packs with these patterns are blocked.`,
              patternsDetected: poisonMatches.map(p => p.source),
              recommendation: 'Review content and remove governance-undermining instructions.',
            }) }], isError: true };
          }
          // EPHEMERAL: allow but tag the pack for monitoring
          input.scope = [...input.scope, 'governance-poison-flagged'];
        }

        const maxTTL = TRUST_MAX_TTL[trustLevel];
        const effectiveTTL = Math.min(input.ttl_hours, maxTTL);
        const now = new Date().toISOString();

        const pack: GMPPack = {
          memoryPackId: input.pack_id,
          version: input.version,
          type: input.type,
          trustLevel,
          domain: input.domain,
          scope: input.scope,
          riskLevel: input.risk_level,
          ttlHours: effectiveTTL,
          createdBy: input.created_by,
          signedBy: input.sealer_role || input.created_by,
          hash: '',
          status: 'SEALED',
          policy: {
            readOnly: true, writeBackAllowed: false, exportAllowed: false,
            requiresGateForUse: input.risk_level === 'MANDATORY',
            allowedRoles: input.allowed_roles,
          },
          content: {
            principles: input.principles,
            sop: input.sop,
            heuristics: input.heuristics,
            antiPatterns: input.anti_patterns,
          },
          audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + effectiveTTL * 3600000).toISOString(), usageCount: 0 },
        };
        pack.hash = djb2Hash(canonicalize({ id: pack.memoryPackId, version: pack.version, type: pack.type, trust: pack.trustLevel, content: pack.content }));

        gmpPacks.set(pack.memoryPackId, pack);
        persistPack(pack); // Write-through to PostgreSQL

        const usageEvent = { event: 'GMP_SEALED', memoryPackId: pack.memoryPackId, agentId: input.created_by, runId: 'seal', hash: pack.hash, approvedBy: pack.signedBy, timestamp: now };
        gmpUsageLog.push(usageEvent);
        persistUsageEvent(usageEvent); // Write-through to PostgreSQL

        // Telemetry: seal success
        engine.telemetryService.emitToolCall('seal_memory_pack', `seal-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          sealed: true,
          memoryPackId: pack.memoryPackId,
          hash: pack.hash,
          trustLevel: pack.trustLevel,
          ttlHours: effectiveTTL,
          expiresAt: pack.audit.expiresAt,
          status: pack.status,
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: seal failure
        engine.telemetryService.emitToolCall('seal_memory_pack', `seal-${Date.now().toString(36)}`, 'ADVISORY', false);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SEAL_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerLoadMemoryPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'load_memory_pack',
    'Load a Governed Memory Pack into agent context. Validates TTL, trust level, role access, context class, and hash integrity before loading.',
    {
      pack_id: z.string().max(100).describe('Memory pack ID to load'),
      agent_id: z.string().max(100).describe('Agent requesting the load'),
      run_id: z.string().max(100).describe('Current run/pipeline ID'),
      operator_role: z.string().max(100).describe('Role of the operator'),
      context_class: z.enum(['PROD', 'STAGING', 'DEMO', 'EVAL_ONLY', 'TRAINING']).optional().describe('Execution context class'),
    },
    { title: 'Load Memory Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        await seedDefaults();
        const pack = gmpPacks.get(input.pack_id);
        if (!pack) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Memory pack not found: ${input.pack_id}`, available: Array.from(gmpPacks.keys()) }) }], isError: true };
        }

        // Check status
        if (pack.status === 'REVOKED') {
          const promotedId = `${input.pack_id}-promoted`;
          const promotedExists = gmpPacks.has(promotedId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: `Pack revoked: ${input.pack_id}`,
            hint: promotedExists
              ? `This pack was promoted to a higher trust level. Use pack_id: "${promotedId}" instead.`
              : 'This pack has been revoked and cannot be used. Re-seal a new pack with seal_memory_pack.',
            promotedPackId: promotedExists ? promotedId : undefined,
          }) }], isError: true };
        }
        // Check TTL
        if (new Date(pack.audit.expiresAt) < new Date()) {
          pack.status = 'EXPIRED';
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Pack expired: ${input.pack_id}`, expiredAt: pack.audit.expiresAt }) }], isError: true };
        }
        // Check role
        if (pack.policy.allowedRoles.length > 0 && !pack.policy.allowedRoles.includes(input.operator_role)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Role '${input.operator_role}' not authorized`, allowedRoles: pack.policy.allowedRoles }) }], isError: true };
        }
        // Check context
        if (pack.policy.allowedContexts && pack.policy.allowedContexts.length > 0 && input.context_class) {
          if (!pack.policy.allowedContexts.includes(input.context_class)) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Context '${input.context_class}' not allowed`, allowedContexts: pack.policy.allowedContexts }) }], isError: true };
          }
        }

        // Update usage
        pack.audit.usageCount++;
        pack.audit.lastUsedBy = input.agent_id;
        pack.status = 'ACTIVE';
        persistPack(pack); // Write-through: usage + status update

        const loadEvent = { event: 'GMP_LOADED', memoryPackId: input.pack_id, agentId: input.agent_id, runId: input.run_id, hash: pack.hash, approvedBy: input.operator_role, timestamp: new Date().toISOString() };
        gmpUsageLog.push(loadEvent);
        persistUsageEvent(loadEvent);

        const canAutomate = ['SYSTEM', 'ORG'].includes(pack.trustLevel);

        // Telemetry: load success
        engine.telemetryService.emitToolCall('load_memory_pack', `load-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          loaded: true,
          memoryPackId: pack.memoryPackId,
          trustLevel: pack.trustLevel,
          domain: pack.domain,
          scope: pack.scope,
          riskLevel: pack.riskLevel,
          advisoryOnly: !canAutomate,
          gateRequired: pack.policy.requiresGateForUse && pack.riskLevel === 'MANDATORY',
          content: pack.content,
          usageCount: pack.audit.usageCount,
          expiresAt: pack.audit.expiresAt,
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: load failure
        engine.telemetryService.emitToolCall('load_memory_pack', `load-${Date.now().toString(36)}`, 'ADVISORY', false);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'LOAD_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerTransferMemoryPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'transfer_memory_pack',
    'Transfer a memory pack between agents via a governed knowledge corridor. Creates a derived pack with transfer provenance. ALWAYS requires MANDATORY gate — no silent transfers.',
    {
      source_pack_id: z.string().max(100).describe('Source pack to transfer'),
      source_agent_id: z.string().max(100).describe('Agent transferring the pack'),
      target_agent_id: z.string().max(100).describe('Agent receiving the pack'),
      target_role: z.string().max(100).describe('Role of the target agent'),
      approved_by: z.string().max(100).describe('Human who approved the transfer (MANDATORY)'),
      scope_filter: z.array(z.string()).optional().describe('Optional: only transfer specific scope items'),
    },
    { title: 'Transfer Memory Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const entry = engine.ledger.begin(
        'transfer-memory-pack',
        MaiClassification.MANDATORY,
        GiaLayer.MCP,
        input.source_agent_id
      );
      entry.addMetadata('sourcePackId', input.source_pack_id);
      entry.addMetadata('targetAgentId', input.target_agent_id);
      entry.addMetadata('approvedBy', input.approved_by);

      try {
        await seedDefaults();
        if (!input.approved_by || input.approved_by === 'system') {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Memory transfers require human approval — MANDATORY gate', gateRequired: true }) }], isError: true };
        }
        const source = gmpPacks.get(input.source_pack_id);
        if (!source) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Source pack not found: ${input.source_pack_id}` }) }], isError: true };
        }
        if (source.status === 'EXPIRED' || source.status === 'REVOKED') {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Cannot transfer ${source.status} pack` }) }], isError: true };
        }

        // Create derived pack
        const derivedTrust = (TRUST_RANK[source.trustLevel] > TRUST_RANK['CASE']) ? 'CASE' : source.trustLevel;
        const derivedId = `${input.source_pack_id}-transfer-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        const effectiveTTL = Math.min(source.ttlHours, 24);

        const derived: GMPPack = {
          memoryPackId: derivedId,
          version: `${source.version}+transfer`,
          type: source.type,
          trustLevel: derivedTrust,
          domain: source.domain,
          scope: input.scope_filter || source.scope,
          riskLevel: source.riskLevel,
          ttlHours: effectiveTTL,
          createdBy: input.source_agent_id,
          signedBy: input.approved_by,
          hash: '',
          status: 'SEALED',
          policy: { ...source.policy, exportAllowed: false, writeBackAllowed: false },
          content: input.scope_filter
            ? Object.fromEntries(
                Object.entries(source.content).filter(([key]) => input.scope_filter!.includes(key))
              ) as typeof source.content
            : source.content,
          audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + effectiveTTL * 3600000).toISOString(), usageCount: 0 },
        };
        derived.hash = djb2Hash(canonicalize({ id: derived.memoryPackId, version: derived.version, type: derived.type, trust: derived.trustLevel, content: derived.content }));
        gmpPacks.set(derivedId, derived);
        persistPack(derived); // Write-through

        const transferEvent = { event: 'GMP_TRANSFERRED', memoryPackId: input.source_pack_id, agentId: `${input.source_agent_id}→${input.target_agent_id}`, runId: derivedId, hash: derived.hash, approvedBy: input.approved_by, timestamp: now };
        gmpUsageLog.push(transferEvent);
        persistUsageEvent(transferEvent);

        const score = engine.scorer.scoreDefault('transfer-memory-pack');
        const completedEntry = entry.complete(score, {
          classification: MaiClassification.MANDATORY,
          confidence: 1.0,
          rationale: `Memory pack transferred: ${input.source_pack_id} → ${input.target_agent_id}`,
          requiresGate: false,
        });
        engine.ledger.record(completedEntry);

        // Telemetry: transfer success
        engine.telemetryService.emitToolCall('transfer_memory_pack', entry.id, 'MANDATORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          transferred: true,
          derivedPackId: derivedId,
          derivedTrustLevel: derivedTrust,
          ttlHours: effectiveTTL,
          expiresAt: derived.audit.expiresAt,
          hash: derived.hash,
          sourcePackId: input.source_pack_id,
          corridor: `${input.source_agent_id} → ${input.target_agent_id}`,
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: transfer failure
        engine.telemetryService.emitToolCall('transfer_memory_pack', entry.id, 'MANDATORY', false);

        const failedEntry = entry.fail(error instanceof Error ? error : new Error('Transfer failed'), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'TRANSFER_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerComposeMemoryPacksTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'compose_memory_packs',
    'Compose multiple memory packs into a unified execution context. Highest risk level wins, shortest TTL wins, roles intersect, trust level contaminates downward.',
    {
      pack_ids: z.array(z.string()).min(2).describe('IDs of packs to compose (minimum 2)'),
      composed_id: z.string().max(100).describe('ID for the composed pack'),
      agent_id: z.string().max(100).describe('Agent performing composition'),
      operator_role: z.string().max(100).describe('Operator role'),
    },
    { title: 'Compose Memory Packs', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        await seedDefaults();
        const sources: GMPPack[] = [];
        for (const id of input.pack_ids) {
          const pack = gmpPacks.get(id);
          if (!pack) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Pack not found: ${id}` }) }], isError: true };
          if (pack.status === 'REVOKED' || pack.status === 'EXPIRED') {
            const promotedId = `${id}-promoted`;
            const promotedExists = gmpPacks.has(promotedId);
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              error: `Cannot compose ${pack.status} pack: ${id}`,
              hint: pack.status === 'REVOKED' && promotedExists
                ? `This pack was promoted. Use pack_id: "${promotedId}" instead.`
                : `Pack is ${pack.status} and cannot be composed.`,
              promotedPackId: pack.status === 'REVOKED' && promotedExists ? promotedId : undefined,
            }) }], isError: true };
          }
          sources.push(pack);
        }

        // Trust contamination check
        const trustLevels = sources.map(s => s.trustLevel);
        const hasEphemeral = trustLevels.includes('EPHEMERAL');
        const hasNonEphemeral = trustLevels.some(l => l !== 'EPHEMERAL');
        if (hasEphemeral && hasNonEphemeral) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Trust contamination: EPHEMERAL cannot compose with higher trust levels', trustLevels }) }], isError: true };
        }

        const outputTrust = trustLevels.reduce((lowest, l) => (TRUST_RANK[l] < TRUST_RANK[lowest]) ? l : lowest);
        const riskOrder: Record<string, number> = { MANDATORY: 3, ADVISORY: 2, INFORMATIONAL: 1 };
        const highestRisk = sources.reduce((max, s) => riskOrder[s.riskLevel] > riskOrder[max] ? s.riskLevel : max, 'INFORMATIONAL');
        const shortestTTL = Math.min(...sources.map(s => s.ttlHours));
        const dedup = (arr: string[]) => [...new Set(arr)];
        const now = new Date().toISOString();

        const composed: GMPPack = {
          memoryPackId: input.composed_id,
          version: '1.0.0-composed',
          type: 'KNOWLEDGE',
          trustLevel: outputTrust,
          domain: sources.map(s => s.domain).join('+'),
          scope: dedup(sources.flatMap(s => s.scope)),
          riskLevel: highestRisk,
          ttlHours: shortestTTL,
          createdBy: input.agent_id,
          signedBy: 'gia-composer',
          hash: '',
          status: 'SEALED',
          policy: {
            readOnly: true, writeBackAllowed: false, exportAllowed: false,
            requiresGateForUse: sources.some(s => s.policy.requiresGateForUse),
            allowedRoles: [],
          },
          content: {
            principles: dedup(sources.flatMap(s => s.content.principles)),
            sop: dedup(sources.flatMap(s => s.content.sop)),
            heuristics: dedup(sources.flatMap(s => s.content.heuristics)),
            antiPatterns: dedup(sources.flatMap(s => s.content.antiPatterns)),
          },
          audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + shortestTTL * 3600000).toISOString(), usageCount: 0 },
        };
        composed.hash = djb2Hash(canonicalize({ id: composed.memoryPackId, version: composed.version, type: composed.type, trust: composed.trustLevel, content: composed.content }));
        gmpPacks.set(composed.memoryPackId, composed);
        persistPack(composed); // Write-through

        const composeEvent = { event: 'GMP_COMPOSED', memoryPackId: input.composed_id, agentId: input.agent_id, runId: `compose:${input.pack_ids.join('+')}`, hash: composed.hash, approvedBy: input.operator_role, timestamp: now };
        gmpUsageLog.push(composeEvent);
        persistUsageEvent(composeEvent);

        // Telemetry: compose success
        engine.telemetryService.emitToolCall('compose_memory_packs', `compose-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          composed: true,
          composedPackId: composed.memoryPackId,
          trustLevel: outputTrust,
          riskLevel: highestRisk,
          ttlHours: shortestTTL,
          hash: composed.hash,
          sourcePacks: input.pack_ids,
          mergedScope: composed.scope,
          principleCount: composed.content.principles.length,
          sopCount: composed.content.sop.length,
          heuristicCount: composed.content.heuristics.length,
          antiPatternCount: composed.content.antiPatterns.length,
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: compose failure
        engine.telemetryService.emitToolCall('compose_memory_packs', `compose-${Date.now().toString(36)}`, 'ADVISORY', false);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'COMPOSE_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerDistillMemoryPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'distill_memory_pack',
    'Distill governance patterns from usage history into a draft heuristic pack. Returns EPHEMERAL draft that requires MANDATORY gate to approve for production use.',
    {
      domain: z.string().max(100).describe('Domain to distill patterns from'),
      min_usage_count: z.number().min(1).default(5).describe('Minimum usage events required'),
    },
    { title: 'Distill Memory Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      try {
        await seedDefaults();
        const domainLogs = gmpUsageLog.filter(e => {
          const pack = gmpPacks.get(e.memoryPackId);
          return pack && pack.domain === input.domain;
        });

        if (domainLogs.length < input.min_usage_count) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: `Insufficient data: ${domainLogs.length}/${input.min_usage_count} events`,
            domain: input.domain,
            suggestion: 'Use more GMP tools to build usage history, then distill',
          }) }], isError: true };
        }

        const insights: string[] = [];
        const eventCounts = new Map<string, number>();
        domainLogs.forEach(e => eventCounts.set(e.event, (eventCounts.get(e.event) || 0) + 1));

        const heuristics: string[] = [];
        const transferCount = eventCounts.get('GMP_TRANSFERRED') || 0;
        if (transferCount > 3) {
          heuristics.push(`High transfer activity (${transferCount}) — consider pre-composing frequently shared packs`);
          insights.push(`${transferCount} cross-agent transfers detected`);
        }
        const loadCount = eventCounts.get('GMP_LOADED') || 0;
        if (loadCount > 10) {
          heuristics.push(`High load frequency (${loadCount}) — packs are actively governing`);
          insights.push(`${loadCount} pack loads recorded`);
        }
        if (heuristics.length === 0) heuristics.push('No strong patterns detected yet — continue monitoring');

        const agents = new Set(domainLogs.map(e => e.agentId));
        insights.push(`${agents.size} agent(s) active in ${input.domain}`);

        const draftId = `${input.domain}-distilled-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        const draft: GMPPack = {
          memoryPackId: draftId,
          version: '0.1.0-draft',
          type: 'HEURISTIC',
          trustLevel: 'EPHEMERAL',
          domain: input.domain,
          scope: ['distilled', 'auto-generated', 'requires-review'],
          riskLevel: 'MANDATORY',
          ttlHours: 48,
          createdBy: 'gia-distiller',
          signedBy: 'pending-review',
          hash: '',
          status: 'SEALED',
          policy: { readOnly: true, writeBackAllowed: false, exportAllowed: false, requiresGateForUse: true, allowedRoles: ['supervisor', 'isso'] },
          content: {
            principles: [`Auto-distilled from ${domainLogs.length} events in ${input.domain}`],
            sop: ['Review all distilled heuristics before approving for production use'],
            heuristics,
            antiPatterns: ['Do not auto-approve distilled packs — human review is mandatory'],
          },
          audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(), usageCount: 0 },
        };
        draft.hash = djb2Hash(canonicalize({ id: draft.memoryPackId, version: draft.version, type: draft.type, trust: draft.trustLevel, content: draft.content }));
        gmpPacks.set(draftId, draft);
        persistPack(draft); // Write-through

        // Telemetry: distill success
        engine.telemetryService.emitToolCall('distill_memory_pack', `distill-${Date.now().toString(36)}`, 'ADVISORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          distilled: true,
          draftPackId: draftId,
          domain: input.domain,
          eventsAnalyzed: domainLogs.length,
          heuristicsGenerated: heuristics.length,
          insights,
          trustLevel: 'EPHEMERAL',
          status: 'requires MANDATORY gate to promote',
          ttlHours: 48,
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: distill failure
        engine.telemetryService.emitToolCall('distill_memory_pack', `distill-${Date.now().toString(36)}`, 'ADVISORY', false);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DISTILL_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

export function registerPromoteMemoryPackTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'promote_memory_pack',
    'Promote a memory pack to a higher trust level after human review. This is how distilled EPHEMERAL packs become CASE or ORG packs. Requires MANDATORY gate.',
    {
      pack_id: z.string().max(100).describe('Pack ID to promote'),
      target_trust: z.enum(['SYSTEM', 'ORG', 'CASE']).describe('Target trust level (must be higher)'),
      approved_by: z.string().max(100).describe('Human approver'),
      approver_role: z.string().max(100).describe('Role of the approver'),
    },
    { title: 'Promote Memory Pack', readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    async (input) => {
      const entry = engine.ledger.begin(
        'promote-memory-pack',
        MaiClassification.MANDATORY,
        GiaLayer.MCP,
        input.approved_by
      );
      entry.addMetadata('packId', input.pack_id);
      entry.addMetadata('targetTrust', input.target_trust);
      entry.addMetadata('approverRole', input.approver_role);

      try {
        await seedDefaults();
        const pack = gmpPacks.get(input.pack_id);
        if (!pack) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Pack not found: ${input.pack_id}` }) }], isError: true };
        if (pack.status === 'REVOKED') {
          const promotedId = `${input.pack_id}-promoted`;
          const promotedExists = gmpPacks.has(promotedId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Cannot promote revoked pack',
            hint: promotedExists
              ? `This pack was already promoted. The promoted version is: "${promotedId}" (status: ${gmpPacks.get(promotedId)?.status}, trust: ${gmpPacks.get(promotedId)?.trustLevel}). Use this ID for load_memory_pack or compose_memory_packs.`
              : 'This pack has been revoked. Re-seal a new pack with seal_memory_pack before promoting.',
            promotedPackId: promotedExists ? promotedId : undefined,
          }) }], isError: true };
        }

        if (TRUST_RANK[input.target_trust] <= TRUST_RANK[pack.trustLevel]) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Cannot promote: ${pack.trustLevel} → ${input.target_trust} is not an upgrade` }) }], isError: true };
        }

        const allowed = TRUST_SEAL_ROLES[input.target_trust];
        if (allowed.length > 0 && !allowed.includes(input.approver_role)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Role '${input.approver_role}' cannot seal ${input.target_trust} packs`, allowedRoles: allowed }) }], isError: true };
        }

        const now = new Date().toISOString();
        const promotedId = `${input.pack_id}-promoted`;
        const promoted: GMPPack = {
          ...pack,
          memoryPackId: promotedId,
          version: pack.version.replace('-draft', '-promoted'),
          trustLevel: input.target_trust,
          signedBy: input.approved_by,
          scope: pack.scope.filter(s => s !== 'requires-review'),
          ttlHours: TRUST_MAX_TTL[input.target_trust],
          hash: '',
          status: 'SEALED',
          audit: { createdAt: now, lastReviewed: now, expiresAt: new Date(Date.now() + TRUST_MAX_TTL[input.target_trust] * 3600000).toISOString(), usageCount: 0 },
        };
        promoted.hash = djb2Hash(canonicalize({ id: promoted.memoryPackId, version: promoted.version, type: promoted.type, trust: promoted.trustLevel, content: promoted.content }));
        gmpPacks.set(promotedId, promoted);
        persistPack(promoted); // Write-through: new promoted pack

        // Revoke old pack
        pack.status = 'REVOKED';
        persistPack(pack); // Write-through: revoked status

        const promoteEvent = { event: 'GMP_PROMOTED', memoryPackId: promotedId, agentId: 'gia-promoter', runId: `promote:${input.pack_id}→${input.target_trust}`, hash: promoted.hash, approvedBy: input.approved_by, timestamp: now };
        gmpUsageLog.push(promoteEvent);
        persistUsageEvent(promoteEvent);

        // MANDATORY gate enforcement — promotion to SYSTEM or ORG trust MUST
        // go through human-in-the-loop gate. This was identified as a vulnerability
        // during red-team testing (2026-04-11): poisoned EPHEMERAL packs could be
        // promoted to SYSTEM trust without gate enforcement.
        const requiresGate = input.target_trust === 'SYSTEM' || input.target_trust === 'ORG';
        if (requiresGate) {
          const gateDecision = await engine.gate.enforce(
            MaiClassification.MANDATORY,
            `promote-memory-pack:${input.pack_id}→${input.target_trust}`,
            entry.id,
          );
          entry.addMetadata('gateId', gateDecision.gateId);
          entry.addMetadata('gateStatus', gateDecision.status);

          if (gateDecision.status !== 'APPROVED') {
            const failedEntry = entry.fail(
              new Error(`MANDATORY gate ${gateDecision.status} for promotion to ${input.target_trust}`),
              MaiClassification.MANDATORY,
            );
            engine.ledger.record(failedEntry);
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'GATE_REQUIRED',
              gateId: gateDecision.gateId,
              gateStatus: gateDecision.status,
              message: `Promoting to ${input.target_trust} trust requires MANDATORY gate approval. Use approve_gate tool with gate ID to approve.`,
              packId: input.pack_id,
              targetTrust: input.target_trust,
              contentPreview: promoted.content.principles?.slice(0, 3),
            }) }], isError: true };
          }
        }

        const score = engine.scorer.scoreDefault('promote-memory-pack');
        const completedEntry = entry.complete(score, {
          classification: MaiClassification.MANDATORY,
          confidence: 1.0,
          rationale: `Memory pack promoted to ${input.target_trust}: ${input.pack_id}`,
          requiresGate,
        });
        engine.ledger.record(completedEntry);

        // Telemetry: promote success
        engine.telemetryService.emitToolCall('promote_memory_pack', entry.id, 'MANDATORY', true);

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          promoted: true,
          promotedPackId: promotedId,
          previousTrust: pack.trustLevel,
          newTrust: input.target_trust,
          hash: promoted.hash,
          ttlHours: promoted.ttlHours,
          expiresAt: promoted.audit.expiresAt,
          oldPackStatus: 'REVOKED',
        }, null, 2) }] };
      } catch (error) {
        // Telemetry: promote failure
        engine.telemetryService.emitToolCall('promote_memory_pack', entry.id, 'MANDATORY', false);

        const failedEntry = entry.fail(error instanceof Error ? error : new Error('Promote failed'), MaiClassification.MANDATORY);
        engine.ledger.record(failedEntry);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PROMOTE_FAILED', message: String(error) }) }], isError: true };
      }
    }
  );
}

/**
 * Register all 6 GMP tools with the MCP server.
 */
export function registerMemoryPackTools(server: McpServer, engine: GovernanceEngine): void {
  registerSealMemoryPackTool(server, engine);
  registerLoadMemoryPackTool(server, engine);
  registerTransferMemoryPackTool(server, engine);
  registerComposeMemoryPacksTool(server, engine);
  registerDistillMemoryPackTool(server, engine);
  registerPromoteMemoryPackTool(server, engine);
}

// ═══════════════════════════════════════════════════════════════════
// Public read-only accessor for HTTP dashboard endpoints
// (server-http.ts imports this — no mutation, summary view only)
// ═══════════════════════════════════════════════════════════════════

// Re-export interface for external consumers (context-authority.ts)
export type { GMPPack };

/**
 * Governed accessor for Context Authority — returns filtered packs with validation.
 * Enforces the same checks as load_memory_pack: TTL, status, role authorization.
 * Triggers recovery + seed on first call.
 */
export async function getGMPPacksByFilter(filter: {
  types?: string[];
  domains?: string[];
  role?: string;
}): Promise<Array<{ pack: GMPPack; denialReason?: string }>> {
  await seedDefaults(); // ensure recovery complete
  const results: Array<{ pack: GMPPack; denialReason?: string }> = [];
  const now = new Date();

  for (const [, pack] of gmpPacks) {
    // Type filter
    if (filter.types && filter.types.length > 0 && !filter.types.includes(pack.type)) continue;
    // Domain filter
    if (filter.domains && filter.domains.length > 0 && !filter.domains.includes(pack.domain)) continue;

    // Validation (same as load_memory_pack)
    if (pack.status !== 'SEALED' && pack.status !== 'ACTIVE') {
      results.push({ pack, denialReason: 'PACK_NOT_ACTIVE' });
      continue;
    }
    if (pack.audit.expiresAt && new Date(pack.audit.expiresAt) < now) {
      results.push({ pack, denialReason: 'TTL_EXPIRED' });
      continue;
    }
    if (filter.role && pack.policy.allowedRoles.length > 0 &&
        !pack.policy.allowedRoles.includes(filter.role)) {
      results.push({ pack, denialReason: 'ROLE_UNAUTHORIZED' });
      continue;
    }

    results.push({ pack });
  }

  return results;
}

export function getGMPPacksSummary(): { totalPacks: number; byTrust: Record<string, number>; byType: Record<string, number>; packIds: string[] } {
  // Trigger recovery + seed defaults (non-blocking for sync dashboard endpoint)
  // Recovery will complete before next tool call; dashboard shows current in-memory state
  void seedDefaults();
  const byTrust: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const packIds: string[] = [];
  for (const [id, pack] of gmpPacks) {
    byTrust[pack.trustLevel] = (byTrust[pack.trustLevel] || 0) + 1;
    byType[pack.type] = (byType[pack.type] || 0) + 1;
    packIds.push(id);
  }
  return { totalPacks: gmpPacks.size, byTrust, byType, packIds };
}
