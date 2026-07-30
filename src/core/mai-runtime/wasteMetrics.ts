import type { EvaluationResult } from './types.js';

// ============================================================================
// Deterministic waste tally. Reports only what can be counted without judgment:
// denied spawns, invalid completions, over-budget stops, advisories, and the
// tokens that would have been spent on denied actions (the savings we can
// defend). No "usefulness %" — that is not deterministic (spec §4).
// ============================================================================

export interface WasteSummary {
  totalEvaluated: number;
  totalDenied: number;
  deniedSpawns: number;
  invalidCompletions: number;
  overBudgetStops: number;
  advisories: number;
  /** sum of tokensEstimated across DENIED actions — deterministic savings */
  tokensSavedEstimate: number;
}

export function summarizeWaste(results: readonly EvaluationResult[]): WasteSummary {
  const summary: WasteSummary = {
    totalEvaluated: results.length,
    totalDenied: 0,
    deniedSpawns: 0,
    invalidCompletions: 0,
    overBudgetStops: 0,
    advisories: 0,
    tokensSavedEstimate: 0,
  };

  for (const r of results) {
    if (r.mai === 'ADVISORY') summary.advisories += 1;
    if (r.verdict !== 'DENY') continue;

    summary.totalDenied += 1;
    summary.tokensSavedEstimate += r.evidence.tokensEstimated ?? 0;
    if (r.gate === 'delegation') summary.deniedSpawns += 1;
    else if (r.gate === 'completion') summary.invalidCompletions += 1;
    else if (r.gate === 'budget') summary.overBudgetStops += 1;
  }

  return summary;
}
