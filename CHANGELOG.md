# Changelog

All notable changes to GIA MCP Server will be documented in this file.

## [0.4.4] - 2026-07-30

### Fixed

- Restored the `mcpName` field to package.json. The official MCP registry
  verifies namespace ownership by reading it from the npm-published manifest;
  the 0.3.x proxy had it and the 0.4.x embedded line dropped it, which is why
  every registry publish since silently failed and the registry stayed pinned
  to 0.3.1 with the retired proxy architecture and an auth header the live
  endpoint rejects. No code changes.

## [0.4.3] - 2026-07-29

Truth-in-advertising release. A live audit of the published artifact (not the
source) found the package under-reporting its own version, over-claiming in
some places and under-claiming in others, and documenting install paths and
examples that did not execute. Everything below is now bound by tests that fail
the release rather than by hand-maintained prose.

### Fixed

- **Version provenance.** `GIA_VERSION` was the literal `'0.4.0'`, so npm 0.4.1
  and 0.4.2 both shipped builds that reported 0.4.0 in `serverInfo.version`, in
  `/health`, and in every `mcp-server-start` ledger row — three published
  versions were indistinguishable at runtime. It is now read from the package
  manifest. Guarded by `tests/shared/version-provenance.test.ts`.
- **Tool count.** The README advertised 33 tools while the server registered
  **57**; its own tables listed 35; the startup banner printed an impossible
  "registered 33/32 tool groups"; `list_available_tools` said 31; the HTTP
  server card and `/health` returned a hardcoded 43. Every count is now derived
  from `TOOL_CLASSIFICATIONS`, whose key set is already proven equal to the
  registered tool set. All 57 tools are documented, drift-guarded by
  `tests/docs/published-claims.test.ts`.
- **Registry manifest.** `server.json` did not exist in this repository — it
  lived only in the published GitHub export, which is why it went stale. It now
  lives here, versioned with the package, and declares `Authorization` instead
  of `x-api-key`; the live endpoint never accepted `x-api-key`.
- **From-source install.** `npm install && npm start` failed with
  `MODULE_NOT_FOUND` because `dist/` is not checked in. The documented path now
  includes `npm run build`. Install options are numbered 1-4 (there was no 3).
- **Documented examples now execute.** The `classify_decision` example omitted
  the required `domain` argument and returned `-32602`; the `score_governance`
  example omitted the required `operation` and claimed `grade`/`pass` fields
  that the tool does not return. Both are corrected to real request/response
  shapes and are schema-guarded.
- **Smithery.** The advertised unqualified package name did not resolve; the
  command now uses the namespaced name and current `mcp add` verb.
- **Packaging.** The published tarball carried the test suite
  (`dist/**/__tests__/*.test.js`) and 244 source maps — 481 files. A dedicated
  `tsconfig.build.json` excludes both: 225 files.

### Changed

- **Vendor-neutral throughout.** Package description, keywords, registry
  manifest, README headline, and architecture diagrams no longer position GIA
  around any single model vendor. GIA governs whichever model sits behind the
  client; client config paths remain documented for convenience across many
  clients equally.
- **Tool tiering is now documented honestly.** Local stdio runs at **operator**
  tier with no authentication — every tool including `approve_gate` and
  `gia_apply_pack` is exposed. That is intentional for a single-operator
  embedded engine, and the README says so plainly along with the
  `GIA_TOOL_VISIBILITY` knob for installs where it is not appropriate.
- **Quieter, more honest startup.** Nine modules each announced
  "No DATABASE_URL" on the supported embedded path, and a
  `PLATFORM_PRIMARY_TENANT_ID` warning fired even when nothing was being
  persisted. Per-module notices now require `GIA_VERBOSE`; the engine's single
  persistence-mode line and the ledger's own "not durable" line stay
  unconditional, because those are the claims an operator must not miss.
- **Production figures are attributed and dated.** The 890+ ledger entries and
  96.5/100 readiness score describe the hosted deployment as of 2026-07 and are
  labelled an internal validation, not a third-party audit. A fresh embedded
  engine starts with an empty ledger.
- `prepublishOnly` now runs the provenance, published-claims, and
  tool-classification drift guards, so a release cannot ship with these
  statements out of sync again.

## [0.4.0] - 2026-05-29

### Security

- **Door 2 SDK governance hook now fails CLOSED by default.** When GIA governance
  is unreachable (the classify call throws — network error, 5xx, auth, timeout),
  the Claude Agent SDK `PreToolUse` hook now **denies** any non-bypassed tool and
  notifies the operator, instead of letting it run ungoverned. Closes a fail-open
  seam where even a MANDATORY tool would execute while GIA was down.
  - New `failSafe` option: `'closed'` (default) or `'open'`.
  - `failSafe: 'open'` restores the prior allow-with-warning behavior for callers
    that prefer availability over safety.
  - `enforceGates: false` (advisory-only mode) never blocks; read-only
    `bypassTools` are unaffected.
- **Kernel config fingerprint is now verified on boot (opt-in).** The engine
  already stamped a SHA-256 fingerprint of its governance config; it now compares
  that fingerprint to a pinned expected value.
  - Set `GIA_EXPECTED_CONFIG_FINGERPRINT` to pin it. A mismatch records a
    MANDATORY `kernel-config-drift-detected` forensic ledger event and alerts on
    stderr.
  - Set `GIA_FINGERPRINT_ENFORCE=halt` to refuse startup on drift. Default is
    alert-only; an unset pin is a no-op, so deployments that have not opted in are
    never affected.

### ⚠️ Migration

- Integrations relying on tools continuing to execute when GIA is unreachable must
  now set `failSafe: 'open'` explicitly to keep that behavior.

## [0.3.6] - 2026-05-13

### Fixed
- **GIA_VERSION constant was frozen at 0.1.0** — `src/shared/constants.ts` now reflects the
  actual package version (0.3.6). The version reported by `system_status` and server
  handshake was always showing 0.1.0 regardless of package version.
- **GIA_SERVER_NAME** updated from `gia-governance-server` to `gia-mcp-server` to match
  the npm package name and Glama/Smithery registry slug.

### Improved
- **`system_status` tool description** — removed the `AUTHENTICATION` note that caused
  Glama's tool-quality scorer to flag it as "misleading connectivity framing." Improved
  the RETURNS section to document each field name and type explicitly. Added output schema
  annotation in `_meta` for registry crawlers.

## [0.3.5] - 2026-05-13

### Fixed
- **Incomplete npm tarball**: `files` field in `package.json` previously only shipped
  `dist/index.js` (the re-export shim). Changed to `dist/` so all compiled modules —
  `dist/mcp/`, `dist/core/`, `dist/shared/`, etc. — are included. Packages 0.3.0–0.3.4
  would crash with `Cannot find package './mcp/server.js'` after the bin loaded.

## [0.3.4] - 2026-05-13

### Fixed
- **Windows ESM crash** (`ERR_UNSUPPORTED_ESM_URL_SCHEME`): `bin/gia-mcp-server.js` now
  wraps the dynamic `import()` path with `pathToFileURL().href` so Windows absolute paths
  (`C:\...`) are converted to valid `file://` URLs before being passed to the Node.js ESM
  loader. Previously the raw Win32 path was passed directly, which Node ≥18 rejects.

## [0.1.0] - 2026-02-08

### Initial Release

#### Governance Engine
- MAI Framework classification (Mandatory/Advisory/Informational)
- Context-aware elevation rules (PII, financial impact, legal impact, client-facing)
- Domain-specific escalation (healthcare, veterans, legal, finance, defense)

#### Forensic Ledger
- Hash-chained, append-only audit trail (SHA-256)
- Chain integrity verification
- Operation-based and time-range querying

#### Human-in-the-Loop Gates
- MANDATORY gate enforcement with pending approval tracking
- Gate approval/rejection with rationale capture
- Audit trail for all gate decisions

#### Governance Scoring
- Three-dimensional scoring: Integrity (40%), Accuracy (35%), Compliance (25%)
- Weighted composite with pass/fail and letter grades (A+ through F)
- Threshold-based recommendations

#### Storey Threshold
- Governance health metric measuring MANDATORY escalation rate
- Healthy band: 10-18%
- Status levels: HEALTHY, DEGRADED, CRITICAL

#### Compliance Mapping
- NIST AI RMF (8 controls)
- EU AI Act (8 articles)
- ISO/IEC 42001 (6 controls)
- NIST SP 800-53 (11 controls)

#### EU AI Act Risk Assessment
- Four-tier risk classification (Unacceptable, High, Limited, Minimal)
- Governance and documentation requirements per tier
- Domain-aware assessment

#### MCP Transport
- 10 MCP tools via stdio transport
- Compatible with Claude Desktop and Claude Code
