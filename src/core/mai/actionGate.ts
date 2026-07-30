import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { classifyAction, type ActionDescriptor } from './actionRules.js';

export interface ActionGateResult {
  allowed: boolean;
  classification: MaiClassification;
  reason: string;
  auditId: string;
  gateId?: string;
}

/**
 * Enforce the deterministic action-boundary gate BEFORE a side-effecting handler runs.
 * INFORMATIONAL → allowed, logged. (MANDATORY/ADVISORY handled in a later task.)
 */
export function enforceActionGate(engine: any, action: ActionDescriptor): ActionGateResult {
  const { classification, reason } = classifyAction(action);

  const entry = engine.ledger.begin(
    `action:${action.tool}`,
    classification,
    GiaLayer.MCP,
    action.actor,
  );
  entry.addMetadata('resource', action.resource ?? null);
  entry.addMetadata('verb', action.verb ?? null);
  entry.addMetadata('actionClassification', classification);
  entry.addMetadata('actionReason', reason);

  if (classification === MaiClassification.INFORMATIONAL) {
    engine.ledger.record(entry.complete?.({}, undefined, undefined) ?? entry);
    return { allowed: true, classification, reason, auditId: entry.id };
  }

  // ADVISORY or MANDATORY — register the gate using the proven non-blocking pattern
  // from classify-decision.ts: enforce() registers synchronously inside its Promise
  // constructor, so we fire-and-forget and read the gateId straight back.
  entry.addMetadata('hasGate', true);
  void engine.gate.enforce(classification, `action:${action.tool}`, entry.id, 'isso')
    .catch(() => { /* timeout/rejection already persisted by gate.ts */ });

  const pending = engine.gate.getPendingApprovals();
  const gateId = pending.length ? pending[pending.length - 1].gateId : 'gate-pending';
  entry.addMetadata('gateId', gateId);
  engine.ledger.record(entry.complete?.({}, undefined, undefined) ?? entry);

  // MANDATORY blocks (fail-closed). ADVISORY is flagged but allowed to proceed.
  const allowed = classification === MaiClassification.ADVISORY;
  return { allowed, classification, reason, auditId: entry.id, gateId };
}
