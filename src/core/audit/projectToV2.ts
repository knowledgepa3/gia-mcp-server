/**
 * @module    audit-project-to-v2
 * @layer     GOVERNANCE
 * @inherits  audit-canonical-v2
 * @mai       M — defines what the MCP writer's epoch-2 hash attests
 * @audit     true — feeds the epoch-2 preimage for every MCP-written ledger row
 * @owner     William J. Storey III / ACE / GIA
 *
 * MCP-side projectToV2 mapper: IAuditEntry → LedgerCanonicalSource.
 *
 * This is the ONLY MCP-specific canonicalization code (Option A §2.5); the
 * shared, byte-locked core lives in canonicalV2.ts (vendored single source).
 *
 * CLOSURE RULE (verifier soundness, Open Risk R-6/R-8): the metadata object
 * this mapper returns is BOTH what gets hashed AND — via JSON.stringify of the
 * SAME object — what gets INSERTed into the metadata JSONB column. Hash-form
 * and persisted-form cannot diverge by construction. Never hash entry.metadata
 * directly and insert something else.
 *
 * SANITIZATION (deterministic, mirrors canonicalV2 normalization but never
 * throws — a ledger write must not be LOST because a tool put NaN in its
 * metadata): undefined/NaN/±Infinity/function/symbol → null, bigint → decimal
 * string, Date → canonical ISO, -0 → 0, arrays order-preserved. Key order is
 * irrelevant (the core sorts recursively; JSONB does not preserve order).
 */

import type { IAuditEntry } from '../../shared/types.js';
import { sanitizeMetadataValue, type LedgerCanonicalSource } from './canonicalV2.js';

// sanitizeMetadataValue lives in the VENDORED canonicalV2.ts so both writers
// share byte-identical sanitization (the closure rule depends on it).
export { sanitizeMetadataValue } from './canonicalV2.js';

/**
 * Project an IAuditEntry onto the closed v2 canonical source.
 *
 * What the epoch-2 hash attests for MCP rows: id, timestamp, operation, layer,
 * actor, correlationId, parentId, metadata, schemaVersion. Deliberately NOT
 * hashed (design §2.2/§2.3, Open Risk R-1 — signed off with the coverage-diff
 * artifact): maiLevel, status, governanceScore, gateDecision, duration,
 * errorCode/errorMessage, delegatedBy. They remain DB columns, content-attested
 * by append-only + (pending) external anchoring.
 */
export function projectAuditEntryToV2(entry: IAuditEntry): LedgerCanonicalSource {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    operation: entry.operation,
    layer: entry.layer,
    actor: entry.actor,
    correlationId: entry.correlationId ?? null,
    parentId: entry.parentId ?? null,
    metadata: sanitizeMetadataValue(entry.metadata ?? {}) as Record<string, unknown>,
  };
}
