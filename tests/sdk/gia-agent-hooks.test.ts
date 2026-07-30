/**
 * @module    test-gia-agent-hooks
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verifies the Door 2 (Claude Agent SDK) governance hook fail-safe posture.
 *
 * The seam: when GIA governance is UNREACHABLE (classify call throws), the
 * PreToolUse hook must NOT silently let a governed tool execute. Secure-by-
 * default means FAIL CLOSED — deny any non-bypassed tool and notify the
 * operator. Availability-over-safety is an explicit opt-in (failSafe: 'open').
 *
 * Read-only tools on the bypass list are unaffected (they never reach classify).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGiaGovernanceHooks } from '../../src/sdk/gia-agent-hooks.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

type PreToolUseResult = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

interface TestConfig {
  enforceGates?: boolean;
  failSafe?: 'closed' | 'open';
  bypassTools?: string[];
  onGateRequired?: (info: { toolName: string; classification: string; message: string }) => void;
}

function makeGate(overrides: TestConfig = {}) {
  const hooks = createGiaGovernanceHooks({
    giaUrl: 'https://gia.test.invalid',
    apiKey: 'test-key',
    domain: 'general',
    operatorId: 'test-operator',
    ...overrides,
  } as Parameters<typeof createGiaGovernanceHooks>[0]);
  // PreToolUse governance gate is the first hook in the first group.
  return hooks.PreToolUse[0].hooks[0];
}

/** Simulate GIA being unreachable — every fetch rejects. */
function stubGiaUnreachable() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED gia.test.invalid')));
}

/** Simulate GIA returning a given MAI classification. */
function stubGiaClassifies(classification: 'MANDATORY' | 'ADVISORY' | 'INFORMATIONAL') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        classification: { classification, confidence: 0.9, rationale: 'test', requiresGate: classification === 'MANDATORY' },
      }),
    }),
  );
}

const BASH = { tool_name: 'Bash', tool_input: { command: 'echo hi' } };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ──────────────────────────────────────────────────────────────────────────
// Fail-safe posture when GIA is unreachable
// ──────────────────────────────────────────────────────────────────────────

describe('Door 2 governance hook — fail-safe posture', () => {
  it('FAILS CLOSED by default: denies a non-bypassed tool when GIA is unreachable', async () => {
    stubGiaUnreachable();
    const gate = makeGate();

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('notifies the operator when it fails closed', async () => {
    stubGiaUnreachable();
    const onGateRequired = vi.fn();
    const gate = makeGate({ onGateRequired });

    await gate(BASH, 'tool-1', {});

    expect(onGateRequired).toHaveBeenCalledTimes(1);
    expect(onGateRequired.mock.calls[0][0].toolName).toBe('Bash');
  });

  it('still denies (fail-closed) even if the operator notification callback throws', async () => {
    stubGiaUnreachable();
    const gate = makeGate({
      onGateRequired: () => {
        throw new Error('notification channel down');
      },
    });

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('FAILS OPEN only when explicitly opted in (failSafe: open): allows with a warning', async () => {
    stubGiaUnreachable();
    const gate = makeGate({ failSafe: 'open' });

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(result.systemMessage).toMatch(/without gate enforcement/i);
  });

  it('does not block read-only bypass tools even when GIA is unreachable', async () => {
    stubGiaUnreachable();
    const gate = makeGate({ bypassTools: ['Read'] });

    const result = (await gate({ tool_name: 'Read', tool_input: { path: '/x' } }, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('respects advisory-only mode: enforceGates=false never blocks, even when unreachable', async () => {
    stubGiaUnreachable();
    const gate = makeGate({ enforceGates: false });

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: normal classification path still behaves correctly
// ──────────────────────────────────────────────────────────────────────────

describe('Door 2 governance hook — normal classification (regression)', () => {
  it('denies MANDATORY tools when GIA is reachable', async () => {
    stubGiaClassifies('MANDATORY');
    const gate = makeGate();

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows INFORMATIONAL tools when GIA is reachable', async () => {
    stubGiaClassifies('INFORMATIONAL');
    const gate = makeGate();

    const result = (await gate(BASH, 'tool-1', {})) as PreToolUseResult;

    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});
