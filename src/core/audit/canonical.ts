/**
 * @module    audit-canonical
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       M — defines the canonical preimage for every ledger hash
 * @audit     true — this IS the hash definition for the audit chain
 * @owner     William J. Storey III / ACE / GIA
 *
 * SINGLE SOURCE OF TRUTH for forensic-ledger canonicalization + hashing.
 *
 * Before this module existed, two implementations diverged:
 *   - ledger.ts canonicalize()        — recursive key sort (authoritative)
 *   - ledger-persistence.ts recompute — TOP-LEVEL key sort only (flat)
 * Any entry with nested metadata produced a DIFFERENT hash from each, so the
 * DB-persisted hash and the in-memory hash drifted on every write, which in
 * turn motivated the manual repair scripts (truth-map #6, 2026-06-29). Both
 * call sites now import from here, so the preimage can never diverge again.
 *
 * CRITICAL: changing canonicalize() changes EVERY hash in the ledger. If this
 * function is ever modified, bump CHAIN_VERSION and implement a migration path.
 * The entryHash, previousHash, and chainIndex fields are EXCLUDED from the
 * canonical form — they are the OUTPUT of hashing, not the INPUT.
 */

import { createHash } from 'node:crypto';

import type { IAuditEntry } from '../../shared/types.js';
import { HASH_ALGORITHM } from '../../shared/constants.js';

/**
 * Produce a deterministic canonical JSON string from an audit entry.
 *
 * Keys are sorted RECURSIVELY (the replacer fires on every nested object, not
 * just the top level) and Dates are converted to ISO strings, so identical
 * input always yields identical output regardless of key insertion order or
 * nesting depth.
 */
export function canonicalize(entry: IAuditEntry): string {
  return JSON.stringify(entry, (key, value) => {
    // Exclude hash chain fields — they are computed, not source data
    if (key === 'entryHash' || key === 'previousHash' || key === 'chainIndex') {
      return undefined;
    }
    // Convert Date objects to ISO strings for deterministic serialization
    if (value instanceof Date) {
      return value.toISOString();
    }
    // Sort object keys (recursively — the replacer is applied to nested objects too)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Compute SHA-256 hash of (previousHash || canonicalEntryData).
 * The core of the hash chain: each entry's hash depends on the previous entry's
 * hash (chain integrity) and the current entry's canonical data (entry integrity).
 */
export function computeEntryHash(previousHash: string, entry: IAuditEntry): string {
  const canonical = canonicalize(entry);
  const preimage = previousHash + '||' + canonical;
  return createHash(HASH_ALGORITHM).update(preimage, 'utf8').digest('hex');
}
