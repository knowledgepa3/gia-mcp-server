/**
 * @module    shared-constants
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOREY_THRESHOLD_MIN = 0.10;
export const STOREY_THRESHOLD_MAX = 0.18;
export const STOREY_THRESHOLD_CRITICAL_LOW = 0.05;
export const STOREY_THRESHOLD_CRITICAL_HIGH = 0.25;
export const STOREY_THRESHOLD_MIN_WINDOW = 20;
export const STOREY_THRESHOLD_WINDOW_SIZE = 100;
/**
 * Minimum wall-clock span the rolling threshold window must cover before its
 * reading is treated as representative of current operational health.
 *
 * If the window is full (count-wise) but every entry was stamped within this
 * span — for example because recovery seeded historical entries with `new
 * Date()` instead of their original timestamps — the reading is not predictive
 * and `getReading()` returns INSUFFICIENT_DATA.
 *
 * 5 minutes: long enough to catch a boot-time recovery batch, short enough to
 * not block legitimate bursty traffic.
 */
export const STOREY_THRESHOLD_MIN_WINDOW_SPAN_MS = 5 * 60 * 1000;

export const DEFAULT_SCORE_WEIGHTS = {
  integrity: 0.40,
  accuracy: 0.35,
  compliance: 0.25,
} as const;

export const MIN_COMPOSITE_SCORE = 0.70;
export const SCORE_REVIEW_THRESHOLD = 0.80;
export const SCORE_HALT_THRESHOLD = 0.50;

/**
 * Sentinel written for operations that have no integrity/accuracy/compliance to
 * measure (control-plane events: server start, gate approve/reject, etc.). It is
 * intentionally OUT OF the valid [0,1] score range so it can never be mistaken for
 * a real measurement, and it is below MIN_COMPOSITE_SCORE so a not-scored entry
 * never reads as a passing gate result. Paired with IGovernanceScore.scored=false.
 */
export const NOT_SCORED_SENTINEL = -1;

export const ADVISORY_GATE_TIMEOUT_MS = 60 * 1000; // 60s pause-and-flag; tune 30s–5min via IGateConfig.advisoryTimeoutMs
export const MANDATORY_GATE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

// Gate SLA tiers — escalation ladder for MANDATORY gates
export const MANDATORY_GATE_SLA_WARNING_MS = 2 * 60 * 60 * 1000;    // 2h — SLA warning (amber)
export const MANDATORY_GATE_SLA_BREACH_MS = 8 * 60 * 60 * 1000;     // 8h — SLA breach (red, escalate)

export const MAX_REPAIR_ATTEMPTS = 3;
export const MAX_CONCURRENT_AGENTS = 10;
export const MAX_INPUT_LENGTH = 50_000;
export const MAX_OUTPUT_LENGTH = 100_000;
export const TIER_RATE_LIMITS = {
  SCOUT: 100,
  OPERATOR: 1000,
  COMMANDER: 10000,
  ARCHITECT: Infinity,
} as const;

export const AUDIT_RETENTION_DAYS = 365;
export const MAX_AUDIT_METADATA_SIZE = 10_000;

/**
 * Genesis hash for the first entry in the hash-chained audit ledger.
 * SHA-256 of 'GIA_GENESIS_BLOCK_v1' — deterministic, verifiable, never changes.
 * This is the cryptographic anchor for the entire tamper-evident chain.
 */
export const GENESIS_HASH = 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a';

/**
 * Hash algorithm used for the audit chain. SHA-256 per NIST FIPS 180-4.
 * If a future migration to SHA-3 or BLAKE3 is needed, bump CHAIN_VERSION
 * and implement a migration path in the ledger that can verify both old
 * and new algorithm entries during the transition window.
 */
export const HASH_ALGORITHM = 'sha256';

/**
 * Chain format version. Embed in exports/backups so future code can
 * detect which canonical serialization + hash algorithm was used.
 * Bump this if you change the canonical form or HASH_ALGORITHM.
 *
 * 2 = Ledger Canonical v2 (canonicalV2.ts, 2026-07-01): closed 9-key field
 *     set, in-preimage schemaVersion, golden-vector-gated. Epoch 1 rows are
 *     the heterogeneous legacy bucket — linkage-only verifiable.
 */
export const CHAIN_VERSION = 2;

// ─── Governed Sampling ─────────────────────────────────────────────────────
export const SAMPLING_OP_REQUESTED = 'governed-sampling';
export const SAMPLING_OP_DENIED = 'governed-sampling-denied';
export const SAMPLING_DEFAULT_MAX_TOKENS = 4096;
export const SAMPLING_DEFAULT_RATE_LIMIT = 10;
export const SAMPLING_DEFAULT_HOUR_BUDGET = 50_000;

/**
 * The version this artifact actually is — read from the published package
 * manifest, never hand-maintained.
 *
 * A literal here is a provenance hazard: npm 0.4.1 and 0.4.2 both shipped a
 * build that reported `0.4.0` in `serverInfo.version`, in `/health`, and in
 * every `mcp-server-start` forensic-ledger row, so neither an operator nor an
 * auditor could tell which build was running. Reading the manifest makes the
 * reported version self-correcting at publish time.
 *
 * Resolution is relative to this module, which sits two levels below the
 * package root in both layouts (`src/shared/` when run through vitest/tsx,
 * `dist/shared/` when run from the published package).
 *
 * Guarded by tests/shared/version-provenance.test.ts.
 */
function resolvePackageVersion(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(moduleDir, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof manifest.version === 'string' && manifest.version.length > 0) {
      return manifest.version;
    }
    // Fall through to the sentinel below — a manifest without a version is a
    // packaging fault, not something to paper over with a plausible number.
  } catch {
    // Same: never fabricate a version. The sentinel is deliberately not
    // semver-plausible so it cannot be mistaken for a real release.
  }
  console.error(
    '[GIA] WARNING: could not read package.json — version reported as UNKNOWN. ' +
    'Ledger rows and serverInfo will not identify this build.',
  );
  return '0.0.0-unknown';
}

export const GIA_VERSION = resolvePackageVersion();
export const GIA_SERVER_NAME = 'gia-mcp-server';
export const GIA_AUTHOR = 'William J. Storey III';
export const GIA_DESCRIPTION = 'Governed Intelligence Architecture — Governed, Secure, Auditable AI Operations';
