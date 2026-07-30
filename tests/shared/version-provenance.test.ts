/**
 * Version provenance guard.
 *
 * The version an MCP client sees in `serverInfo.version` — and an auditor sees
 * in a forensic-ledger `mcp-server-start` row — MUST be the version of the
 * artifact that was actually published. npm 0.4.2 shipped a build reporting
 * 0.4.0 because GIA_VERSION was a hand-maintained literal, leaving three
 * published versions indistinguishable at runtime. This makes that class of
 * drift impossible to ship again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIA_VERSION } from '../../src/shared/constants.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };

describe('version provenance', () => {
  it('GIA_VERSION is the published package version, not a hand-maintained literal', () => {
    expect(GIA_VERSION).toBe(pkg.version);
  });

  it('GIA_VERSION never silently degrades to the unknown sentinel', () => {
    expect(GIA_VERSION).not.toMatch(/unknown/i);
    expect(GIA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('server.json declares the same version as package.json, in both places', () => {
    const serverJson = JSON.parse(readFileSync(join(repoRoot, 'server.json'), 'utf8')) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    expect(serverJson.version).toBe(pkg.version);
    for (const p of serverJson.packages) {
      expect(p.version).toBe(pkg.version);
    }
  });
});
