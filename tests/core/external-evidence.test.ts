/**
 * @module    external-evidence.test
 * @layer     GOVERNANCE
 * @inherits  external-evidence
 * @mai       N/A — test suite
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * MIR EXTERNAL-EVIDENCE SEAM (authorized by William 2026-07-02).
 * Pins the composition contract from the GIA+MIR boundary agreement:
 *   - MIR (or any provider) supplies EVIDENCE; GIA's classifier/gate DECIDES.
 *   - Deterministic mapping: DENY/contested/STEP_UP -> MANDATORY,
 *     LIMIT/flagged -> ADVISORY, ALLOW/clean -> no change.
 *   - Context elevates, NEVER reduces (MAI Rule 2) — ALLOW cannot downgrade.
 *   - FAIL-SAFE: no signal (provider disabled/unreachable/null) -> context
 *     unchanged. "Absence of history is not treated as risk" — both sides'
 *     stated principle.
 *   - Provider is config-gated OFF by default; the stub NEVER fabricates a
 *     signal (no-simulated-data rule). Live transport lands post-NDA.
 *   - Receipts: chain-head receipt builder for the independent-witness
 *     experiment (R-6b counterparty anchoring); default sink is explicitly
 *     NOT_CONFIGURED and never throws.
 */
import { describe, it, expect } from 'vitest';
import { MaiClassification } from '../../src/shared/types.js';
import { MaiClassifier } from '../../src/core/mai/classifier.js';
import type { IClassificationContext } from '../../src/core/mai/types.js';
import {
  applyExternalEvidence,
  type IExternalEvidenceSignal,
} from '../../src/core/evidence/externalEvidence.js';
import { createMirEvidenceProvider } from '../../src/core/evidence/mirProvider.js';
import {
  buildChainHeadReceipt,
  NullReceiptSink,
} from '../../src/core/evidence/receiptEmitter.js';

function baseContext(): IClassificationContext {
  return {
    operation: 'test-op',
    inputSensitivity: 'PUBLIC',
    outputAudience: 'INTERNAL',
    hasFinancialImpact: false,
    hasLegalImpact: false,
    piiDetected: false,
  };
}

function signal(overrides: Partial<IExternalEvidenceSignal> = {}): IExternalEvidenceSignal {
  return {
    provider: 'MIR',
    entityRef: 'a'.repeat(64),
    tier: 2,
    claimStatus: 'clean',
    recommendation: 'ALLOW',
    retrievedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyExternalEvidence — fail-safe context stamping', () => {
  it('null signal returns the context unchanged (absence of history is not risk)', () => {
    const ctx = baseContext();
    const out = applyExternalEvidence(ctx, null);
    expect(out).toEqual(ctx);
    expect(out.externalEvidence).toBeUndefined();
  });

  it('a signal is stamped onto a NEW context object (input not mutated)', () => {
    const ctx = baseContext();
    const out = applyExternalEvidence(ctx, signal({ claimStatus: 'contested', recommendation: 'STEP_UP' }));
    expect(ctx.externalEvidence).toBeUndefined();
    expect(out.externalEvidence).toMatchObject({ provider: 'MIR', claimStatus: 'contested', recommendation: 'STEP_UP' });
  });
});

describe('classifier — external-evidence elevation rules (deterministic)', () => {
  const classifier = new MaiClassifier();

  const cases: Array<[string, Partial<IExternalEvidenceSignal>, MaiClassification]> = [
    ['DENY recommendation elevates to MANDATORY', { recommendation: 'DENY', claimStatus: 'clean' }, MaiClassification.MANDATORY],
    ['STEP_UP recommendation elevates to MANDATORY', { recommendation: 'STEP_UP', claimStatus: 'clean' }, MaiClassification.MANDATORY],
    ['contested claim status elevates to MANDATORY regardless of recommendation', { recommendation: 'ALLOW', claimStatus: 'contested' }, MaiClassification.MANDATORY],
    ['LIMIT recommendation elevates to ADVISORY', { recommendation: 'LIMIT', claimStatus: 'clean' }, MaiClassification.ADVISORY],
    ['flagged claim status elevates to ADVISORY', { recommendation: 'ALLOW', claimStatus: 'flagged' }, MaiClassification.ADVISORY],
  ];

  for (const [name, sig, expected] of cases) {
    it(name, () => {
      const ctx = applyExternalEvidence(baseContext(), signal(sig));
      const result = classifier.classify('test-op', MaiClassification.INFORMATIONAL, ctx);
      expect(result.classification).toBe(expected);
      expect(result.elevationReason).toBeTruthy();
    });
  }

  it('ALLOW + clean does NOT elevate (stays at base level)', () => {
    const ctx = applyExternalEvidence(baseContext(), signal());
    const result = classifier.classify('test-op', MaiClassification.INFORMATIONAL, ctx);
    expect(result.classification).toBe(MaiClassification.INFORMATIONAL);
  });

  it('evidence NEVER reduces — a MANDATORY base stays MANDATORY even on ALLOW/clean (MAI Rule 2)', () => {
    const ctx = applyExternalEvidence(baseContext(), signal());
    const result = classifier.classify('test-op', MaiClassification.MANDATORY, ctx);
    expect(result.classification).toBe(MaiClassification.MANDATORY);
  });

  it('no evidence on the context leaves classification at base (fail-safe)', () => {
    const result = classifier.classify('test-op', MaiClassification.INFORMATIONAL, baseContext());
    expect(result.classification).toBe(MaiClassification.INFORMATIONAL);
  });
});

describe('MIR provider — config-gated OFF, never fabricates', () => {
  it('is disabled by default and fetchSignal resolves null without throwing', async () => {
    const provider = createMirEvidenceProvider({});
    expect(provider.name).toBe('MIR');
    expect(provider.enabled).toBe(false);
    await expect(provider.fetchSignal('entity-1')).resolves.toBeNull();
  });

  it('enabled-but-unimplemented transport still resolves null (fail-safe, no simulated signals)', async () => {
    const provider = createMirEvidenceProvider({ enabled: true, endpoint: 'https://example.invalid/mir' });
    expect(provider.enabled).toBe(true);
    await expect(provider.fetchSignal('entity-1')).resolves.toBeNull();
  });
});

describe('chain-head receipts — independent witness experiment', () => {
  it('builds a versioned receipt from a valid chain head', () => {
    const head = 'b'.repeat(64);
    const r = buildChainHeadReceipt({ instanceId: 'gia-prod-1', headHash: head, chainIndex: 24916 });
    expect(r).toMatchObject({ receiptVersion: 1, instanceId: 'gia-prod-1', headHash: head, chainIndex: 24916 });
    expect(typeof r.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(r.generatedAt))).toBe(false);
  });

  it('rejects a non-sha256 head hash (never emit a malformed receipt)', () => {
    expect(() => buildChainHeadReceipt({ instanceId: 'gia-prod-1', headHash: 'not-a-hash', chainIndex: 1 })).toThrow(/64-char/i);
  });

  it('rejects a negative chain index', () => {
    expect(() => buildChainHeadReceipt({ instanceId: 'gia-prod-1', headHash: 'c'.repeat(64), chainIndex: -1 })).toThrow(/chainIndex/i);
  });

  it('NullReceiptSink reports NOT_CONFIGURED and never throws', async () => {
    const sink = new NullReceiptSink();
    const r = buildChainHeadReceipt({ instanceId: 'gia-prod-1', headHash: 'd'.repeat(64), chainIndex: 5 });
    const outcome = await sink.deliver(r);
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toBe('NOT_CONFIGURED');
  });
});
