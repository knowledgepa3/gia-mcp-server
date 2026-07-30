import { describe, it, expect, vi } from 'vitest';
import { GovernedSampling } from '../../src/core/sampling/governed-sampling.js';
import { SAMPLING_OP_REQUESTED } from '../../src/shared/constants.js';
import type { GovernanceEngine } from '../../src/core/governance.js';

/**
 * Truth-map finding #3: the governed-sampling SUCCESS path recorded a hardcoded
 * {integrity:0.95, accuracy:0.85, compliance:0.90} triple via scorer.score(),
 * marked scored:true — a fabricated measurement permanently written to the
 * immutable forensic ledger. The model output is never independently scored,
 * so the honest result is NOT-SCORED (scored:false), matching the deny path.
 */

function makeEntry() {
  return {
    id: 'entry-sample-1',
    addMetadata: vi.fn(),
    fail: vi.fn(() => ({ id: 'entry-sample-1', status: 'FAILED' })),
    complete: vi.fn((score: unknown) => ({ id: 'entry-sample-1', status: 'COMPLETED', score })),
  };
}

function makeEngine() {
  const score = vi.fn();
  const scoreDefault = vi.fn(() => ({
    integrity: -1, accuracy: -1, compliance: -1, composite: -1,
    weights: {}, timestamp: '', scoredBy: 'governance-scorer-not-scored', scored: false,
  }));
  const engine = {
    ledger: { begin: vi.fn(() => makeEntry()), record: vi.fn() },
    classifier: { classify: vi.fn(() => ({ classification: 'ADVISORY', confidence: 1, rationale: 'ok', requiresGate: false })) },
    thresholdMonitor: { record: vi.fn() },
    gate: { enforce: vi.fn() },
    scorer: { score, scoreDefault },
    telemetryService: { emitToolCall: vi.fn() },
  } as unknown as GovernanceEngine;
  return { engine, score, scoreDefault };
}

const fakeServerRef = {
  createMessage: vi.fn(async () => ({
    content: { type: 'text', text: 'a governed answer' },
    model: 'claude-test',
    stopReason: 'end_turn',
  })),
} as unknown as ConstructorParameters<typeof GovernedSampling>[1];

const baseRequest = {
  purpose: 'analysis',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
} as unknown as Parameters<GovernedSampling['sample']>[0];

describe('governed sampling — success path must NOT fabricate governance scores', () => {
  it('records a NOT-SCORED result (scored:false), never the hardcoded 0.95/0.85/0.90 triple', async () => {
    const { engine, score, scoreDefault } = makeEngine();
    const sampling = new GovernedSampling(engine, fakeServerRef);

    const result = await sampling.sample(baseRequest);

    // The fabricated measurement path must be gone.
    expect(score).not.toHaveBeenCalled();
    expect(scoreDefault).toHaveBeenCalledWith(SAMPLING_OP_REQUESTED);
    expect(result.score.scored).toBe(false);
    expect(result.score.integrity).not.toBe(0.95);
    expect(result.score.accuracy).not.toBe(0.85);
    expect(result.score.compliance).not.toBe(0.9);
  });
});
