/**
 * @module    test-gate-auth
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Regression tests for mandatory-gate-approval-auth-gap (verified 2026-05-30).
 * State-changing gate endpoints (approve / reject / break-glass) must require an
 * authenticated client — they may NOT rely on the Nginx reverse proxy alone.
 */

import { describe, it, expect } from 'vitest';
import { extractBearerToken, authorizeGateToken, decideGateAuth, authorizeGateMutation } from '../../src/mcp/gate-auth.js';
import type { ClientProfile } from '../../src/mcp/client-registry.js';

const fakeClient: ClientProfile = {
  clientId: 'test-client',
  clientName: 'Test Client',
  apiKey: 'valid-key',
  domain: 'general',
  tier: 'enterprise',
  contactEmail: '',
  tenantId: 'default',
  createdAt: '2026-05-30T00:00:00.000Z',
  limits: { requestsPerMinute: 1, toolCallsPerDay: 1, maxMonthlyCostUsd: 1, maxConcurrentSessions: 1 },
  allowedToolPrefixes: [],
};

// Injected fake — exercises the guard's real decision flow without a DB-backed registry.
const fakeRegistry = {
  authenticateAsync: async (key: string): Promise<ClientProfile | null> =>
    key === 'valid-key' ? fakeClient : null,
};

describe('extractBearerToken', () => {
  it('returns null when the Authorization header is absent', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'Basic abc123' } })).toBeNull();
  });

  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer valid-key' } })).toBe('valid-key');
  });
});

describe('authorizeGateToken — state-changing gate ops require an authenticated client', () => {
  it('denies when no token is presented (closes the unauthenticated-approval hole)', async () => {
    const client = await authorizeGateToken(null, fakeRegistry);
    expect(client).toBeNull();
  });

  it('denies when the token does not resolve to a known client', async () => {
    const client = await authorizeGateToken('bogus-key', fakeRegistry);
    expect(client).toBeNull();
  });

  it('authorizes when the token resolves to a known client', async () => {
    const client = await authorizeGateToken('valid-key', fakeRegistry);
    expect(client).not.toBeNull();
    expect(client?.clientId).toBe('test-client');
  });
});

describe('decideGateAuth — monitor-first rollout, one flag to enforce', () => {
  it('allows an authenticated client (authenticated outcome) in monitor mode', () => {
    const d = decideGateAuth(fakeClient, 'monitor');
    expect(d.allow).toBe(true);
    expect(d.authenticated).toBe(true);
    expect(d.outcome).toBe('authenticated');
  });

  it('allows an authenticated client in enforce mode', () => {
    const d = decideGateAuth(fakeClient, 'enforce');
    expect(d.allow).toBe(true);
    expect(d.authenticated).toBe(true);
    expect(d.outcome).toBe('authenticated');
  });

  it('allows but flags an unauthenticated caller in monitor mode (no breakage)', () => {
    const d = decideGateAuth(null, 'monitor');
    expect(d.allow).toBe(true);
    expect(d.authenticated).toBe(false);
    expect(d.outcome).toBe('monitored-unauthenticated');
  });

  it('blocks an unauthenticated caller in enforce mode', () => {
    const d = decideGateAuth(null, 'enforce');
    expect(d.allow).toBe(false);
    expect(d.authenticated).toBe(false);
    expect(d.outcome).toBe('blocked-unauthenticated');
  });
});

describe('authorizeGateMutation — composed request guard (extract → authenticate → decide)', () => {
  it('authorizes a request carrying a valid Bearer token', async () => {
    const { decision, client } = await authorizeGateMutation(
      { headers: { authorization: 'Bearer valid-key' } }, fakeRegistry, 'enforce',
    );
    expect(decision.allow).toBe(true);
    expect(decision.outcome).toBe('authenticated');
    expect(client?.clientId).toBe('test-client');
  });

  it('flags but allows a tokenless request in monitor mode (dashboard not broken)', async () => {
    const { decision, client } = await authorizeGateMutation({ headers: {} }, fakeRegistry, 'monitor');
    expect(decision.allow).toBe(true);
    expect(decision.outcome).toBe('monitored-unauthenticated');
    expect(client).toBeNull();
  });

  it('blocks a request with an invalid token in enforce mode', async () => {
    const { decision } = await authorizeGateMutation(
      { headers: { authorization: 'Bearer bogus-key' } }, fakeRegistry, 'enforce',
    );
    expect(decision.allow).toBe(false);
    expect(decision.outcome).toBe('blocked-unauthenticated');
  });
});
