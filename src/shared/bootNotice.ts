/**
 * @module    shared-boot-notice
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A — diagnostic output only, no governed action
 * @audit     false — startup diagnostics are not audit records
 * @owner     William J. Storey III / ACE / GIA
 *
 * Startup diagnostics that are true but not newsworthy.
 *
 * Running embedded with no DATABASE_URL is a supported, documented mode — it is
 * the default for `npx gia-mcp-server`. Nine separate modules each announcing
 * "No DATABASE_URL" made a normal first run look like a misconfigured one: the
 * first eleven lines a new user saw were warnings about the path they had
 * deliberately chosen.
 *
 * Per-module notices route through here and appear only under GIA_VERBOSE. Two
 * lines stay unconditional by design and do NOT use this helper:
 *
 *   - `[GovernanceEngine] Running in-memory only (no DATABASE_URL)` — the one
 *     consolidated statement of persistence mode.
 *   - `[Ledger-Persist] No DATABASE_URL — running in-memory only` — the audit
 *     spine says out loud when it is not durable. That is exactly the claim an
 *     operator must never miss, so it is never suppressed.
 *
 * This is about signal, not silence: nothing here changes behavior, and anything
 * actionable (missing migrations, failed writes, dropped events) stays loud.
 */

/**
 * Emit a startup diagnostic that only matters when someone is debugging boot.
 *
 * @param message — the diagnostic line, already prefixed with its `[Module]` tag
 */
export function bootNotice(message: string): void {
  const verbose = process.env.GIA_VERBOSE;
  if (verbose === '1' || verbose === 'true') {
    console.error(message);
  }
}
