/**
 * @module    mcp-server-http
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — server initialization
 * @audit     true — all connections recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA MCP Server — HTTP/SSE Transport
 *
 * Enables remote clients to connect to GIA over the network.
 * Uses the MCP SDK's StreamableHTTPServerTransport for the protocol layer
 * and a lightweight Node.js HTTP server for the network layer.
 *
 * Authentication: Bearer token in Authorization header.
 * Clients receive an API key during onboarding.
 *
 * ARCHITECTURE:
 *
 *   Client (Claude Desktop / Claude Code / SDK)
 *     │
 *     │  POST https://gia.aceadvising.com/mcp
 *     │  Authorization: Bearer <api-key>
 *     ▼
 *   Nginx (TLS termination, rate limiting)
 *     │
 *     │  proxy_pass http://gia-mcp:3100/mcp
 *     ▼
 *   This Server (server-http.ts)
 *     │  1. Validate API key
 *     │  2. Create per-session transport
 *     │  3. Delegate to MCP protocol handler
 *     ▼
 *   GIA Governance Engine (24 tools)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createGIAServer, type ToolVisibility } from './server.js';
import { GIA_VERSION } from '../shared/constants.js';
import { GIA_TOOL_COUNT } from './toolClassifications.js';
import { redisSetNx, getRedis } from '../redis/client.js';
import { MaiClassification, EntryStatus, GiaLayer, type IWebAuthnProof } from '../shared/types.js';
import { ClientRegistry, type ClientProfile } from './client-registry.js';
import { authorizeGateMutation, gateAuthMode } from './gate-auth.js';
import type { GovernanceEngine } from '../core/governance.js';
import { getOrCreateTenantEngine } from './tenantEngineCache.js';
import { LedgerIntegritySentry } from '../core/sentries/ledgerIntegritySentry.js';

// Dashboard data accessors — read-only views into MCP tool stores
import { getMetricsStore, getGovernanceEventsStore, getBaselines, buildEstimationBasis } from './tools/value-metrics.js';
import { isTelemetryPersistenceEnabled } from '../core/persistence/telemetry-persistence.js';
import { getComplianceMappings } from './tools/map-compliance.js';
import { getGMPPacksSummary } from './tools/memory-packs.js';
import { getRecentPhoenixRecords } from '../core/persistence/intelligence-persistence.js';

// --- Configuration ---

const PORT = parseInt(process.env.GIA_HTTP_PORT || '3100', 10);
const HOST = process.env.GIA_HTTP_HOST || '0.0.0.0';

// --- WebAuthn Proof Token Verification ---
// Verifies HMAC-SHA256 signature, issuer, audience, expiration, gate binding, and replay.
// Returns null if verification fails for any reason.

/** Proof secret — supports distinct secret via GIA_PROOF_JWT_SECRET */
const PROOF_SECRET = process.env.GIA_PROOF_JWT_SECRET || process.env.JWT_SECRET || '';
const PROOF_SECRET_PREV = process.env.GIA_PROOF_JWT_SECRET_PREV || '';

/**
 * Fail-closed boot check: log warning if no proof secret available.
 * Without a secret, WebAuthn proof tokens cannot be verified and
 * all gate approvals will fall back to unverified dashboard-operator.
 */
if (!PROOF_SECRET) {
  console.error('[GIA-HTTP] WARNING: No JWT_SECRET or GIA_PROOF_JWT_SECRET set. WebAuthn proof token verification disabled.');
}

interface ProofTokenClaims {
  sub: string;
  sessionId: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
}

/** Parsed proof token with gate binding */
interface VerifiedProof {
  userId: string;
  credentialId: string;
  gateId?: string;
  action?: 'approve' | 'reject';
  jti: string;
  iat: number;
}

// --- JTI Replay Protection ---
// Single-use enforcement: each proof token can only be used once.
// In-memory store with automatic TTL cleanup (60s — covers 30s token + margin).

const usedJTIs = new Set<string>();
const JTI_TTL_MS = 60_000; // 60 seconds

/** Prune expired JTIs every 30 seconds */
setInterval(() => {
  // JTIs older than TTL are guaranteed expired, but since we store just the JTI
  // without timestamp, we clear the whole set periodically. With 30s token TTL
  // and 60s cleanup, worst case is a token JTI lives in memory for ~90s.
  // In-memory fallback only — Redis is the primary store when available.
  if (usedJTIs.size > 10000) usedJTIs.clear(); // Safety valve
}, 30_000).unref();

/**
 * Single-use JTI enforcement.
 * Redis preferred (survives restarts, works across instances).
 * Falls back to in-memory Set when Redis is unavailable.
 *
 * Returns true if the JTI was already used (replay detected).
 * Returns false if the JTI is fresh (first use — now marked as used).
 */
async function isJtiConsumed(jti: string, exp?: number): Promise<boolean> {
  const redisKey = `jti:${jti}`;
  // TTL: at least JTI_TTL_MS, but extend to cover the token's own expiry window.
  // Prevents replay after JTI key expires if token exp > JTI_TTL_MS.
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = exp
    ? Math.max(Math.ceil(JTI_TTL_MS / 1000), exp - now + 5)
    : Math.ceil(JTI_TTL_MS / 1000);

  // Try Redis first
  const stored = await redisSetNx(redisKey, '1', ttlSeconds);
  if (stored) {
    // SetNX succeeded = key was NEW = JTI not previously seen = NOT consumed
    return false;
  }

  // SetNX returned false — either key existed (replay) OR Redis unavailable
  const r = getRedis();
  if (r) {
    // Redis is up and key already existed — definitely a replay
    return true;
  }

  // Redis is down — fall back to in-memory Set
  if (usedJTIs.has(jti)) return true;
  usedJTIs.add(jti);
  return false;
}

/**
 * Verify a proof token and enforce single-use via JTI.
 * Supports key rotation: tries current secret, falls back to previous.
 */
async function verifyWebAuthnProofToken(token: string, expectedGateId?: string, expectedAction?: string): Promise<VerifiedProof | null> {
  if (!PROOF_SECRET) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  // Try current secret, then previous (key rotation support)
  const secrets = PROOF_SECRET_PREV ? [PROOF_SECRET, PROOF_SECRET_PREV] : [PROOF_SECRET];
  let payload: ProofTokenClaims | null = null;

  for (const secret of secrets) {
    try {
      // 1. Verify HMAC-SHA256 signature (timing-safe)
      const expectedSig = createHmac('sha256', secret)
        .update(`${parts[0]}.${parts[1]}`)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      if (expectedSig.length !== parts[2].length) continue;
      if (!timingSafeEqual(Buffer.from(expectedSig), Buffer.from(parts[2]))) continue;

      // Signature valid with this secret
      const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      break;
    } catch {
      continue;
    }
  }

  if (!payload) return null;

  try {
    // 2. Verify standard claims
    if (payload.iss !== 'gia-webauthn') return null;
    if (payload.aud !== 'gia-gate-approval') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    // 3. JTI replay protection — single-use enforcement (Redis-backed with in-memory fallback)
    if (!payload.jti) return null;
    if (await isJtiConsumed(payload.jti, payload.exp)) return null; // REPLAY DETECTED

    // 4. Parse gate binding from sessionId
    // Format: "wac:<credentialId>" or "wac:<credentialId>|<gateId>|<action>"
    const raw = payload.sessionId;
    const withoutPrefix = raw.startsWith('wac:') ? raw.slice(4) : raw;
    const bindParts = withoutPrefix.split('|');

    const credentialId = bindParts[0];
    const tokenGateId = bindParts[1] || undefined;
    const tokenAction = (bindParts[2] as 'approve' | 'reject') || undefined;

    // 5. Gate binding verification — if token is gate-bound, it must match
    if (tokenGateId && expectedGateId && tokenGateId !== expectedGateId) {
      return null; // Gate mismatch — token was issued for a different gate
    }
    if (tokenAction && expectedAction && tokenAction !== expectedAction) {
      return null; // Action mismatch — token was issued for approve but used on reject
    }

    return {
      userId: payload.sub,
      credentialId,
      gateId: tokenGateId,
      action: tokenAction,
      jti: payload.jti,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}

// --- Session Management ---

/** Active sessions mapped by session ID */
const sessions = new Map<string, {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  client: ClientProfile;
}>();

/** Clean up expired sessions (30 min idle timeout) */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      sessions.delete(id);
      console.error(`[GIA-HTTP] Session expired: ${id}`);
    }
  }
}

// Run cleanup every 5 minutes (replaced with enhanced cleanup in startHttpServer)
let cleanupInterval = setInterval(cleanExpiredSessions, 5 * 60 * 1000);
cleanupInterval.unref();

// --- HTTP Handlers ---

function sendJSON(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Send a 401 Unauthorized response with RFC 9728 WWW-Authenticate challenge.
 * The `resource_metadata` parameter tells MCP clients (Claude Desktop, etc.)
 * where to discover the authorization server protecting this resource.
 * Required by the MCP Authorization spec (2025-03-26).
 */
function send401WithChallenge(res: ServerResponse, body: Record<string, unknown>): void {
  const publicBase =
    process.env.GIA_PUBLIC_BASE_URL ||
    process.env.GIA_BASE_URL ||
    'https://gia.aceadvising.com';
  const prmUrl = `${publicBase.replace(/\/$/, '')}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer realm="gia-mcp", resource_metadata="${prmUrl}"`,
  });
  res.end(JSON.stringify(body));
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// --- Main Server ---

async function startHttpServer(): Promise<void> {
  const registry = new ClientRegistry();

  // Shared engine for dashboard REST endpoints (persists across requests)
  const { engine: dashboardEngine } = await createGIAServer();

  const ledgerSentry = new LedgerIntegritySentry(dashboardEngine);
  ledgerSentry.start();

  if (registry.size === 0) {
    console.error('[GIA-HTTP] No env-var clients registered. DB fallback enabled for marketplace keys.');
  }

  // --- Dashboard REST API helpers ---

  async function handleDashboardAPI(
    req: IncomingMessage,
    res: ServerResponse,
    engine: GovernanceEngine,
  ): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // Read-only /api/gia/* endpoints are dashboard REST — no app-layer auth
    // (access controlled by Nginx, same as /api/* to Express). State-changing
    // gate mutations (approve/reject/break-glass) additionally pass through
    // gateMutationGuard below (mandatory-gate-approval-auth-gap): monitor-first
    // rollout, hard-block via GIA_GATE_AUTH_ENFORCE=enforce.
    if (!path.startsWith('/api/gia/')) return false;

    /**
     * Guard a state-changing gate operation. Returns true when the mutation
     * may proceed. Every unauthenticated attempt is ledgered; in enforce mode
     * the caller gets a 401 and gate state is never touched.
     */
    async function gateMutationGuard(endpoint: string, gateId: string): Promise<boolean> {
      const { decision, client } = await authorizeGateMutation(req, registry);
      if (decision.outcome === 'authenticated') return true;
      recordLifecycleEvent(
        decision.allow ? 'gate-mutation-unauthenticated' : 'gate-mutation-denied',
        MaiClassification.ADVISORY,
        client?.clientId ?? 'unauthenticated',
        { gateId, endpoint, outcome: decision.outcome, mode: gateAuthMode() },
        decision.allow
          ? `Unauthenticated ${endpoint} on ${gateId} allowed in monitor mode (mandatory-gate-approval-auth-gap rollout).`
          : `Unauthenticated ${endpoint} on ${gateId} blocked (GIA_GATE_AUTH_ENFORCE=enforce).`,
        engine,
      );
      if (!decision.allow) {
        sendJSON(res, 401, {
          error: 'UNAUTHENTICATED',
          message: 'State-changing gate operations require a valid Bearer token.',
        });
      }
      return decision.allow;
    }

    // GET /api/gia/audit — forensic ledger entries for dashboard
    if (path === '/api/gia/audit' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const completed = engine.ledger.queryCompleted();
      const entries = completed.slice(-limit).reverse().map((e, i) => ({
        idx: i + 1,
        id: e.id,
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp),
        tool: e.operation,
        operation: e.operation,
        mai: e.maiLevel === MaiClassification.MANDATORY ? 'mandatory'
          : e.maiLevel === MaiClassification.ADVISORY ? 'advisory' : 'informational',
        classification: e.maiLevel || 'INFORMATIONAL',
        decision: e.status === EntryStatus.COMPLETED ? 'allow'
          : e.status === EntryStatus.ESCALATED ? 'escalate' : 'deny',
        action: e.status === EntryStatus.COMPLETED ? 'allow' : 'deny',
        domain: e.layer || 'CORE',
        context: e.layer || 'CORE',
        // Hash chain fields — real SHA-256 from forensic ledger
        hash: e.entryHash ? e.entryHash.slice(0, 16) : e.id.slice(0, 16),
        eventHash: e.entryHash ?? e.id,
        prevHash: e.previousHash ?? '',
        chainIndex: e.chainIndex ?? null,
        score: e.governanceScore?.composite || 0,
      }));
      sendJSON(res, 200, { entries, total: completed.length, chainHead: engine.ledger.chainHead, persistent: engine.ledger.persistent });
      return true;
    }

    // POST /api/gia/gates/demo — create a demo MANDATORY gate for testing passkey approval flow
    if (path === '/api/gia/gates/demo' && req.method === 'POST') {
      const operation = 'demo-veteran-claim-transfer';
      // Fire-and-forget: enforce() creates the pending gate and returns a promise that
      // resolves when the gate is approved/rejected. We don't await it here.
      engine.gate.enforce(MaiClassification.MANDATORY, operation, `demo-${Date.now()}`)
        .then(decision => console.error(`[Demo gate] Resolved: ${decision.status}`))
        .catch(err => console.error(`[Demo gate] Rejected: ${err.message}`));

      // Give the gate a moment to register
      await new Promise(r => setTimeout(r, 50));
      const pending = engine.gate.getPendingApprovals();
      const demoGate = pending.find(p => p.operation === operation);
      sendJSON(res, 201, {
        created: true,
        gateId: demoGate?.gateId ?? 'unknown',
        operation,
        classification: 'MANDATORY',
        message: 'Demo MANDATORY gate created. Approve it from the dashboard with your passkey.',
        pendingCount: pending.length,
      });
      return true;
    }

    // GET /api/gia/gates — pending MANDATORY gates with real-time SLA status
    if (path === '/api/gia/gates' && req.method === 'GET') {
      const pending = engine.gate.getPendingApprovals();
      sendJSON(res, 200, {
        gates: pending.map(p => ({
          gateId: p.gateId,
          operation: p.operation,
          classification: p.classification,
          requestedAt: p.requestedAt instanceof Date ? p.requestedAt.toISOString() : String(p.requestedAt),
          ownerRole: p.ownerRole,
          sla: p.sla,
        })),
      });
      return true;
    }

    // POST /api/gia/gates/:id/break-glass — emergency override for stuck MANDATORY gates
    // Requires: approvedBy, breakGlassSessionId, justification
    // Heavily audited — mandatory post-review.
    if (path.match(/^\/api\/gia\/gates\/gate-[^/]+\/break-glass$/) && req.method === 'POST') {
      const gateId = path.split('/')[4];
      if (!(await gateMutationGuard('break-glass', gateId))) return true;

      try {
        const bodyText = await readBody(req);
        const body = JSON.parse(bodyText);

        if (!body.approvedBy || !body.breakGlassSessionId || !body.justification) {
          sendJSON(res, 400, {
            error: 'MISSING_FIELDS',
            message: 'Break-glass requires approvedBy, breakGlassSessionId, and justification.',
          });
          return true;
        }

        const success = engine.gate.breakGlassApprove(
          gateId, body.approvedBy, body.breakGlassSessionId, body.justification
        );

        sendJSON(res, success ? 200 : 404, {
          action: 'BREAK_GLASS_OVERRIDE',
          gateId,
          success,
          breakGlassSessionId: body.breakGlassSessionId,
          message: success
            ? `Gate ${gateId} approved via break-glass override. Session: ${body.breakGlassSessionId}. Mandatory post-review required.`
            : `Gate ${gateId} not found in pending approvals.`,
        });
      } catch {
        sendJSON(res, 400, { error: 'INVALID_BODY', message: 'Invalid or missing JSON body.' });
      }
      return true;
    }

    // POST /api/gia/gates/:id/approve — approve a pending MANDATORY gate
    // Accepts optional proofToken (WebAuthn proof JWT) for cryptographic identity verification.
    // Patent Claim 7, Layer 1: Passkey-authenticated human oversight gates.
    if (path.match(/^\/api\/gia\/gates\/gate-[^/]+\/approve$/) && req.method === 'POST') {
      const gateId = path.split('/')[4];
      if (!(await gateMutationGuard('approve', gateId))) return true;

      // Parse optional request body for proofToken and rationale
      let approvedBy = 'dashboard-operator';
      let rationale = 'Approved via GIA dashboard';
      let webauthnProof: IWebAuthnProof | undefined;

      try {
        const bodyText = await readBody(req);
        if (bodyText) {
          const body = JSON.parse(bodyText);
          if (body.rationale) rationale = String(body.rationale);
          if (body.proofToken) {
            // Verify proof token with gate binding + replay protection.
            // Patent Claim 7, Layer 1: Gate-scoped, non-replayable cryptographic proof.
            const verified = await verifyWebAuthnProofToken(body.proofToken, gateId, 'approve');
            if (verified) {
              approvedBy = verified.userId;
              webauthnProof = {
                credentialId: verified.credentialId,
                userId: verified.userId,
                verifiedAt: new Date(verified.iat * 1000).toISOString(),
                signatureVerified: true,
              };
              rationale = body.rationale || `MANDATORY gate approved by ${approvedBy} with WebAuthn passkey verification.`;
            }
            // If verification fails, fall back to dashboard-operator (backward compatible)
          }
        }
      } catch {
        // No body or invalid JSON — use defaults
      }

      const success = engine.gate.approve(gateId, approvedBy, rationale, webauthnProof);
      if (!success) {
        // Distinguish between "not found" and "passkey required"
        const pending = engine.gate.getPendingApprovals().find(p => p.gateId === gateId);
        if (pending && engine.gate.requiresPasskey(pending.classification)) {
          sendJSON(res, 403, {
            action: 'REJECTED',
            gateId,
            success: false,
            error: 'PASSKEY_REQUIRED',
            message: `Gate ${gateId} requires WebAuthn passkey verification. Register a passkey and retry.`,
          });
          return true;
        }
      }
      sendJSON(res, success ? 200 : 404, {
        action: 'APPROVED',
        gateId,
        success,
        passkeyVerified: !!webauthnProof,
        approvedBy,
        message: success
          ? `Gate ${gateId} approved${webauthnProof ? ' with WebAuthn passkey verification' : ''}.`
          : `Gate ${gateId} not found in pending approvals.`,
      });
      return true;
    }

    // POST /api/gia/gates/:id/reject — reject a pending MANDATORY gate
    // Also supports WebAuthn proof for identity verification on rejections.
    if (path.match(/^\/api\/gia\/gates\/gate-[^/]+\/reject$/) && req.method === 'POST') {
      const gateId = path.split('/')[4];
      if (!(await gateMutationGuard('reject', gateId))) return true;

      // Parse optional request body for rationale + proof token
      let rejectedBy = 'dashboard-operator';
      let rationale = 'Rejected via GIA dashboard';
      let webauthnProof: IWebAuthnProof | undefined;

      try {
        const bodyText = await readBody(req);
        if (bodyText) {
          const body = JSON.parse(bodyText);
          if (body.rationale) rationale = String(body.rationale);
          if (body.proofToken) {
            const verified = await verifyWebAuthnProofToken(body.proofToken, gateId, 'reject');
            if (verified) {
              rejectedBy = verified.userId;
              webauthnProof = {
                credentialId: verified.credentialId,
                userId: verified.userId,
                verifiedAt: new Date(verified.iat * 1000).toISOString(),
                signatureVerified: true,
              };
              rationale = body.rationale || `MANDATORY gate rejected by ${rejectedBy} with WebAuthn passkey verification.`;
            }
          }
        }
      } catch { /* no body — use defaults */ }

      const success = engine.gate.reject(gateId, rejectedBy, rationale, webauthnProof);
      sendJSON(res, success ? 200 : 404, {
        action: 'REJECTED',
        gateId,
        success,
        passkeyVerified: !!webauthnProof,
        rejectedBy,
        message: success
          ? `Gate ${gateId} rejected${webauthnProof ? ' with WebAuthn passkey verification' : ''}.`
          : `Gate ${gateId} not found in pending approvals.`,
      });
      return true;
    }

    // GET /api/gia/agents — agent health status
    if (path === '/api/gia/agents' && req.method === 'GET') {
      const coreComponents = [
        { id: 'classifier', name: 'MAI Classifier' },
        { id: 'scorer', name: 'Governance Scorer' },
        { id: 'gate', name: 'Gate Enforcer' },
        { id: 'ledger', name: 'Forensic Ledger' },
        { id: 'threshold', name: 'Threshold Monitor' },
        { id: 'supervisor', name: 'Supervisor' },
        { id: 'telemetry', name: 'Telemetry Collector' },
      ];
      const supervisorStates = engine.supervisor.getAllStates();
      const agents = coreComponents.map(c => {
        const agentState = supervisorStates.get(c.id);
        return {
          id: c.id,
          name: c.name,
          state: agentState
            ? (agentState.consecutiveFailures > 0 ? 'error' : 'idle')
            : (engine.isHealthy() ? 'idle' : 'offline'),
          repairAttempts: agentState?.repairAttempts ?? 0,
          consecutiveFailures: agentState?.consecutiveFailures ?? 0,
          lastScore: agentState?.lastScore?.composite ?? null,
        };
      });
      sendJSON(res, 200, { agents });
      return true;
    }

    // GET /api/gia/score — governance IAC score
    if (path === '/api/gia/score' && req.method === 'GET') {
      const score = engine.scorer.scoreDefault('dashboard-query');
      const grade = score.composite >= 0.9 ? 'A' : score.composite >= 0.8 ? 'B' : score.composite >= 0.7 ? 'C' : 'F';
      const pass = score.composite >= 0.7;
      sendJSON(res, 200, {
        composite: score.composite,
        integrity: score.integrity,
        accuracy: score.accuracy,
        compliance: score.compliance,
        grade,
        pass,
      });
      return true;
    }

    // GET /api/gia/status — full system status
    if (path === '/api/gia/status' && req.method === 'GET') {
      const status = engine.getStatus();
      sendJSON(res, 200, {
        ...status,
        version: GIA_VERSION,
        // Catalogue size, derived from the ratified classification map. What a
        // given session can SEE is narrower — visibility is tier-gated, so a
        // client should call list_available_tools for its own effective set.
        toolCount: GIA_TOOL_COUNT,
        transport: 'streamable-http',
        activeSessions: sessions.size,
        registeredClients: registry.size,
        persistence: {
          enabled: engine.ledger.persistent,
          backend: engine.ledger.persistent ? 'postgresql' : 'in-memory',
        },
      });
      return true;
    }

    // GET /api/gia/threshold — Storey Threshold data
    if (path === '/api/gia/threshold' && req.method === 'GET') {
      const health = engine.healthAssessor.assess();
      sendJSON(res, 200, { ...health });
      return true;
    }

    // GET /api/gia/report — impact report with ESTIMATED value metrics (illustrative ROI, not measured proof)
    if (path === '/api/gia/report' && req.method === 'GET') {
      const completed = engine.ledger.queryCompleted();
      // MAI breakdown from forensic ledger (real)
      let mCount = 0, aCount = 0, iCount = 0;
      for (const e of completed) {
        if (e.maiLevel === MaiClassification.MANDATORY) mCount++;
        else if (e.maiLevel === MaiClassification.ADVISORY) aCount++;
        else iCount++;
      }
      const total = completed.length;

      // Value metrics from in-memory store — ESTIMATES, not measured proof.
      // Populated by record_value_metric (caller-supplied counts); the store is in-memory and
      // resets on process restart. Economic figures below (costAvoided) are illustrative
      // projections under the hardcoded baselines; see the `basis` block in the response (M8).
      const vmMetrics = getMetricsStore();
      const vmEvents = getGovernanceEventsStore();
      const bl = getBaselines();
      const periodDays = parseInt(url.searchParams.get('period') || '14', 10);
      const cutoff = new Date(Date.now() - periodDays * 24 * 3600000);
      const relevant = vmMetrics.filter(m => new Date(m.timestamp) >= cutoff);
      const relevantEvents = vmEvents.filter(e => new Date(e.timestamp) >= cutoff);

      // Economic impact — same computation as generate_impact_report MCP tool
      const timeSaved = relevant.reduce((sum, m) => sum + m.timeSavedMinutes, 0);
      const modelCosts = relevant.length * bl.modelCostPerRun;
      const humanCostSaved = (timeSaved / 60) * bl.humanHourlyRate;
      const costAvoided = humanCostSaved - modelCosts;
      const risksBlocked = relevant.reduce((sum, m) => sum + m.riskBlockedCount, 0) + mCount;
      const periodWeeks = Math.max(1, periodDays / 7);
      const throughputGain = Math.round(relevant.length / periodWeeks);

      const hasVmData = relevant.length > 0;

      sendJSON(res, 200, {
        metrics: {
          hoursSaved: hasVmData ? `${(timeSaved / 60).toFixed(1)}h` : '0h',
          costAvoided: hasVmData ? `$${Math.round(costAvoided).toLocaleString()}` : '$0',
          risksBlocked: String(risksBlocked),
          throughputGain: hasVmData ? `${throughputGain}/wk` : `${total}/total`,
        },
        impact: {
          totalOperations: total,
          mandatory: mCount,
          advisory: aCount,
          informational: iCount,
          thresholdPct: total > 0 ? ((mCount / total) * 100).toFixed(1) : '0',
        },
        governance: {
          unsafeActionsBlocked: relevantEvents.filter(e => e.type === 'gate_triggered').length,
          scopeDriftPrevented: relevantEvents.filter(e => e.type === 'drift_prevented').length,
          policyViolationsAvoided: relevantEvents.filter(e => e.type === 'violation_blocked').length,
          humanInterventions: relevantEvents.filter(e => e.type === 'human_intervention').length,
        },
        dataSource: hasVmData ? 'value-metrics-store' : 'ledger-only',
        periodDays,
        // M8 truth-in-labeling: economic figures above are estimates under stated constants.
        estimated: true,
        basis: buildEstimationBasis(bl, isTelemetryPersistenceEnabled()),
      });
      return true;
    }

    // GET /api/gia/ledger/verify — forensic ledger chain integrity
    // Data source: engine.ledger.verifyChain() — real SHA-256 chain walk
    if (path === '/api/gia/ledger/verify' && req.method === 'GET') {
      const result = engine.ledger.verifyChain();
      sendJSON(res, 200, {
        intact: result.valid,
        entriesVerified: result.entriesVerified,
        headHash: result.headHash,
        firstBrokenLink: result.firstBrokenLink,
        breakDetail: result.breakDetail || null,
        verifiedAt: result.verifiedAt.toISOString(),
        verificationDurationMs: result.verificationDurationMs,
      });
      return true;
    }

    // GET /api/gia/compliance?framework=X — compliance framework design mapping
    // Data source: vendored single-source table (src/compliance/complianceMappings.ts — 10 frameworks)
    if (path === '/api/gia/compliance' && req.method === 'GET') {
      const fw = url.searchParams.get('framework') || 'ALL';
      const mappings = getComplianceMappings(fw);

      // M12 honesty: this is a DESIGN MAPPING (component↔control intent), NOT measured
      // runtime enforcement or certification. `implemented` counts mapped components,
      // not evidence-bound controls (0 today — see the control-binding spec).
      const mappingDisclaimer =
        'Design mapping (component↔control intent) — not certification or measured runtime enforcement. Evidence-bound controls: 0.';
      if (fw === 'ALL') {
        // Group by framework for dashboard 4-card grid
        const grouped: Record<string, { implemented: number; total: number }> = {};
        for (const m of mappings) {
          const fwKey = String(m.framework);
          if (!grouped[fwKey]) grouped[fwKey] = { implemented: 0, total: 0 };
          grouped[fwKey].total++;
          if (m.status === 'IMPLEMENTED') grouped[fwKey].implemented++;
        }
        sendJSON(res, 200, { mappings: grouped, mappingType: 'design-mapping', evidenceBoundControls: 0, disclaimer: mappingDisclaimer });
      } else {
        const implemented = mappings.filter(m => m.status === 'IMPLEMENTED').length;
        sendJSON(res, 200, {
          framework: fw,
          mappingType: 'design-mapping',
          mapping: { implemented, total: mappings.length },
          evidenceBoundControls: 0,
          disclaimer: mappingDisclaimer,
          controls: mappings.map(m => ({
            control: m.control,
            description: m.description,
            giaComponent: m.giaComponent,
            status: m.status,
          })),
        });
      }
      return true;
    }

    // GET /api/gia/security — security posture computed from real subsystem health
    // Data source: ledger verification + telemetry + threshold + scorer — NO Math.random()
    if (path === '/api/gia/security' && req.method === 'GET') {
      const chainResult = engine.ledger.verifyChain();
      const telemetry = engine.telemetry.snapshot();
      const health = engine.healthAssessor.assess();
      const score = engine.scorer.scoreDefault('security-posture');

      // Each check traces to a real engine computation
      const checks = [
        { name: 'Ledger Integrity', pass: chainResult.valid },
        { name: 'Chain Head Present', pass: !!chainResult.headHash },
        { name: 'Threshold Healthy', pass: health.reading.isHealthy },
        { name: 'No Failed Ops', pass: telemetry.failedOperations === 0 },
        { name: 'Governance Score Pass', pass: score.composite >= 0.7 },
        { name: 'Engine Initialized', pass: engine.isHealthy() },
        { name: 'No Active Escalations', pass: telemetry.escalatedOperations === 0 },
      ];
      const passCount = checks.filter(c => c.pass).length;
      const failCount = checks.filter(c => !c.pass).length;
      const secScore = Math.round((passCount / checks.length) * 100);
      const grade = secScore >= 95 ? 'A+' : secScore >= 90 ? 'A' : secScore >= 85 ? 'B+'
        : secScore >= 80 ? 'B' : secScore >= 70 ? 'C' : 'D';

      sendJSON(res, 200, {
        score: secScore,
        grade,
        pass: passCount,
        warn: 0,
        fail: failCount,
        checks: checks.map(c => ({ name: c.name, status: c.pass ? 'PASS' : 'FAIL' })),
        source: 'computed',
      });
      return true;
    }

    // GET /api/gia/library — governance library stats + GMP inventory
    // Data source: compliance mappings count + GMP pack store
    if (path === '/api/gia/library' && req.method === 'GET') {
      const mappings = getComplianceMappings();
      const packSummary = getGMPPacksSummary();

      // Count unique control family prefixes (e.g., GOVERN, MAP, Art., AU, AC, etc.)
      const families = new Set(mappings.map(m => m.control.split(' ')[0]));

      sendJSON(res, 200, {
        policyCount: mappings.length,
        familyCount: families.size,
        controlCount: mappings.length,
        memoryPacks: packSummary,
        source: 'computed',
      });
      return true;
    }

    // GET /api/gia/ledger/verify — full chain verification with recomputation details
    if (path === '/api/gia/ledger/verify' && req.method === 'GET') {
      const result = engine.ledger.verifyChain();
      sendJSON(res, 200, {
        intact: result.valid,
        entriesVerified: result.entriesVerified,
        firstBrokenLink: result.firstBrokenLink,
        headHash: result.headHash,
        breakDetail: result.breakDetail || null,
        verifiedAt: result.verifiedAt instanceof Date ? result.verifiedAt.toISOString() : String(result.verifiedAt),
        verificationDurationMs: result.verificationDurationMs,
        persistent: engine.ledger.persistent,
      });
      return true;
    }

    // GET /api/gia/ledger/export — full ledger export as JSON for compliance evidence
    if (path === '/api/gia/ledger/export' && req.method === 'GET') {
      const format = url.searchParams.get('format') || 'json';
      const entries = engine.ledger.getChainSlice(0);
      const exportData = entries.map(e => ({
        id: e.id,
        chainIndex: e.chainIndex,
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp),
        operation: e.operation,
        layer: e.layer,
        maiLevel: e.maiLevel,
        actor: e.actor,
        status: e.status,
        duration: e.duration || null,
        governanceScore: e.governanceScore || null,
        gateDecision: e.gateDecision || null,
        metadata: e.metadata || {},
        entryHash: e.entryHash,
        previousHash: e.previousHash,
        errorCode: e.errorCode || null,
        errorMessage: e.errorMessage || null,
      }));

      if (format === 'csv') {
        const headers = 'chainIndex,id,timestamp,operation,layer,maiLevel,actor,status,duration,score,entryHash,previousHash';
        const rows = exportData.map(e =>
          `${e.chainIndex},"${e.id}","${e.timestamp}","${e.operation}","${e.layer}","${e.maiLevel}","${e.actor}","${e.status}",${e.duration || ''},${e.governanceScore?.composite?.toFixed(4) || ''},"${e.entryHash}","${e.previousHash}"`
        );
        const csv = [headers, ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="gia-forensic-ledger-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.writeHead(200);
        res.end(csv);
        return true;
      }

      sendJSON(res, 200, {
        exportedAt: new Date().toISOString(),
        totalEntries: exportData.length,
        chainHead: engine.ledger.chainHead,
        persistent: engine.ledger.persistent,
        entries: exportData,
      });
      return true;
    }

    // GET /api/gia/contexts — task context runs (active sessions + Phoenix Records)
    if (path === '/api/gia/contexts' && req.method === 'GET') {
      // Active MCP sessions
      const activeSessions = Array.from(sessions.entries()).map(([id, s]) => ({
        id,
        runId: id.slice(0, 8),
        pipeline: `${s.client.domain} session`,
        stages: '—',
        entries: engine.ledger.size,
        size: `${engine.ledger.size} entries`,
        status: 'active',
        ttl: `${Math.round((SESSION_TIMEOUT_MS - (Date.now() - s.createdAt)) / 60000)}m`,
        chain: 'linked',
        finalized: false,
        createdAt: new Date(s.createdAt).toISOString(),
      }));

      // Phoenix Records — persisted run journal from PostgreSQL
      let phoenixContexts: any[] = [];
      try {
        const records = await getRecentPhoenixRecords(50);
        phoenixContexts = records.map(r => ({
          id: r.runId,
          runId: r.runId.slice(0, 8),
          pipeline: r.workforceType || 'agent run',
          stages: r.agentSequence.length > 0 ? r.agentSequence.join(' → ') : '—',
          entries: r.gatePatterns.length + r.effectiveDirectives.length,
          size: `${r.agentSequence.length} agents`,
          status: r.finalStatus || 'closed',
          ttl: '—',
          chain: r.gatePatterns.length > 0 ? 'sealed' : 'linked',
          finalized: !!r.completedAt,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
          caseId: r.caseId,
          tokenEfficiency: r.tokenEfficiency,
          humanCorrections: r.humanCorrections.length,
        }));
      } catch {
        // graceful degradation — DB may be unavailable
      }

      const contexts = [...activeSessions, ...phoenixContexts];
      sendJSON(res, 200, { contexts });
      return true;
    }

    return false;
  }

  // --- Persistent MCP Session ---
  // OpenAI Agent Builder requires a session-based MCP transport that persists
  // across GET (SSE) and POST (JSON-RPC) requests. The SDK's stateless mode
  // rejects GET requests, and Agent Builder won't proceed without an SSE stream.
  //
  // Architecture: One persistent server+transport per client API key.
  // For clients that don't send the Mcp-Session-Id header (Agent Builder),
  // we inject it automatically so the SDK's session validation passes.

  /** Active persistent MCP session (created on first `initialize` POST) */
  /**
   * Write a lifecycle event to the forensic ledger.
   * Fire-and-forget — never blocks the transport.
   */
  function recordLifecycleEvent(
    operation: string,
    mai: MaiClassification,
    actor: string,
    metadata: Record<string, unknown>,
    rationale: string,
    engineRef: GovernanceEngine | null,
  ): void {
    if (!engineRef) return;
    try {
      const entry = engineRef.ledger.begin(operation, mai, GiaLayer.MCP, actor);
      for (const [k, v] of Object.entries(metadata)) entry.addMetadata(k, v);
      const score = engineRef.scorer.scoreDefault(operation);
      const completed = entry.complete(score, {
        classification: mai,
        confidence: 1.0,
        rationale,
        requiresGate: false,
      });
      engineRef.ledger.record(completed);
    } catch (err) {
      console.error(`[GIA-HTTP] Lifecycle ledger write failed for ${operation}:`, err);
    }
  }

  // --- Per-Tenant Session Map (tenant tier — /mcp) ---
  // Each tenantId gets its own McpServer + GovernanceEngine so audit ledgers,
  // gate state, and memory packs are fully isolated between clients.
  interface TenantSession {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
    sessionId: string;
    createdAt: number;
    engine: GovernanceEngine;
  }

  const tenantSessions = new Map<string, TenantSession>();

  /**
   * In-progress tenant session creation promises.
   * Prevents thundering-herd: when 5 managed agents connect simultaneously,
   * only ONE createGIAServer() call is made; the others wait on the same promise
   * rather than each triggering a full ForensicLedger recovery (16k+ entries).
   */
  const tenantSessionCreating = new Map<string, Promise<TenantSession>>();

  // --- Per-Session Agent Map (public tier — /mcp/agent) ---
  // Slim endpoint for managed agent worker runs: 6 public governance tools only
  // (~3K vs ~20K schema tokens per call). Each worker connection gets its OWN
  // session + transport (keyed by sessionId), so concurrent workers never collide
  // on a shared transport. The expensive GovernanceEngine (full ForensicLedger
  // recovery) is built ONCE per tenant and shared across that tenant's sessions.
  interface AgentSession {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
    sessionId: string;
    tenantId: string;
    createdAt: number;
    lastUsedAt: number;
    engine: GovernanceEngine;
  }

  // Keyed by sessionId (NOT tenantId) — one live entry per worker connection.
  const agentSessions = new Map<string, AgentSession>();

  // Shared per-tenant engine — see tenantEngineCache.ts for the full
  // rationale. ONE GovernanceEngine per tenant, shared by BOTH the agent tier
  // (/mcp/agent, below) and the tenant tier (/mcp, see getOrCreateTenantSession
  // further down). Previously each tier kept its OWN per-tenant engine cache
  // (agentEngines / tenantEngines) — so a single tenant touching both tiers
  // paid the ForensicLedger recovery TWICE (216-248MiB of a 256MiB cap,
  // observed on prod 2026-07-29). `getOrCreateTenantEngine` coalesces
  // simultaneous callers (any tier, any session) onto a single construction.
  //
  // ROOT CAUSE FIX (2026-07-17 live incident, preserved here): before a
  // shared cache existed, `getOrCreateTenantSession()` called
  // `createGIAServer('tenant')` with NO existingEngine every time it rebuilt a
  // session, and `transport.onclose` deleted the tenant's ENTIRE session
  // (server+transport+engine) on every disconnect. Any client that reconnects
  // per call or per workflow run (OpenAI Agent Builder does — see the reinit
  // comment above) therefore forced a brand-new GovernanceEngine — full
  // ForensicLedger recovery plus a fresh, empty in-memory pendingApprovals Map
  // — on every single reconnect. Observed live: 140 fresh engine
  // constructions in one 22-minute window (vs. zero in an idle baseline), and
  // one of those fresh engines' cleanupStaleGates() sweep reaped a customer's
  // live MANDATORY gate ~2 minutes after it was requested, before any human
  // could approve it (see gate-persistence.ts's process-lifetime guard for
  // the other half of this fix). The engine must survive session/transport
  // churn — only the lightweight session wrapper is per-connection, and
  // `tenantEngineCache.ts` exposes no per-session eviction hook at all.
  //
  // The factory always builds via `createGIAServer('tenant')` regardless of
  // which tier triggers construction first: `maxVisibility` only shapes tool
  // registration on the (discarded) server returned here, never the engine —
  // so the one startup ledger entry records the broader tier rather than
  // implying worker-only scope.
  function sharedTenantEngine(tenantId: string): Promise<GovernanceEngine> {
    return getOrCreateTenantEngine(tenantId, () =>
      createGIAServer('tenant').then(({ engine }) => engine),
    );
  }

  // Create a fresh, isolated session for one worker connection (called per
  // `initialize`). Reuses the tenant's shared engine to avoid re-recovering the
  // ledger; only the lightweight McpServer + transport are per-session.
  async function createAgentSession(tenantId: string): Promise<AgentSession> {
    const engine = await sharedTenantEngine(tenantId);
    const agentSessionId = randomUUID();
    const { server } = await createGIAServer('public', engine);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => agentSessionId,
    });

    transport.onclose = () => {
      console.error(`[GIA-AGENT] Agent session closed: ${tenantId} / ${agentSessionId.slice(0, 8)}`);
      agentSessions.delete(agentSessionId);
    };

    await server.connect(transport);

    // Force initialization state (same pattern as tenant sessions) — we return a
    // synthetic OK for `initialize` rather than letting the SDK handle it.
    const webTransport = (transport as any)._webStandardTransport;
    if (webTransport && typeof webTransport._initialized !== 'undefined') {
      webTransport._initialized = true;
      webTransport.sessionId = agentSessionId;
    }

    const now = Date.now();
    const session: AgentSession = {
      server, transport, sessionId: agentSessionId, tenantId,
      createdAt: now, lastUsedAt: now, engine,
    };
    agentSessions.set(agentSessionId, session);
    console.error(`[GIA-AGENT] Agent session created: ${tenantId} / ${agentSessionId.slice(0, 8)} (public tier)`);
    return session;
  }

  // Idle reaper — evict worker sessions idle beyond the TTL so short-lived runs
  // don't accumulate. Managed agent workers are minutes-long; 10 min is safe.
  const AGENT_SESSION_IDLE_MS = 10 * 60 * 1000;
  const agentReaper = setInterval(() => {
    const cutoff = Date.now() - AGENT_SESSION_IDLE_MS;
    for (const [sid, sess] of agentSessions) {
      if (sess.lastUsedAt < cutoff) {
        try { sess.transport.close(); } catch { /* no-op */ }
        agentSessions.delete(sid);
        console.error(`[GIA-AGENT] Reaped idle agent session: ${sess.tenantId} / ${sid.slice(0, 8)}`);
      }
    }
  }, 60 * 1000);
  if (typeof (agentReaper as { unref?: () => void }).unref === 'function') {
    (agentReaper as { unref?: () => void }).unref!();
  }

  // Dedup map for mcp-reinitialize ledger noise. OpenAI Agent Builder
  // reinits per workflow run; without this, the ledger fills with redundant
  // INFORMATIONAL entries. We log at most once per client per window.
  const reinitDedup = new Map<string, number>();
  const REINIT_DEDUP_WINDOW_MS = 60_000;

  async function getOrCreateTenantSession(tenantId: string): Promise<TenantSession> {
    // Reuse existing session for this tenant if alive
    const existing = tenantSessions.get(tenantId);
    if (existing) return existing;

    // Coalesce concurrent creation requests — prevents multiple simultaneous
    // createGIAServer() calls when managed agents (orchestrator + workers) all
    // connect at the same time after a container restart.
    const inProgress = tenantSessionCreating.get(tenantId);
    if (inProgress) return inProgress;

    const creationPromise = (async () => {
      const fixedSessionId = randomUUID();
      // HTTP transport: TENANT tier — authenticated external clients get data-bearing tools.
      // Auth check happens before getOrCreateTenantSession() is called, so all callers
      // have a valid API key. Operator tools (approve_gate, srt, remediation) remain excluded.
      // Engine is the shared per-tenant instance (see sharedTenantEngine
      // above) — reused across every reconnect and across both tiers, not
      // rebuilt per session.
      const engine = await sharedTenantEngine(tenantId);
      const { server } = await createGIAServer('tenant', engine);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => fixedSessionId,
      });

      transport.onclose = () => {
        const sess = tenantSessions.get(tenantId);
        const durationMs = sess ? Date.now() - sess.createdAt : 0;
        recordLifecycleEvent('mcp-session-close', MaiClassification.ADVISORY, 'SYSTEM', {
          sessionId: fixedSessionId,
          tenantId,
          transport: 'streamable-http',
          durationMs,
        }, `MCP HTTP session closed after ${Math.round(durationMs / 1000)}s.`, engine);
        console.error(`[GIA-HTTP] Tenant session closed: ${tenantId} / ${fixedSessionId.slice(0, 8)}`);
        tenantSessions.delete(tenantId);
      };

      await server.connect(transport);

      // CRITICAL: Force the underlying web standard transport to think it's initialized.
      // OpenAI Agent Builder sends GET (SSE stream) BEFORE POST (initialize).
      // The SDK's validateSession() rejects GET when _initialized is false (400 "Server not initialized").
      // Since we've already called server.connect(transport), the MCP protocol is ready —
      // we just need to bypass the SDK's initialization gate for GET requests.
      const webTransport = (transport as any)._webStandardTransport;
      if (webTransport && typeof webTransport._initialized !== 'undefined') {
        webTransport._initialized = true;
        webTransport.sessionId = fixedSessionId;
        console.error(`[GIA-HTTP] Forced _initialized=true + sessionId on web standard transport`);
      }

      const session: TenantSession = {
        server,
        transport,
        sessionId: fixedSessionId,
        createdAt: Date.now(),
        engine,
      };
      tenantSessions.set(tenantId, session);

      // --- Lifecycle: Session Init ---
      recordLifecycleEvent('mcp-session-init', MaiClassification.ADVISORY, 'SYSTEM', {
        sessionId: fixedSessionId,
        tenantId,
        transport: 'streamable-http',
        tier: 'tenant',
        toolVisibility: 'tenant',
        version: GIA_VERSION,
      }, `MCP HTTP session created for tenant ${tenantId}. Transport: Streamable HTTP, Tier: tenant.`, engine);

      console.error(`[GIA-HTTP] Tenant session created: ${tenantId} / ${fixedSessionId.slice(0, 8)}`);
      return session;
    })();

    tenantSessionCreating.set(tenantId, creationPromise);
    // Clean up in-progress entry on completion (success or failure)
    creationPromise.finally(() => tenantSessionCreating.delete(tenantId));
    return creationPromise;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check (unauthenticated)
    if (req.url === '/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        status: 'healthy',
        version: GIA_VERSION,
        transport: 'streamable-http',
        toolCount: GIA_TOOL_COUNT,
        activeSessions: sessions.size,
        registeredClients: registry.size,
        activeTenantSessions: tenantSessions.size,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // --- Dashboard REST API (unauthenticated — Nginx controls access) ---
    if (await handleDashboardAPI(req, res, dashboardEngine)) return;

    // Admin: list clients (requires admin key)
    if (req.url === '/admin/clients' && req.method === 'GET') {
      const token = extractBearerToken(req);
      const client = token ? await registry.authenticateAsync(token) : null;
      if (!client || client.tier !== 'enterprise') {
        sendJSON(res, 403, { error: 'Admin access requires enterprise tier.' });
        return;
      }
      sendJSON(res, 200, { clients: registry.listClients() });
      return;
    }

    // Audit export endpoint (authenticated)
    if (req.url?.startsWith('/audit/export') && req.method === 'GET') {
      const token = extractBearerToken(req);
      const client = token ? await registry.authenticateAsync(token) : null;
      if (!client) {
        sendJSON(res, 401, { error: 'Unauthorized.' });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const format = url.searchParams.get('format') || 'json';
      const period = parseInt(url.searchParams.get('period') || '30', 10);

      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - period);
      const filtered = dashboardEngine.ledger.queryByTimeRange(start, end);

      if (format === 'csv') {
        const header = 'id,operation,classification,layer,score,timestamp,entryHash,previousHash,chainIndex\n';
        const rows = filtered.map(e =>
          `${e.id},${e.operation},${e.maiLevel || ''},${e.layer || ''},${e.governanceScore?.composite || ''},${e.timestamp.toISOString()},${e.entryHash ?? ''},${e.previousHash ?? ''},${e.chainIndex ?? ''}`
        ).join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="gia-audit-${client.clientId}-${period}d.csv"`,
        });
        res.end(header + rows);
      } else {
        sendJSON(res, 200, {
          client: client.clientId,
          period: `${period} days`,
          count: filtered.length,
          entries: filtered,
        });
      }
      return;
    }

    // --- Well-known server card for Smithery auto-discovery ---
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // --- RFC 9728 Protected Resource Metadata (MCP Authorization 2025-03-26) ---
    // Tells MCP clients (Claude Desktop, etc.) which authorization server
    // protects this resource so they can begin the OAuth flow.
    if (parsedUrl.pathname === '/.well-known/oauth-protected-resource') {
      const publicBase =
        process.env.GIA_PUBLIC_BASE_URL ||
        process.env.GIA_BASE_URL ||
        'https://gia.aceadvising.com';
      const base = publicBase.replace(/\/$/, '');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(JSON.stringify({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:all', 'governance:read', 'governance:write'],
        resource_documentation: `${base}/docs`,
        resource_name: 'GIA Governance MCP',
      }));
      return;
    }

    if (parsedUrl.pathname === '/.well-known/mcp/server-card.json') {
      sendJSON(res, 200, {
        serverInfo: { name: 'gia-governance', version: GIA_VERSION },
        capabilities: { tools: {} },
        authentication: {
          required: true,
          schemes: [
            { type: 'header', name: 'Authorization', description: 'Bearer <GIA_API_KEY>' },
            { type: 'query', name: 'GIA_API_KEY', description: 'GIA API key (query param)' }
          ]
        }
      });
      return;
    }

    // --- Slim MCP endpoint: /mcp/agent (public tier — worker runs) ---
    // 6 governance tools vs 30+ on /mcp. Reduces per-call schema overhead ~80%.
    // Same auth flow as /mcp; uses per-tenant agent sessions at 'public' visibility.
    if (parsedUrl.pathname === '/mcp/agent') {
      const token = extractBearerToken(req) || parsedUrl.searchParams.get('GIA_API_KEY');
      if (!token) {
        send401WithChallenge(res, { error: 'Unauthorized. Provide Bearer token or GIA_API_KEY query parameter.' });
        return;
      }

      const agentClient = await registry.authenticateAsync(token);
      if (!agentClient) {
        send401WithChallenge(res, { error: 'Unauthorized. Invalid or revoked API key.' });
        return;
      }

      const agentRateCheck = registry.checkRateLimit(agentClient.clientId);
      if (!agentRateCheck.allowed) {
        sendJSON(res, 429, { error: agentRateCheck.reason });
        return;
      }
      registry.recordRequest(agentClient.clientId);

      // Resolve an existing per-worker session by the client-supplied session id,
      // enforcing tenant ownership — a session id belonging to another tenant is
      // rejected, so a stolen/guessed id cannot cross the tenant boundary.
      const lookupAgentSession = (): AgentSession | null => {
        const sid = (req.headers['mcp-session-id'] as string | undefined) || '';
        if (!sid) return null;
        const sess = agentSessions.get(sid);
        if (!sess) return null;
        if (sess.tenantId !== agentClient.tenantId) {
          console.error(`[GIA-AGENT] Session tenant mismatch on ${sid.slice(0, 8)} — denied`);
          return null;
        }
        sess.lastUsedAt = Date.now();
        return sess;
      };

      try {
        if (req.method === 'POST') {
          const bodyText = await readBody(req);
          const body = JSON.parse(bodyText);
          console.error(`[GIA-AGENT] POST method=${body.method || '?'} tenant=${agentClient.tenantId}`);

          // `initialize` opens a NEW isolated session for this worker connection,
          // so concurrent workers each get their own transport and never collide.
          // The session is force-initialized at creation, so we return a synthetic
          // OK carrying the new session id (exactly as /mcp does) rather than
          // forwarding to the transport, which would 400 "already initialized".
          if (body.method === 'initialize') {
            const session = await createAgentSession(agentClient.tenantId);
            console.error(`[GIA-AGENT] initialize → new session ${session.sessionId.slice(0, 8)} (tenant=${agentClient.tenantId})`);
            const initResponse = {
              jsonrpc: '2.0' as const,
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'gia-governance', version: GIA_VERSION },
              },
            };
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': session.sessionId,
            });
            res.end(JSON.stringify(initResponse));
            return;
          }

          // Every other method routes to THIS worker's own session via its id.
          const session = lookupAgentSession();
          if (!session) {
            sendJSON(res, 404, {
              jsonrpc: '2.0',
              id: body.id ?? null,
              error: { code: -32001, message: 'Session not found. Re-initialize.' },
            });
            return;
          }
          await session.transport.handleRequest(req as any, res as any, body);
        } else if (req.method === 'GET' || req.method === 'DELETE') {
          const session = lookupAgentSession();
          if (!session) {
            sendJSON(res, 404, { error: 'Session not found. Re-initialize.' });
            return;
          }
          await session.transport.handleRequest(req as any, res as any);
          if (req.method === 'DELETE') agentSessions.delete(session.sessionId);
        } else {
          sendJSON(res, 405, { error: 'Method not allowed' });
        }
      } catch (err) {
        console.error('[GIA-AGENT] Error handling /mcp/agent request:', err);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    // --- MCP endpoint: /mcp ---
    if (parsedUrl.pathname !== '/mcp') {
      sendJSON(res, 404, { error: 'Not found. MCP endpoint is POST /mcp' });
      return;
    }

    // Authenticate via client registry
    // Support both Bearer token (standard) and query parameter (Smithery gateway)
    const token = extractBearerToken(req) || parsedUrl.searchParams.get('GIA_API_KEY');
    if (!token) {
      send401WithChallenge(res, { error: 'Unauthorized. Provide Bearer token or GIA_API_KEY query parameter.' });
      return;
    }

    const client = await registry.authenticateAsync(token);
    if (!client) {
      // --- Lifecycle: Auth Failure ---
      recordLifecycleEvent('mcp-auth-failure', MaiClassification.ADVISORY, 'UNAUTHENTICATED', {
        transport: 'streamable-http',
        tokenProvided: true,
        reason: 'Invalid or revoked API key',
      }, 'MCP authentication failed — invalid or revoked API key.', null);
      send401WithChallenge(res, { error: 'Unauthorized. Invalid or revoked API key.' });
      return;
    }

    // Rate limit check
    const rateCheck = registry.checkRateLimit(client.clientId);
    if (!rateCheck.allowed) {
      sendJSON(res, 429, { error: rateCheck.reason });
      return;
    }

    // Record the request
    registry.recordRequest(client.clientId);

    try {
      // Get or create the per-tenant session-based transport.
      // Each tenantId gets its own isolated McpServer + GovernanceEngine.
      // This ensures GET (SSE) and POST (JSON-RPC) share the same session within a tenant.
      const session = await getOrCreateTenantSession(client.tenantId);

      // ALWAYS override the session ID header with this tenant's session ID.
      // OpenAI Agent Builder caches the session ID from setup and sends the OLD
      // one during workflow execution. If we re-initialized (new session ID),
      // the stale header causes SDK session validation to fail (400/404).
      // By always injecting the current session ID, all requests match.
      req.headers['mcp-session-id'] = session.sessionId;

      if (req.method === 'POST') {
        const bodyText = await readBody(req);
        const body = JSON.parse(bodyText);
        console.error(`[GIA-HTTP] POST method=${body.method || '?'} tenant=${client.tenantId} session=${session.sessionId.slice(0, 8)}`);

        // Handle `initialize` on an already-initialized session.
        // The MCP SDK rejects re-initialization with 400 "Server already initialized".
        // OpenAI Agent Builder sends `initialize` at the start of each workflow run,
        // even though the session is already initialized from the setup phase.
        // We return a synthetic success response to keep the existing session alive.
        if (body.method === 'initialize' && tenantSessions.has(client.tenantId)) {
          // --- Lifecycle: Re-initialization Detected ---
          // Dedup: OpenAI Agent Builder reinits per workflow run (can be 100s/hour).
          // Only ledger-log if the same clientId hasn't reinitialized in the last 60s.
          const lastReinitAt = reinitDedup.get(client.clientId) || 0;
          const now = Date.now();
          if (now - lastReinitAt > REINIT_DEDUP_WINDOW_MS) {
            reinitDedup.set(client.clientId, now);
            recordLifecycleEvent('mcp-reinitialize', MaiClassification.INFORMATIONAL, client.clientId, {
              sessionId: session.sessionId,
              clientId: client.clientId,
              tenantId: client.tenantId,
              transport: 'streamable-http',
              note: 'Re-initialization on already-initialized session — synthetic OK returned',
            }, `MCP re-initialize detected from ${client.clientId} on existing session. Returned synthetic OK.`, session.engine);
          }
          console.error(`[GIA-HTTP] Re-initialize on existing session — returning synthetic OK`);
          const initResponse = {
            jsonrpc: '2.0' as const,
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'gia-governance',
                version: GIA_VERSION,
              },
            },
          };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': session.sessionId,
          });
          res.end(JSON.stringify(initResponse));
        } else {
          await session.transport.handleRequest(req, res, body);
        }
      } else if (req.method === 'GET') {
        console.error(`[GIA-HTTP] GET request — opening SSE stream on tenant=${client.tenantId} session=${session.sessionId.slice(0, 8)}`);
        // Close any existing standalone SSE stream first (prevents 409 Conflict).
        // Agent Builder may open a new GET SSE on each workflow run while the old one lingers.
        try { session.transport.closeStandaloneSSEStream(); } catch { /* no-op if none open */ }
        await session.transport.handleRequest(req, res);
      } else if (req.method === 'DELETE') {
        console.error(`[GIA-HTTP] DELETE request — tenant=${client.tenantId} session=${session.sessionId.slice(0, 8)}`);
        await session.transport.handleRequest(req, res);
        tenantSessions.delete(client.tenantId);
      } else {
        sendJSON(res, 405, { error: 'Method not allowed.' });
      }
    } catch (err: any) {
      console.error('[GIA-HTTP] Request error:', err.message);
      // If the tenant session is stale/broken, evict it so the next request gets a fresh one
      if (err.message?.includes('Stateless transport') || err.message?.includes('already been used')) {
        const brokenSession = tenantSessions.get(client.tenantId);
        // --- Lifecycle: Session Integrity Violation ---
        recordLifecycleEvent('mcp-session-integrity', MaiClassification.ADVISORY, client?.clientId || 'UNKNOWN', {
          transport: 'streamable-http',
          errorMessage: err.message,
          tenantId: client.tenantId,
          sessionId: brokenSession?.sessionId,
          action: 'session-evict',
        }, `MCP session integrity violation: ${err.message}. Tenant session evicted.`, brokenSession?.engine ?? null);
        console.error(`[GIA-HTTP] Evicting broken tenant session: ${client.tenantId}`);
        tenantSessions.delete(client.tenantId);
      }
      if (!res.headersSent) {
        sendJSON(res, 500, { error: 'Internal server error.' });
      }
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`[GIA-HTTP] Governed Intelligence Architecture MCP Server v${GIA_VERSION}`);
    console.error(`[GIA-HTTP] Author: William J. Storey III`);
    console.error(`[GIA-HTTP] Transport: Streamable HTTP`);
    console.error(`[GIA-HTTP] Listening: http://${HOST}:${PORT}/mcp`);
    console.error(`[GIA-HTTP] Health:    http://${HOST}:${PORT}/health`);
    console.error(`[GIA-HTTP] Audit:     http://${HOST}:${PORT}/audit/export`);
    console.error(`[GIA-HTTP] Dashboard: http://${HOST}:${PORT}/api/gia/*`);
    console.error(`[GIA-HTTP] Clients:   ${registry.size} registered`);

    // Note: per-tenant sessions are created on first connect per tenantId.
    // There is no single pre-warm target; each tenant's engine initializes on their first request.
    console.error('[GIA-HTTP] Per-tenant session isolation enabled — sessions created on first connect per tenant.');
  });

  // Session cleanup on expired sessions also closes registry tracking
  const enhancedClean = () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        registry.sessionClosed(session.client.clientId);
        sessions.delete(id);
        console.error(`[GIA-HTTP] Session expired: ${id} (client: ${session.client.clientId})`);
      }
    }
  };

  // Replace the interval with enhanced cleanup
  clearInterval(cleanupInterval);
  setInterval(enhancedClean, 5 * 60 * 1000).unref();

  // Graceful shutdown — close persistence pools before exit
  const shutdown = async () => {
    console.error('[GIA-HTTP] Shutting down...');
    ledgerSentry.stop();
    sessions.clear();
    try {
      await dashboardEngine.shutdown();
    } catch (err) {
      console.error('[GIA-HTTP] Persistence shutdown error:', (err as Error).message);
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startHttpServer().catch((error) => {
  console.error('[GIA-HTTP] FATAL: Server startup failed:', error);
  process.exit(1);
});
