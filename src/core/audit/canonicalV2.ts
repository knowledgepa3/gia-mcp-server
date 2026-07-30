/**
 * @module    audit-canonical-v2
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — defines the epoch-2 canonical preimage for every ledger hash
 * @audit     true — this IS the hash definition for the epoch-2 audit chain
 * @owner     William J. Storey III / ACE / GIA
 *
 * LEDGER CANONICAL v2 — the single cross-process canonicalization contract.
 * Design: docs/2026-06-30-ledger-canonicalization-v2-option-a-design.md (Option A).
 *
 * ⚠ VENDORED SINGLE SOURCE. This exact file exists at BOTH paths:
 *     gia-mcp-server/src/core/audit/canonicalV2.ts
 *     server/src/audit/canonicalV2.ts
 *   The two deployables cannot import each other, so the file is vendored and a
 *   CI test asserts the copies are BYTE-IDENTICAL and that golden vectors hash
 *   identically through both. Edit one copy → copy it to the other verbatim →
 *   run the golden-vector suites. Any change to canonicalization behavior is a
 *   NEW EPOCH: bump V2_SCHEMA_VERSION/CHAIN_VERSION, regenerate vectors, add a
 *   migration marker. Never edit behavior in place.
 *
 * WHY v2 (vs canonical.ts): canonical.ts hashes "whatever IAuditEntry contains"
 * — an open-ended TS interface only one process has. v2 is an explicit, CLOSED
 * field set both writers project into before hashing, so a future optional
 * field cannot silently re-diverge the preimages (the exact failure that
 * produced ≥4 incompatible hash algorithms on one chain).
 *
 * THE v2 PREIMAGE ATTESTS (exactly these 9 keys, always present, fixed order):
 *   actor, correlationId, id, layer, metadata, operation, parentId,
 *   schemaVersion, timestamp
 * EXCLUDED BY DESIGN (DB columns, content-attested by append-only + anchoring,
 * NOT hash-attested): maiLevel, status (hardcoded-false on the Express path —
 * never notarize a known-false value into an immutable chain), governanceScore,
 * gateDecision, duration, errors, nonce, signature, keyVersion, complianceLevel,
 * policyVersion, actor role/session/tenant, sourceInstance, algoEpoch, and the
 * chain fields entryHash/previousHash/chainIndex.
 *
 * NORMALIZATION RULES (each pinned by a golden vector):
 *   - undefined → null everywhere (top-level fields AND nested metadata) — done
 *     HERE, not in per-writer mappers, so a mapper cannot forget it
 *   - objects recursively key-sorted; arrays order-PRESERVED (elements normalized)
 *   - Date and ISO-string timestamps collapse to one UTC ISO-8601(ms) form
 *   - -0 → 0; NaN/Infinity/bigint/function/symbol → throw (never silently vary)
 *   - reserved chain keys stripped at TOP LEVEL only; nested metadata preserved
 *   - layer mapped onto the closed GiaLayer enum (unknown → CORE)
 *   - hash = SHA-256(previousHash + '||' + canonicalString), utf8
 */

import { createHash } from 'node:crypto';

// ─── Epoch constants ─────────────────────────────────────────────────────────

/** In-preimage, hash-protected epoch discriminator. The AUTHORITATIVE selector
 * a verifier dispatches on; the algo_epoch DB column is only a fast-path index
 * that must agree (mismatch ⇒ LEGACY_UNVERIFIABLE, never silent selection). */
export const V2_SCHEMA_VERSION = 2 as const;

/** Chain format epoch for exports/backups. Epoch 1 = the heterogeneous legacy
 * bucket (≥3 sub-algorithms, linkage-only verifiable). Epoch 2 = this contract. */
export const CHAIN_VERSION_V2 = 2 as const;

export const HASH_ALGORITHM_V2 = 'sha256' as const;

/** Valid governance layers for the v2 preimage (closed enum). */
export const V2_LAYERS = ['CORE', 'MCP', 'VERTICAL', 'COMPLIANCE'] as const;
export type V2Layer = (typeof V2_LAYERS)[number];

/** Fixed serialization order of the closed v2 field set. NEVER reorder or
 * extend without an epoch bump — the order is part of the preimage. */
export const V2_FIELD_ORDER = [
  'actor',
  'correlationId',
  'id',
  'layer',
  'metadata',
  'operation',
  'parentId',
  'schemaVersion',
  'timestamp',
] as const;

/** Chain fields stripped from the TOP LEVEL of any input (they are the OUTPUT
 * of hashing, not the input). Nested occurrences inside metadata are PRESERVED
 * — v2 deliberately narrows canonical.ts's every-depth exclusion, which
 * silently deleted caller metadata (Open Risk R-5). */
const TOP_LEVEL_RESERVED = new Set(['entryHash', 'previousHash', 'chainIndex']);

// ─── Types ───────────────────────────────────────────────────────────────────

/** The closed epoch-2 canonical entry. Exactly these keys are hashed. */
export interface LedgerCanonicalEntry {
  id: string;
  /** ISO-8601 UTC, millisecond precision (the output of toCanonicalTimestamp). */
  timestamp: string;
  operation: string;
  layer: V2Layer;
  actor: string;
  correlationId: string | null;
  parentId: string | null;
  /** Recursively normalized (key-sorted, undefined→null) at canonicalize time. */
  metadata: Record<string, unknown>;
  schemaVersion: typeof V2_SCHEMA_VERSION;
}

/** Loose input accepted by makeLedgerCanonicalEntry — per-writer projectToV2
 * mappers and the persisted-row verifier both feed this shape. */
export interface LedgerCanonicalSource {
  id: string;
  timestamp: Date | string;
  operation: string;
  layer: string;
  actor: string;
  correlationId?: string | null;
  parentId?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─── Normalization helpers ───────────────────────────────────────────────────

/**
 * Collapse a Date or ISO-8601 string (any offset) to one UTC ISO form with
 * millisecond precision — the ONE place the Express writer (string timestamps)
 * and the MCP writer (Date timestamps) meet. Unparseable input throws: a
 * timestamp that cannot be normalized must never be silently hashed.
 */
export function toCanonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`canonicalV2: unparseable timestamp: ${String(value)}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Map an arbitrary layer string onto the closed GiaLayer enum. Unknown values
 * (e.g. Express's free-text resource.type such as 'PLATFORM' or 'tenant') map
 * to CORE — server audit events are core-plane. Idempotent for valid layers,
 * so writers and the verifier can both apply it safely. The RAW value is the
 * mapper's job to preserve inside metadata if it matters.
 */
export function mapToV2Layer(layer: string): V2Layer {
  return (V2_LAYERS as readonly string[]).includes(layer) ? (layer as V2Layer) : 'CORE';
}

/**
 * Recursively normalize a value for deterministic serialization:
 *   undefined→null, Date→canonical ISO, -0→0, objects key-sorted,
 *   arrays order-preserved, non-finite numbers / bigint / function / symbol throw.
 * Runs BEFORE JSON.stringify (no replacer), which closes the canonical.ts trap
 * where an undefined-valued key survived into the sorted object and was then
 * silently dropped by the serializer (absent-vs-undefined divergence).
 */
function normalizeValue(value: unknown, path: string): unknown {
  if (value === undefined || value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`canonicalV2: non-finite number at ${path} — cannot hash deterministically`);
    }
    return Object.is(n, -0) ? 0 : n;
  }

  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalV2: unsupported ${t} at ${path} — convert before projection`);
  }

  if (value instanceof Date) {
    return toCanonicalTimestamp(value);
  }

  if (Array.isArray(value)) {
    // Array ORDER is data — preserved. Elements are still normalized.
    return value.map((el, i) => normalizeValue(el, `${path}[${i}]`));
  }

  // Plain object: recursive key sort, undefined values coerced to null (a key
  // that exists with undefined hashes identically to one set to null).
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = normalizeValue(source[key], `${path}.${key}`);
  }
  return sorted;
}

/**
 * Deep-sanitize a metadata value into a JSON-safe form that survives the
 * PostgreSQL JSONB write→read round-trip byte-equivalently under canonicalizeV2.
 *
 * Shared by every writer's projectToV2 mapper (CLOSURE RULE: the object this
 * returns is BOTH hashed and INSERTed, so hash-form ≡ persisted-form by
 * construction). Deterministic and non-throwing — a ledger write must never be
 * LOST because a tool put NaN in its metadata: undefined/NaN/±Infinity/
 * function/symbol → null, bigint → decimal string, Date → canonical ISO,
 * -0 → 0, arrays order-preserved. Key order is irrelevant (canonicalizeV2
 * sorts recursively; JSONB does not preserve order).
 */
export function sanitizeMetadataValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) return null; // NaN/±Infinity are not JSON — deterministic null
    return Object.is(n, -0) ? 0 : n;
  }

  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return null;

  if (value instanceof Date) return toCanonicalTimestamp(value);

  if (Array.isArray(value)) {
    return value.map((el) => sanitizeMetadataValue(el));
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = sanitizeMetadataValue(source[key]);
  }
  return out;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Validate + normalize a loose source into the closed LedgerCanonicalEntry.
 * This is the shared funnel every projectToV2 mapper and the persisted-row
 * verifier must pass through — type/shape violations throw here, at the
 * projection boundary, instead of silently hashing divergent forms.
 */
export function makeLedgerCanonicalEntry(source: LedgerCanonicalSource): LedgerCanonicalEntry {
  for (const field of ['id', 'operation', 'actor'] as const) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      throw new TypeError(`canonicalV2: ${field} must be a non-empty string`);
    }
  }
  if (typeof source.layer !== 'string') {
    throw new TypeError('canonicalV2: layer must be a string');
  }
  for (const field of ['correlationId', 'parentId'] as const) {
    const v = source[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new TypeError(`canonicalV2: ${field} must be a string or null`);
    }
  }
  const metadata = source.metadata;
  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new TypeError('canonicalV2: metadata must be a plain object');
  }

  return {
    id: source.id,
    timestamp: toCanonicalTimestamp(source.timestamp),
    operation: source.operation,
    layer: mapToV2Layer(source.layer),
    actor: source.actor,
    correlationId: source.correlationId ?? null,
    parentId: source.parentId ?? null,
    metadata: metadata ?? {},
    schemaVersion: V2_SCHEMA_VERSION,
  };
}

/**
 * Produce the deterministic epoch-2 canonical JSON string.
 *
 * Accepts either a finished LedgerCanonicalEntry or any object carrying the v2
 * fields (top-level reserved chain keys are ignored; extra top-level keys are
 * ignored — the field set is CLOSED). Emits exactly V2_FIELD_ORDER, every key
 * present (null for absent optionals), schemaVersion pinned to 2 in-preimage.
 */
export function canonicalizeV2(entry: LedgerCanonicalEntry | LedgerCanonicalSource): string {
  // Defensive strip: reserved chain fields must never influence the preimage
  // even if a careless caller leaves them on the object (top level ONLY).
  const raw = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (TOP_LEVEL_RESERVED.has(key)) {
      const { [key]: _dropped, ...rest } = raw;
      return canonicalizeV2(rest as unknown as LedgerCanonicalSource);
    }
  }

  const normalized = makeLedgerCanonicalEntry(entry as LedgerCanonicalSource);

  const ordered: Record<string, unknown> = {};
  for (const key of V2_FIELD_ORDER) {
    ordered[key] = normalizeValue(normalized[key], key);
  }
  return JSON.stringify(ordered);
}

/**
 * Compute the epoch-2 entry hash: SHA-256(previousHash || '||' || canonicalV2).
 * Same chain construction as epoch 1 — only the canonical form changed.
 */
export function computeEntryHashV2(
  previousHash: string,
  entry: LedgerCanonicalEntry | LedgerCanonicalSource
): string {
  const preimage = previousHash + '||' + canonicalizeV2(entry);
  return createHash(HASH_ALGORITHM_V2).update(preimage, 'utf8').digest('hex');
}
