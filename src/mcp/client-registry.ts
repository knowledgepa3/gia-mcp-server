/**
 * @module    client-registry
 * @layer     TRANSPORT
 * @mai       ADVISORY — client management, no direct governance decisions
 * @audit     true — all auth events recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * Client Registry for GIA MCP Server
 *
 * Maps API keys to client profiles with:
 * - Client identity (id, name, contact)
 * - Domain scoping (which verticals they can access)
 * - Rate limits (requests/min, tool calls/day)
 * - Cost budgets (max monthly spend)
 * - Tier assignment (starter, professional, enterprise)
 * - Revocation support
 *
 * Data sources (checked in order):
 * 1. GIA_CLIENT_REGISTRY env var (JSON) — manual/admin keys
 * 2. GIA_API_KEYS env var (legacy flat keys)
 * 3. PostgreSQL gia_api_keys table — marketplace self-service keys (hash-based)
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

// --- Types ---

export type ClientTier = 'starter' | 'professional' | 'enterprise';

export interface ClientProfile {
  clientId: string;
  clientName: string;
  apiKey: string;       // For env-based clients: the raw key. For DB clients: empty (hash-only).
  domain: string;
  tier: ClientTier;
  contactEmail: string;
  createdAt: string;
  revokedAt?: string;
  /** Tenant this client belongs to — used for per-tenant session isolation */
  tenantId: string;
  /** GIA user ID (set for OAuth JWT clients) */
  userId?: string;

  /** Rate limits */
  limits: {
    requestsPerMinute: number;
    toolCallsPerDay: number;
    maxMonthlyCostUsd: number;
    maxConcurrentSessions: number;
  };

  /** Which tool prefixes this client can access (empty = all) */
  allowedToolPrefixes: string[];
}

// ─── OAuth JWT Verification ───────────────────────────────────────────────────
// Verifies tokens issued by oauth.ts (iss: gia-oauth, aud: gia-mcp).
// Uses the same JWT_SECRET as the Express server — shared secret, no network hop.

interface OAuthJwtPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  tenantId?: string;
  role?: string;
}

function verifyOAuthJwt(token: string): OAuthJwtPayload | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    // Verify HMAC-SHA256 signature
    const sig = createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const incoming = parts[2].replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig.length !== incoming.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(incoming))) return null;

    const padded  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as OAuthJwtPayload;

    // Validate claims
    if (payload.iss !== 'gia-oauth') return null;
    if (payload.aud !== 'gia-mcp') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub || !payload.tenantId) return null;

    return payload;
  } catch {
    return null;
  }
}

// --- DB Connection (lightweight, PostgreSQL only) ---

let dbPool: any = null;

async function getDbPool(): Promise<any> {
  if (dbPool) return dbPool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const { Pool } = await import('pg');
    dbPool = new Pool({
      connectionString: dbUrl,
      max: 3,            // Minimal pool — MCP server is lightweight
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Test connection
    await dbPool.query('SELECT 1');
    console.error('[GIA-Registry] PostgreSQL connected for marketplace key validation');
    return dbPool;
  } catch (err) {
    console.error('[GIA-Registry] PostgreSQL connection failed (DB fallback disabled):', err);
    dbPool = null;
    return null;
  }
}

// --- DB Auth Cache (5-minute positive, 30-second negative) ---

interface CachedAuth {
  profile: ClientProfile | null;
  expiresAt: number;
}

const dbAuthCache = new Map<string, CachedAuth>();

function getCachedDbAuth(keyHash: string): CachedAuth | null {
  const cached = dbAuthCache.get(keyHash);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    dbAuthCache.delete(keyHash);
    return null;
  }
  return cached;
}

function cacheDbAuth(keyHash: string, profile: ClientProfile | null): void {
  const ttl = profile ? 60 * 1000 : 30 * 1000; // 1min positive, 30s negative — revoked keys invalidate faster
  dbAuthCache.set(keyHash, { profile, expiresAt: Date.now() + ttl });
}

/** Tier defaults — applied when client doesn't specify custom limits */
const TIER_DEFAULTS: Record<ClientTier, ClientProfile['limits']> = {
  starter: {
    requestsPerMinute: 30,
    toolCallsPerDay: 500,
    maxMonthlyCostUsd: 100,
    maxConcurrentSessions: 2,
  },
  professional: {
    requestsPerMinute: 120,
    toolCallsPerDay: 5000,
    maxMonthlyCostUsd: 1000,
    maxConcurrentSessions: 10,
  },
  enterprise: {
    requestsPerMinute: 600,
    toolCallsPerDay: 50000,
    maxMonthlyCostUsd: 10000,
    maxConcurrentSessions: 50,
  },
};

// --- Rate Tracking ---

interface RateWindow {
  count: number;
  windowStart: number;
}

interface DailyUsage {
  toolCalls: number;
  date: string; // YYYY-MM-DD
}

/** Per-client rate state (in-memory, resets on restart) */
const rateLimitState = new Map<string, {
  minuteWindow: RateWindow;
  dailyUsage: DailyUsage;
  activeSessions: number;
}>();

function getOrCreateRateState(clientId: string) {
  if (!rateLimitState.has(clientId)) {
    const today = new Date().toISOString().split('T')[0];
    rateLimitState.set(clientId, {
      minuteWindow: { count: 0, windowStart: Date.now() },
      dailyUsage: { toolCalls: 0, date: today },
      activeSessions: 0,
    });
  }
  return rateLimitState.get(clientId)!;
}

// --- Client Registry ---

export class ClientRegistry {
  private clients = new Map<string, ClientProfile>(); // apiKey → profile
  private clientsById = new Map<string, ClientProfile>(); // clientId → profile
  private revokedKeys = new Set<string>();

  constructor() {
    this.loadFromEnv();
  }

  /**
   * Load client registry from environment.
   *
   * Supports two formats:
   * 1. Legacy: GIA_API_KEYS=key1,key2 (flat keys, no metadata)
   * 2. Full:   GIA_CLIENT_REGISTRY=[{...}, {...}] (JSON array of ClientProfile)
   */
  private loadFromEnv(): void {
    // Try full registry first
    const registryJson = process.env.GIA_CLIENT_REGISTRY;
    if (registryJson) {
      try {
        const profiles: ClientProfile[] = JSON.parse(registryJson);
        for (const profile of profiles) {
          if (profile.revokedAt) {
            this.revokedKeys.add(profile.apiKey);
          } else {
            this.clients.set(profile.apiKey, profile);
            this.clientsById.set(profile.clientId, profile);
          }
        }
        console.error(`[GIA-Registry] Loaded ${this.clients.size} clients from GIA_CLIENT_REGISTRY`);
        return;
      } catch (err) {
        console.error('[GIA-Registry] Failed to parse GIA_CLIENT_REGISTRY:', err);
      }
    }

    // Fall back to legacy flat keys.
    // These are first-party, env-provisioned PLATFORM keys (GIA_API_KEYS) — not
    // self-serve customer keys (those come from the DB path above). The managed
    // agent runtime authenticates with one of these to call its own governance
    // MCP, and an orchestrator fan-out makes many calls per minute across many
    // concurrent worker sessions on a SINGLE shared key. The starter tier
    // (30 req/min, 2 concurrent sessions) throttled that — blocking the fan-out.
    // First-party platform keys therefore get the enterprise tier
    // (600 req/min, 50 concurrent sessions). The app-layer per-key limit remains
    // the real governor; this just sizes it for legitimate platform fan-out.
    const legacyKeys = process.env.GIA_API_KEYS || '';
    const keys = legacyKeys.split(',').map(k => k.trim()).filter(Boolean);
    for (const key of keys) {
      const profile: ClientProfile = {
        clientId: `legacy-${key.slice(0, 8)}`,
        clientName: `Platform Client (${key.slice(0, 8)}...)`,
        apiKey: key,
        domain: 'general',
        tier: 'enterprise',
        contactEmail: '',
        tenantId: 'default',
        createdAt: new Date().toISOString(),
        limits: { ...TIER_DEFAULTS.enterprise },
        allowedToolPrefixes: [],
      };
      this.clients.set(key, profile);
      this.clientsById.set(profile.clientId, profile);
    }
    if (keys.length > 0) {
      console.error(`[GIA-Registry] Loaded ${keys.length} legacy keys from GIA_API_KEYS`);
    }
  }

  /**
   * Authenticate a request. Returns client profile or null.
   * Checks in order: revoked set → env var registry → DB (hash-based).
   */
  authenticate(apiKey: string): ClientProfile | null {
    if (this.revokedKeys.has(apiKey)) return null;

    // 1. Check env var registry (in-memory, fast)
    const envClient = this.clients.get(apiKey);
    if (envClient) return envClient;

    // 2. DB fallback is async — return null here, use authenticateAsync for DB
    return null;
  }

  /**
   * Async authenticate with DB fallback.
   * Call this from the MCP transport layer when sync authenticate() returns null.
   *
   * Token resolution order:
   *   1. OAuth JWT (iss: gia-oauth, aud: gia-mcp) — per-user, carries tenantId
   *   2. Env var registry (fast in-memory)
   *   3. PostgreSQL gia_api_keys table (hash-based)
   */
  async authenticateAsync(apiKey: string): Promise<ClientProfile | null> {
    // 1. OAuth JWT path — tokens issued by /oauth/token
    if (apiKey.includes('.') && apiKey.split('.').length === 3) {
      const claims = verifyOAuthJwt(apiKey);
      if (claims) {
        const profile: ClientProfile = {
          clientId:    `oauth-${claims.sub.slice(0, 12)}`,
          clientName:  `OAuth User (${claims.sub.slice(0, 8)})`,
          apiKey:      '',
          domain:      'general',
          tier:        'professional',
          contactEmail: '',
          tenantId:    claims.tenantId!,
          userId:      claims.sub,
          createdAt:   new Date().toISOString(),
          limits:      { ...TIER_DEFAULTS.professional },
          allowedToolPrefixes: [],
        };
        this.clientsById.set(profile.clientId, profile);
        return profile;
      }
      // Falls through — malformed JWT or wrong audience; try as raw key
    }

    // 2. Sync check (env var registry)
    const syncResult = this.authenticate(apiKey);
    if (syncResult) return syncResult;

    // 2. DB fallback — hash the incoming key and look up
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    // Rate-limit pre-check — reject before hitting DB if this key hash is over limit
    const preAuthState = getOrCreateRateState(`preauth:${keyHash.slice(0, 16)}`);
    const now = Date.now();
    if (now - preAuthState.minuteWindow.windowStart > 60_000) {
      preAuthState.minuteWindow = { count: 0, windowStart: now };
    }
    preAuthState.minuteWindow.count++;
    if (preAuthState.minuteWindow.count > 20) {
      // More than 20 auth attempts/min for this key hash — reject without DB hit
      console.error(`[GIA-Registry] gia.key.rate_limited keyHash=${keyHash.slice(0, 14)}`);
      return null;
    }

    // Check cache first
    const cached = getCachedDbAuth(keyHash);
    if (cached) {
      if (!cached.profile) {
        console.error(`[GIA-Registry] gia.key.auth_failed (cached negative) prefix=${apiKey.substring(0, 14)}`);
      }
      return cached.profile;
    }

    // Query DB
    const pool = await getDbPool();
    if (!pool) return null;

    try {
      const result = await pool.query(
        `SELECT k.id, k.api_key_prefix, k.client_name, k.email, k.tier, k.domain,
                k.requests_per_minute, k.tool_calls_per_day, k.max_monthly_cost_usd,
                k.status, k.created_at,
                COALESCE(u.tenant_id, 'marketplace-' || k.id) AS tenant_id
         FROM gia_api_keys k
         LEFT JOIN users u ON lower(u.email) = lower(k.email) AND u.is_active = true
         WHERE k.api_key_hash = $1 AND k.status = 'active'
         LIMIT 1`,
        [keyHash]
      );

      if (result.rows.length === 0) {
        // Negative cache — brute force protection
        cacheDbAuth(keyHash, null);
        console.error(`[GIA-Registry] gia.key.auth_failed hash=${keyHash.substring(0, 12)}`);
        return null;
      }

      const row = result.rows[0];
      const profile: ClientProfile = {
        clientId: row.id,
        clientName: row.client_name,
        apiKey: '',  // Never store raw key in profile for DB-sourced clients
        domain: row.domain || 'general',
        tier: row.tier as ClientTier,
        contactEmail: row.email,
        tenantId: row.tenant_id || `marketplace-${row.id}`,
        createdAt: row.created_at,
        limits: {
          requestsPerMinute: row.requests_per_minute,
          toolCallsPerDay: row.tool_calls_per_day,
          maxMonthlyCostUsd: row.max_monthly_cost_usd,
          maxConcurrentSessions: TIER_DEFAULTS[row.tier as ClientTier]?.maxConcurrentSessions || 2,
        },
        allowedToolPrefixes: [],
      };

      // Positive cache
      cacheDbAuth(keyHash, profile);

      // Register in memory maps for rate limiting to work
      this.clientsById.set(profile.clientId, profile);

      // Update last_used_at in background (fire-and-forget)
      pool.query(
        `UPDATE gia_api_keys SET last_used_at = now() WHERE id = $1`,
        [row.id]
      ).catch(() => { /* fire-and-forget */ }); // qa:ignore — fire-and-forget

      return profile;
    } catch (err) {
      console.error('[GIA-Registry] DB auth lookup failed:', err);
      return null;
    }
  }

  /** Check if a request is within rate limits. Returns { allowed, reason }. */
  checkRateLimit(clientId: string): { allowed: boolean; reason?: string } {
    const client = this.clientsById.get(clientId);
    if (!client) return { allowed: false, reason: 'Unknown client' };

    const state = getOrCreateRateState(clientId);
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];

    // Reset minute window if expired
    if (now - state.minuteWindow.windowStart > 60_000) {
      state.minuteWindow = { count: 0, windowStart: now };
    }

    // Reset daily counter if new day
    if (state.dailyUsage.date !== today) {
      state.dailyUsage = { toolCalls: 0, date: today };
    }

    // Check minute rate
    if (state.minuteWindow.count >= client.limits.requestsPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${client.limits.requestsPerMinute} requests/minute (tier: ${client.tier})`,
      };
    }

    // Check daily tool calls
    if (state.dailyUsage.toolCalls >= client.limits.toolCallsPerDay) {
      return {
        allowed: false,
        reason: `Daily limit exceeded: ${client.limits.toolCallsPerDay} tool calls/day (tier: ${client.tier})`,
      };
    }

    return { allowed: true };
  }

  /** Record a request for rate tracking */
  recordRequest(clientId: string): void {
    const state = getOrCreateRateState(clientId);
    state.minuteWindow.count++;
    state.dailyUsage.toolCalls++;
  }

  /** Check concurrent session limit */
  checkSessionLimit(clientId: string): { allowed: boolean; reason?: string } {
    const client = this.clientsById.get(clientId);
    if (!client) return { allowed: false, reason: 'Unknown client' };

    const state = getOrCreateRateState(clientId);
    if (state.activeSessions >= client.limits.maxConcurrentSessions) {
      return {
        allowed: false,
        reason: `Session limit exceeded: ${client.limits.maxConcurrentSessions} concurrent sessions (tier: ${client.tier})`,
      };
    }
    return { allowed: true };
  }

  /** Track session open/close */
  sessionOpened(clientId: string): void {
    getOrCreateRateState(clientId).activeSessions++;
  }

  sessionClosed(clientId: string): void {
    const state = getOrCreateRateState(clientId);
    state.activeSessions = Math.max(0, state.activeSessions - 1);
  }

  /** Revoke a key at runtime */
  revokeKey(apiKey: string): boolean {
    const client = this.clients.get(apiKey);
    if (!client) return false;
    this.revokedKeys.add(apiKey);
    this.clients.delete(apiKey);
    console.error(`[GIA-Registry] Key revoked for client: ${client.clientId}`);
    return true;
  }

  /** Get all active clients (for admin/reporting) */
  listClients(): Array<{
    clientId: string;
    clientName: string;
    domain: string;
    tier: ClientTier;
    limits: ClientProfile['limits'];
    activeSessions: number;
    dailyToolCalls: number;
  }> {
    return Array.from(this.clientsById.values()).map(c => {
      const state = rateLimitState.get(c.clientId);
      return {
        clientId: c.clientId,
        clientName: c.clientName,
        domain: c.domain,
        tier: c.tier,
        limits: c.limits,
        activeSessions: state?.activeSessions || 0,
        dailyToolCalls: state?.dailyUsage.toolCalls || 0,
      };
    });
  }

  get size(): number {
    return this.clients.size;
  }
}

export { TIER_DEFAULTS };
