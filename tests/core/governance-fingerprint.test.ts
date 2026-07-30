/**
 * @module    test-governance-fingerprint
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verifies the kernel config-fingerprint VERIFICATION logic.
 *
 * The seam: the kernel computes a SHA-256 fingerprint of its governance config
 * at boot and records it, but never compares it to a pinned expected value — so
 * silent policy drift is visible only if a human inspects the ledger. This adds
 * an opt-in verifier that turns "drift is visible" into "drift alerts/halts".
 *
 * Safety: when no expected pin is configured the verifier is a no-op (cannot
 * brick boot for anyone who hasn't opted in). Mismatch alerts by default and
 * only halts when enforcement is explicitly set to 'halt'.
 */

import { describe, it, expect } from 'vitest';
import { verifyConfigFingerprint } from '../../src/core/governance.js';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

describe('verifyConfigFingerprint', () => {
  it('is a no-op when no expected fingerprint is pinned', () => {
    expect(verifyConfigFingerprint(FP_A, undefined, undefined)).toEqual({ status: 'unset' });
  });

  it('treats an empty/whitespace pin as unset (no-op)', () => {
    expect(verifyConfigFingerprint(FP_A, '   ', undefined)).toEqual({ status: 'unset' });
  });

  it('reports match when the pin equals the computed fingerprint', () => {
    expect(verifyConfigFingerprint(FP_A, FP_A, undefined)).toEqual({ status: 'match' });
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(verifyConfigFingerprint(FP_A, `  ${FP_A.toUpperCase()}  `, undefined)).toEqual({ status: 'match' });
  });

  it('reports drift WITHOUT halt by default when the pin does not match', () => {
    expect(verifyConfigFingerprint(FP_A, FP_B, undefined)).toEqual({ status: 'drift', halt: false });
  });

  it('reports drift WITH halt only when enforcement is set to halt', () => {
    expect(verifyConfigFingerprint(FP_A, FP_B, 'halt')).toEqual({ status: 'drift', halt: true });
  });

  it('does not halt for non-halt enforcement values', () => {
    expect(verifyConfigFingerprint(FP_A, FP_B, 'alert')).toEqual({ status: 'drift', halt: false });
  });
});
