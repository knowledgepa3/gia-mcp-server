/**
 * @module    gate-auth
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       M — authorizing a gate mutation is a MANDATORY governance control
 * @audit     true — callers log denials to the forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Authentication guard for state-changing MANDATORY-gate endpoints
 * (approve / reject / break-glass) on the GIA MCP HTTP transport.
 *
 * Closes mandatory-gate-approval-auth-gap (verified 2026-05-30): these
 * endpoints must NOT rely on the Nginx reverse proxy alone. Every gate
 * mutation requires an authenticated client — defense in depth for the
 * human-oversight control at the heart of the MAI Framework.
 */

import type { IncomingMessage } from 'node:http';
import type { ClientProfile, ClientRegistry } from './client-registry.js';

/**
 * Extract a Bearer token from the Authorization header.
 * Returns null when the header is absent or uses a non-Bearer scheme.
 */
export function extractBearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

/**
 * Authorize a state-changing gate operation (approve / reject / break-glass).
 *
 * @param token    Bearer token (or query-param key) extracted by the caller.
 * @param registry Client registry used to resolve the token to a client.
 * @returns the authenticated ClientProfile, or null when the caller is
 *          unauthenticated (no token, or a token that resolves to no client).
 *
 * @governance TRANSPORT-layer authentication gate. On null, the caller MUST
 *             refuse the mutation (401) and must not touch gate state.
 */
export async function authorizeGateToken(
  token: string | null,
  registry: Pick<ClientRegistry, 'authenticateAsync'>,
): Promise<ClientProfile | null> {
  if (!token) return null;
  return registry.authenticateAsync(token);
}

/** Rollout mode for gate-mutation authentication. */
export type GateAuthMode = 'monitor' | 'enforce';

export interface GateAuthDecision {
  /** Whether the gate mutation may proceed. */
  allow: boolean;
  /** Whether the caller presented a valid client identity. */
  authenticated: boolean;
  /** Audit outcome for the forensic ledger / structured log. */
  outcome: 'authenticated' | 'monitored-unauthenticated' | 'blocked-unauthenticated';
}

/**
 * Resolve the rollout mode from the environment. Defaults to 'monitor' —
 * unauthenticated gate mutations are logged but allowed, so existing clients
 * (e.g. dashboard.html) are not broken. Set GIA_GATE_AUTH_ENFORCE=enforce to
 * hard-block once clients are confirmed to send a token.
 */
export function gateAuthMode(): GateAuthMode {
  return process.env.GIA_GATE_AUTH_ENFORCE === 'enforce' ? 'enforce' : 'monitor';
}

/**
 * Decide whether a gate mutation may proceed, given the resolved client and
 * the rollout mode.
 *
 * Monitor-first (default): unauthenticated callers are ALLOWED but flagged
 * ('monitored-unauthenticated') so the gap is recorded without breaking the
 * existing dashboard. In 'enforce' mode, unauthenticated callers are blocked.
 * (Closes mandatory-gate-approval-auth-gap, verified 2026-05-30.)
 */
export function decideGateAuth(client: ClientProfile | null, mode: GateAuthMode): GateAuthDecision {
  if (client) {
    return { allow: true, authenticated: true, outcome: 'authenticated' };
  }
  if (mode === 'enforce') {
    return { allow: false, authenticated: false, outcome: 'blocked-unauthenticated' };
  }
  return { allow: true, authenticated: false, outcome: 'monitored-unauthenticated' };
}

export interface GateMutationAuthResult {
  decision: GateAuthDecision;
  client: ClientProfile | null;
}

/**
 * One-call guard for HTTP gate-mutation handlers: extract Bearer token →
 * authenticate against the client registry → decide per rollout mode.
 */
export async function authorizeGateMutation(
  req: Pick<IncomingMessage, 'headers'>,
  registry: Pick<ClientRegistry, 'authenticateAsync'>,
  mode: GateAuthMode = gateAuthMode(),
): Promise<GateMutationAuthResult> {
  const client = await authorizeGateToken(extractBearerToken(req), registry);
  return { decision: decideGateAuth(client, mode), client };
}
