import type { GovernanceEngine } from '../core/governance.js';

/**
 * Per-tenant GovernanceEngine cache.
 *
 * ONE engine per tenant, shared by BOTH tiers (/mcp and /mcp/agent). Every
 * GovernanceEngine constructs its own ForensicLedger and hydrates the entire
 * chain into its own heap, so the previous per-tier split made one tenant pay
 * the ledger twice. `maxVisibility` only shapes TOOL REGISTRATION on the
 * per-session McpServer (server.ts:159/187/201/213) — it never touches the
 * engine, ledger, gate or threshold monitor — so one engine serving both tiers
 * is correct, not merely cheaper.
 *
 * KEYED PER TENANT, DELIBERATELY (William's governance call, 2026-07-29): a
 * process-wide engine would seed one tenant's StoreyThresholdMonitor from
 * another tenant's classifications — leakage, and corruption of the Chain of
 * Reasoning as an audit identity. Cross-tenant metrics come from query-time DB
 * aggregation, never from a shared in-memory chain.
 *
 * LONG-LIVED BY DESIGN (2026-07-17 incident): the engine must survive
 * session/transport churn. A per-reconnect engine once reaped a customer's live
 * MANDATORY gate. Only the McpServer + transport are per-session. This module
 * deliberately exposes no per-session eviction hook — do not add one.
 */

const tenantEngines = new Map<string, Promise<GovernanceEngine>>();

/**
 * Get the shared engine for `tenantId`, constructing it via `factory` on
 * first use. Concurrent calls for the same tenant coalesce onto the same
 * in-flight promise (the map stores the PROMISE, not the resolved value, so
 * simultaneous callers never trigger a second construction). A rejected
 * construction is NOT cached — the entry is dropped so the next call retries.
 */
export function getOrCreateTenantEngine(
  tenantId: string,
  factory: () => Promise<GovernanceEngine>,
): Promise<GovernanceEngine> {
  const existing = tenantEngines.get(tenantId);
  if (existing) return existing;

  const creating = factory();
  tenantEngines.set(tenantId, creating);
  // On failure, drop the cached promise so the next request retries cleanly.
  creating.catch(() => tenantEngines.delete(tenantId));
  return creating;
}
