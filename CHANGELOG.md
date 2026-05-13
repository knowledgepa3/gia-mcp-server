# Changelog

All notable changes to GIA MCP Server will be documented in this file.

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
