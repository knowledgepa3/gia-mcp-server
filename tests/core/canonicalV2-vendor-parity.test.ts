/**
 * @module    canonicalV2-vendor-parity.test
 * @layer     GOVERNANCE
 * @inherits  audit-canonical-v2
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * VENDOR PARITY GATE (Option A §3.1 backstop): the Ledger Canonical v2 source
 * is vendored into BOTH deployables (they cannot import each other). This test
 * asserts the two copies are BYTE-IDENTICAL, so the "single source" claim is
 * CI-enforced, not aspirational. If this test is red, someone edited one copy
 * without re-vendoring the other — divergence is exactly how the original
 * multi-preimage bug happened. Copy the edited file over the stale one
 * verbatim, then re-run BOTH golden-vector suites.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP_COPY = join(__dirname, '..', '..', 'src', 'core', 'audit', 'canonicalV2.ts');
const SERVER_COPY = join(__dirname, '..', '..', '..', 'server', 'src', 'audit', 'canonicalV2.ts');

describe('Ledger Canonical v2 — vendored single source', () => {
  it('gia-mcp-server and server copies of canonicalV2.ts are byte-identical', () => {
    const mcp = readFileSync(MCP_COPY, 'utf8');
    const server = readFileSync(SERVER_COPY, 'utf8');
    expect(server).toBe(mcp);
  });
});
