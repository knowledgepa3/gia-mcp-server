/**
 * @module    canonicalV2.golden.test
 * @layer     GOVERNANCE
 * @inherits  audit-canonical-v2
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * GOLDEN-VECTOR GATE for Ledger Canonical v2 (Option A §5).
 *
 * The FROZEN canonical string + hash below pin the algorithm: ANY behavioral
 * change to canonicalizeV2/computeEntryHashV2 fails this suite, forcing the
 * epoch-bump discipline (bump V2_SCHEMA_VERSION + CHAIN_VERSION, regenerate
 * vectors, migration marker). Do NOT "fix" a red run by updating the frozen
 * string unless you are deliberately shipping a NEW epoch.
 *
 * A byte-identical twin of this suite runs in server/src/__tests__/ against
 * the vendored server copy (only the import path differs); the vendor-parity
 * test asserts the two canonicalV2.ts sources are byte-identical.
 *
 * Covers the §5.2 pitfall table: key order (top + nested), unicode/escaping,
 * number formatting (-0, float precision, 1e3), bigint/NaN/Infinity throws,
 * null-vs-undefined-vs-absent, {}≠[]≠null, array order preserved, Date↔ISO
 * collapse, timezone/precision, reserved-key depth (top-only strip), layer
 * mapping, closed-field-set (maiLevel/status/gateDecision never hashed), and
 * the cross-writer projection-equivalence oracle.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalizeV2,
  computeEntryHashV2,
  makeLedgerCanonicalEntry,
  toCanonicalTimestamp,
  mapToV2Layer,
  V2_SCHEMA_VERSION,
  CHAIN_VERSION_V2,
  type LedgerCanonicalSource,
} from '../../src/core/audit/canonicalV2.js';

const GENESIS = 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a';

function ref(overrides: Partial<LedgerCanonicalSource> = {}): LedgerCanonicalSource {
  return {
    id: 'v2-ref-001',
    timestamp: '2026-07-01T12:34:56.789Z',
    operation: 'gate_decision',
    layer: 'MCP',
    actor: 'agent:claude-lead-dev',
    correlationId: 'corr-123',
    parentId: null,
    metadata: {
      zulu: 1,
      alpha: { delta: [2, 1], bravo: 'café ☕ "quoted" \\slash' },
      nested: { chainIndex: 99, previousHash: 'keep-me' },
      negZero: -0,
      float: 0.1 + 0.2,
      undef: undefined,
    },
    ...overrides,
  };
}

// ─── FROZEN reference (generated once 2026-07-01, reviewed, frozen) ─────────
// Golden-string discipline: the hash is DERIVED from the frozen string in-test
// (sha256(GENESIS || '||' || FROZEN_CANONICAL)) — not an unverifiable literal —
// and additionally pinned to the frozen literal.
const FROZEN_CANONICAL =
  '{"actor":"agent:claude-lead-dev","correlationId":"corr-123","id":"v2-ref-001","layer":"MCP",' +
  '"metadata":{"alpha":{"bravo":"café ☕ \\"quoted\\" \\\\slash","delta":[2,1]},"float":0.30000000000000004,' +
  '"negZero":0,"nested":{"chainIndex":99,"previousHash":"keep-me"},"undef":null,"zulu":1},' +
  '"operation":"gate_decision","parentId":null,"schemaVersion":2,"timestamp":"2026-07-01T12:34:56.789Z"}';
const FROZEN_HASH = '1761dd6dc34e7d87972405a99746a9e7cb4251e4de27e08d649ecbb18347fd13';

describe('v2 golden vectors — frozen reference', () => {
  it('canonicalizeV2(ref) equals the frozen canonical string byte-for-byte', () => {
    expect(canonicalizeV2(ref())).toBe(FROZEN_CANONICAL);
  });

  it('computeEntryHashV2 equals sha256(GENESIS||frozen) AND the frozen hash literal', () => {
    const derived = createHash('sha256')
      .update(GENESIS + '||' + FROZEN_CANONICAL, 'utf8')
      .digest('hex');
    expect(computeEntryHashV2(GENESIS, ref())).toBe(derived);
    expect(derived).toBe(FROZEN_HASH);
  });

  it('epoch constants are pinned (changing them means a deliberate new epoch)', () => {
    expect(V2_SCHEMA_VERSION).toBe(2);
    expect(CHAIN_VERSION_V2).toBe(2);
    expect(FROZEN_CANONICAL).toContain('"schemaVersion":2');
  });
});

describe('v2 golden vectors — key ordering', () => {
  it('nested metadata key insertion order is irrelevant (recursive sort)', () => {
    const a = ref({ metadata: { z: 1, a: { y: 1, b: 2 } } });
    const b = ref({ metadata: { a: { b: 2, y: 1 }, z: 1 } });
    expect(canonicalizeV2(a)).toBe(canonicalizeV2(b));
  });
});

describe('v2 golden vectors — numbers', () => {
  it('-0 collapses to 0; integer-valued floats serialize as integers', () => {
    expect(canonicalizeV2(ref({ metadata: { n: -0 } }))).toBe(canonicalizeV2(ref({ metadata: { n: 0 } })));
    expect(canonicalizeV2(ref({ metadata: { n: 1.0 } }))).toBe(canonicalizeV2(ref({ metadata: { n: 1 } })));
    expect(canonicalizeV2(ref({ metadata: { n: 1e3 } }))).toContain('"n":1000');
  });

  it('float precision is preserved exactly (no rounding in the canonical form)', () => {
    expect(canonicalizeV2(ref({ metadata: { n: 0.1 + 0.2 } }))).toContain('"n":0.30000000000000004');
  });

  it('bigint / NaN / Infinity throw — never silently vary', () => {
    expect(() => canonicalizeV2(ref({ metadata: { n: BigInt(1) as unknown as number } }))).toThrow(/bigint/);
    expect(() => canonicalizeV2(ref({ metadata: { n: NaN } }))).toThrow(/non-finite/);
    expect(() => canonicalizeV2(ref({ metadata: { n: Infinity } }))).toThrow(/non-finite/);
  });
});

describe('v2 golden vectors — null / undefined / absent', () => {
  it('correlationId undefined, null, and absent all hash identically (emitted as null)', () => {
    const asUndefined = canonicalizeV2(ref({ correlationId: undefined }));
    const asNull = canonicalizeV2(ref({ correlationId: null }));
    const base = ref();
    delete (base as unknown as Record<string, unknown>).correlationId;
    const asAbsent = canonicalizeV2(base);
    expect(asUndefined).toBe(asNull);
    expect(asNull).toBe(asAbsent);
    expect(asNull).toContain('"correlationId":null');
  });

  it('nested metadata {x:undefined} hashes identically to {x:null} — and differently from {}', () => {
    const asUndefined = canonicalizeV2(ref({ metadata: { x: undefined } }));
    const asNull = canonicalizeV2(ref({ metadata: { x: null } }));
    const asAbsent = canonicalizeV2(ref({ metadata: {} }));
    expect(asUndefined).toBe(asNull);
    expect(asUndefined).not.toBe(asAbsent);
  });

  it('{} vs [] vs null are three distinct canonical forms', () => {
    const obj = canonicalizeV2(ref({ metadata: { v: {} } }));
    const arr = canonicalizeV2(ref({ metadata: { v: [] } }));
    const nul = canonicalizeV2(ref({ metadata: { v: null } }));
    expect(obj).not.toBe(arr);
    expect(arr).not.toBe(nul);
    expect(nul).not.toBe(obj);
  });
});

describe('v2 golden vectors — arrays', () => {
  it('array element ORDER is data — [1,2] ≠ [2,1]', () => {
    expect(canonicalizeV2(ref({ metadata: { a: [1, 2] } }))).not.toBe(
      canonicalizeV2(ref({ metadata: { a: [2, 1] } }))
    );
  });

  it('objects INSIDE arrays are still key-sorted', () => {
    expect(canonicalizeV2(ref({ metadata: { a: [{ b: 1, a: 2 }] } }))).toBe(
      canonicalizeV2(ref({ metadata: { a: [{ a: 2, b: 1 }] } }))
    );
  });
});

describe('v2 golden vectors — timestamps', () => {
  it('a Date and its ISO string collapse to one canonical form', () => {
    const asDate = canonicalizeV2(ref({ timestamp: new Date('2026-07-01T12:34:56.789Z') }));
    const asString = canonicalizeV2(ref({ timestamp: '2026-07-01T12:34:56.789Z' }));
    expect(asDate).toBe(asString);
  });

  it('non-UTC offsets collapse to UTC (no +02:00 vs Z drift)', () => {
    const offset = canonicalizeV2(ref({ timestamp: '2026-07-01T14:34:56.789+02:00' }));
    const utc = canonicalizeV2(ref({ timestamp: '2026-07-01T12:34:56.789Z' }));
    expect(offset).toBe(utc);
  });

  it('Date values nested in metadata are normalized too', () => {
    const asDate = canonicalizeV2(ref({ metadata: { at: new Date('2026-07-01T00:00:00.000Z') } }));
    const asString = canonicalizeV2(ref({ metadata: { at: '2026-07-01T00:00:00.000Z' } }));
    expect(asDate).toBe(asString);
  });

  it('unparseable timestamps throw', () => {
    expect(() => toCanonicalTimestamp('not-a-time')).toThrow(/unparseable/);
  });
});

describe('v2 golden vectors — reserved-key depth (R-5)', () => {
  it('top-level entryHash/previousHash/chainIndex never influence the preimage', () => {
    const clean = canonicalizeV2(ref());
    const dirty = canonicalizeV2({
      ...ref(),
      entryHash: 'X',
      previousHash: 'Y',
      chainIndex: 999,
    } as unknown as LedgerCanonicalSource);
    expect(dirty).toBe(clean);
  });

  it('NESTED metadata.chainIndex/previousHash are PRESERVED (not silently deleted)', () => {
    const withNested = canonicalizeV2(ref({ metadata: { nested: { chainIndex: 99, previousHash: 'keep-me' } } }));
    const withoutNested = canonicalizeV2(ref({ metadata: { nested: {} } }));
    expect(withNested).toContain('"chainIndex":99');
    expect(withNested).toContain('"previousHash":"keep-me"');
    expect(withNested).not.toBe(withoutNested);
  });
});

describe('v2 golden vectors — closed field set + layer map', () => {
  it('maiLevel/status/gateDecision/governanceScore top-level keys are NOT hashed (excluded by design)', () => {
    const clean = canonicalizeV2(ref());
    const withExcluded = canonicalizeV2({
      ...ref(),
      maiLevel: 'MANDATORY',
      status: 'FAILED',
      gateDecision: { status: 'APPROVED' },
      governanceScore: { composite: 0.99 },
    } as unknown as LedgerCanonicalSource);
    expect(withExcluded).toBe(clean);
    expect(clean).not.toContain('maiLevel');
    expect(clean).not.toContain('gateDecision');
  });

  it('unknown layers map to CORE; valid layers pass through (idempotent)', () => {
    expect(mapToV2Layer('PLATFORM')).toBe('CORE');
    expect(mapToV2Layer('tenant')).toBe('CORE');
    expect(mapToV2Layer('MCP')).toBe('MCP');
    expect(mapToV2Layer('CORE')).toBe('CORE');
    expect(canonicalizeV2(ref({ layer: 'PLATFORM' }))).toBe(canonicalizeV2(ref({ layer: 'CORE' })));
  });

  it('type violations throw at the projection boundary', () => {
    expect(() => makeLedgerCanonicalEntry({ ...ref(), id: '' })).toThrow(/id/);
    expect(() => makeLedgerCanonicalEntry({ ...ref(), correlationId: 5 as unknown as string })).toThrow(/correlationId/);
    expect(() => makeLedgerCanonicalEntry({ ...ref(), metadata: [] as unknown as Record<string, unknown> })).toThrow(/metadata/);
  });
});

describe('v2 golden vectors — cross-writer projection equivalence (the oracle that catches divergence)', () => {
  it('the same logical event projected from an IAuditEntry-like and a SignedAuditEntry-like source hashes identically', () => {
    // MCP-side shape: Date timestamp, operation, metadata.
    const fromMcp: LedgerCanonicalSource = {
      id: 'evt-777',
      timestamp: new Date('2026-07-01T09:00:00.500Z'),
      operation: 'context_request',
      layer: 'MCP',
      actor: 'agent:builder-3',
      correlationId: 'sess-42',
      parentId: 'evt-776',
      metadata: { tool: 'gia_retrieve', outcome: { allowed: true, scope: ['docs'] } },
    };
    // Express-side shape: ISO-string timestamp, action→operation, payload→metadata,
    // free-text resource.type layer (maps to CORE ≠ MCP — so pin layer explicitly
    // to the same plane, as the mappers do for same-plane events).
    const fromExpress: LedgerCanonicalSource = {
      id: 'evt-777',
      timestamp: '2026-07-01T09:00:00.500Z',
      operation: 'context_request',
      layer: 'MCP',
      actor: 'agent:builder-3',
      correlationId: 'sess-42',
      parentId: 'evt-776',
      metadata: { outcome: { scope: ['docs'], allowed: true }, tool: 'gia_retrieve' },
    };
    expect(computeEntryHashV2(GENESIS, fromMcp)).toBe(computeEntryHashV2(GENESIS, fromExpress));
  });
});
