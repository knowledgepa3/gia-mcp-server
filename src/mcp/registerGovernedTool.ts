import { enforceActionGate as defaultGate } from '../core/mai/actionGate.js';
import type { ActionDescriptor } from '../core/mai/actionRules.js';

/**
 * Structural shape of the gate decision the wrapper consumes. Looser than
 * `ActionGateResult` (classification is a plain string) so test fakes can
 * stand in without importing the MAI enum. The real `enforceActionGate`
 * satisfies this structurally.
 */
type GateDecision = {
  allowed: boolean;
  classification: string;
  reason: string;
  auditId: string;
  gateId?: string;
};
type GateFn = (engine: any, action: ActionDescriptor) => GateDecision;

export interface GovernedToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
  /** Derive the target resource from the tool args (optional). */
  resourceOf?: (args: any) => string | undefined;
  /** Derive the verb from the tool args (optional). */
  verbOf?: (args: any) => string | undefined;
  /** Identify the actor from args (default: args.agent_name || 'SYSTEM'). */
  actorOf?: (args: any) => string;
}

/**
 * Register an MCP tool whose side effects are gated at the boundary.
 * Read-only tools (`readOnlyHint: true`) skip the gate. Everything else is
 * classified deterministically and BLOCKED if the gate denies — the handler
 * never runs without authorization.
 */
export function registerGovernedTool(
  server: any,
  engine: any,
  spec: GovernedToolSpec,
  handler: (args: any, extra?: any) => Promise<any>,
  gate: GateFn = defaultGate,
): void {
  const wrapped = async (args: any, extra?: any) => {
    if (spec.annotations.readOnlyHint === true) {
      return handler(args, extra); // read-only: no side effect, no gate
    }
    const action: ActionDescriptor = {
      actor: spec.actorOf?.(args) ?? args?.agent_name ?? 'SYSTEM',
      tool: spec.name,
      resource: spec.resourceOf?.(args),
      verb: spec.verbOf?.(args),
      destructive: spec.annotations.destructiveHint === true,
    };
    const decision = gate(engine, action);
    if (!decision.allowed) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          gateStatus: 'HOLD',
          classification: decision.classification,
          gateId: decision.gateId,
          reason: decision.reason,
          gateInstruction: `GATE HOLD: '${spec.name}' requires ${decision.classification} approval. ` +
            `Approve gate ${decision.gateId ?? '(pending)'} in GIA Console → Sanity Check, then re-invoke.`,
          auditId: decision.auditId,
        }, null, 2) }],
        isError: true,
      };
    }
    return handler(args, extra);
  };

  server.tool(spec.name, spec.description, spec.schema, spec.annotations, wrapped);
}
