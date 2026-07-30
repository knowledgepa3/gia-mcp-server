import { MaiClassification } from '../../shared/types.js';
import { MAI_PRIORITY } from './types.js';

export interface ActionDescriptor {
  /** Who is acting — agent name, role, or 'SYSTEM'. */
  actor: string;
  /** Tool or route name being invoked. */
  tool: string;
  /** Target resource, if known: a table, file, charter, 'forensic_ledger', etc. */
  resource?: string;
  /** Verb describing the effect: read | write | delete | drop | deploy | approve | execute | snapshot. */
  verb?: string;
  /** From the MCP tool annotation `destructiveHint`. */
  destructive?: boolean;
  /** Whether the output leaves the trust boundary. */
  clientFacing?: boolean;
}

export interface ActionRule {
  id: string;
  match: (a: ActionDescriptor) => boolean;
  classify: MaiClassification;
  reason: string;
}

const LEDGER_MUTATION_VERBS = new Set(['delete', 'update', 'drop', 'truncate', 'alter']);

/**
 * Deterministic, content-keyed rules. Evaluated in full; the HIGHEST matched
 * classification wins (MAI Rule 2 — context elevates, never reduces).
 */
export const ACTION_RULES: ActionRule[] = [
  {
    id: 'forensic-ledger-mutation',
    match: a => a.resource === 'forensic_ledger' && LEDGER_MUTATION_VERBS.has((a.verb ?? '').toLowerCase()),
    classify: MaiClassification.MANDATORY,
    reason: 'Mutation or deletion of the immutable forensic ledger',
  },
  {
    id: 'self-repair-execution',
    match: a => /repair|srt_approve|self_heal|remediat/i.test(a.tool) && a.verb !== 'read',
    classify: MaiClassification.MANDATORY,
    reason: 'Self-repair / remediation execution changes running system state',
  },
  {
    id: 'deploy',
    match: a => a.verb === 'deploy' || /deploy|rollout|release/i.test(a.tool),
    classify: MaiClassification.MANDATORY,
    reason: 'Deployment changes production state',
  },
  {
    id: 'charter-write',
    match: a => a.resource === 'charter' && ['write', 'delete', 'seal', 'update'].includes((a.verb ?? '').toLowerCase()),
    classify: MaiClassification.MANDATORY,
    reason: 'Charter is a runtime governance instrument — changes require approval',
  },
  {
    id: 'client-facing-output',
    match: a => a.clientFacing === true,
    classify: MaiClassification.MANDATORY,
    reason: 'Client-facing output requires human sign-off',
  },
];

export interface ActionClassification {
  classification: MaiClassification;
  reason: string;
}

/**
 * Classify an action deterministically. Same descriptor → same result, always.
 * Default is INFORMATIONAL; a `destructive` annotation with no specific rule
 * falls back to ADVISORY (fail-toward-escalation safety net).
 */
export function classifyAction(action: ActionDescriptor): ActionClassification {
  let best: ActionClassification = {
    classification: MaiClassification.INFORMATIONAL,
    reason: 'No elevation rule matched',
  };

  for (const rule of ACTION_RULES) {
    if (rule.match(action) && MAI_PRIORITY[rule.classify] > MAI_PRIORITY[best.classification]) {
      best = { classification: rule.classify, reason: rule.reason };
    }
  }

  if (
    action.destructive &&
    MAI_PRIORITY[MaiClassification.ADVISORY] > MAI_PRIORITY[best.classification]
  ) {
    best = {
      classification: MaiClassification.ADVISORY,
      reason: 'Destructive action with no specific rule — flagged for review',
    };
  }

  return best;
}
