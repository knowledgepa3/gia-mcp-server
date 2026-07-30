/**
 * @module    mir-provider
 * @layer     GOVERNANCE
 * @inherits  external-evidence
 * @mai       N/A — evidence transport; classification happens in MaiClassifier
 * @audit     false — fetches are read-only; the consuming classification is audited
 * @owner     William J. Storey III / ACE / GIA
 *
 * MIR evidence provider — CONFIG-GATED, OFF BY DEFAULT.
 *
 * Status (2026-07-02): the GIA-side seam is built and tested; the live MIR
 * transport is INTENTIONALLY not implemented. It lands only after:
 *   1. the mutual NDA is executed,
 *   2. MIR answers the record-integrity question (is its event store
 *      append-only/tamper-evident — the load-bearing diligence question), and
 *   3. the real MIR API schema is in hand (design-partner account).
 * Until then fetchSignal resolves null — fail-safe, and NEVER a fabricated
 * signal (no-simulated-data rule: evidence must come from real provider state).
 */

import type { IExternalEvidenceProvider, IExternalEvidenceSignal } from './externalEvidence.js';

export interface IMirProviderConfig {
  /** Master switch. Default false — enabling is a deliberate operator act. */
  enabled?: boolean;
  /** MIR API endpoint (design-partner account). Unset = provider stays inert. */
  endpoint?: string;
  /** Fetch timeout budget; on expiry the provider resolves null (fail-safe). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;

export function createMirEvidenceProvider(config: IMirProviderConfig): IExternalEvidenceProvider {
  const enabled = config.enabled === true;
  const endpoint = config.endpoint?.trim() || undefined;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  void timeoutMs; // consumed by the live transport when it lands (post-NDA)

  return {
    name: 'MIR',
    enabled,
    async fetchSignal(_entityRef: string): Promise<IExternalEvidenceSignal | null> {
      if (!enabled || !endpoint) return null;
      // Live transport intentionally unimplemented pre-NDA (see module header).
      // Fail-safe null — never fabricate a tier/claim/recommendation.
      return null;
    },
  };
}
