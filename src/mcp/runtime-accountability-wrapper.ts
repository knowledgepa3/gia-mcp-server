/**
 * @module    runtime-accountability-wrapper
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       varies per tool â€” see toolClassifications.ts; this module ENFORCES
 *            MANDATORY gating for tools not already selfEnforces/isGateResolver
 * @audit     true â€” every tool invocation registers a runtime session; MANDATORY
 *            gate decisions are ledger-recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * Transparent Proxy that bookends every MCP tool registration with
 * `runtimeService.startSession()` / `endSession()`, AND â€” as of 2026-07-14 â€”
 * consults the central tool classification map (toolClassifications.ts) to
 * enforce MANDATORY tools before their handler runs.
 *
 * Why a Proxy at the registration layer:
 * - Single change site â€” applies to all 32+ existing tools and any future ones.
 * - No change to tool authoring patterns â€” handlers register via `server.tool()`
 *   exactly as before.
 * - No HIGH-RISK files touched (gate.ts, approve-gate.ts, server-http.ts gate
 *   logic all remain untouched).
 *
 * Gating rule (see docs/superpowers/specs/2026-07-14-mcp-tool-mai-classification-design.md):
 * - Tool name not in TOOL_CLASSIFICATIONS -> throw at REGISTRATION time (fail loud,
 *   not a silent ungated tool reaching production).
 * - `isGateResolver: true` (approve_gate, board_approve_gate, srt_approve_repair)
 *   -> never gated here; these ARE the approval action.
 * - `selfEnforces: true` (promote_memory_pack, transfer_memory_pack, gia_apply_pack,
 *   gia_run_patrol, context_revive) -> never gated here; they already call
 *   engine.gate.enforce() internally. Gating here too would double-prompt.
 * - Effective classification (via resolveClassification, handles CONDITIONAL)
 *   !== MANDATORY -> not gated, handler runs directly.
 * - Effective classification === MANDATORY -> await engine.gate.enforce();
 *   non-APPROVED returns a structured isError result WITHOUT running the handler.
 *
 * Lifecycle contract (unchanged from the original observability-only version):
 * - On `.tool()` registration the user-supplied handler is wrapped.
 * - On every invocation, `startSession()` runs first; `runtimeId` is captured.
 * - The original handler runs to completion (or throws) â€” UNLESS a MANDATORY
 *   gate blocks it first, in which case the handler never runs.
 * - If it returns `{ isError: true }` -> `endSession('failed')`.
 * - If it returns a normal result -> `endSession('completed')`.
 * - If it throws -> `endSession('failed')` with error context, then the error
 *   is re-thrown. Caller error semantics are preserved exactly.
 *
 * The wrapper never swallows errors and never alters return values (except to
 * short-circuit with a GATE_REQUIRED error result when a MANDATORY gate blocks).
 *
 * Both registration methods are intercepted: legacy `.tool()` AND its SDK
 * replacement `registerTool()` (the `.tool()` overloads are `@deprecated` as
 * of SDK 1.26). A tool registered through either path gets identical
 * classification enforcement, gating, and session bookends â€” otherwise a
 * future `registerTool()` caller would silently escape governance.
 *
 * Methods other than `.tool()`/`registerTool()` (e.g. `.connect()`,
 * `.resource()`, `.prompt()`) are forwarded to the underlying `McpServer`
 * with `this` correctly bound to the original target so SDK internals
 * continue to work.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../core/governance.js';
import { MaiClassification, GiaLayer } from '../shared/types.js';
import { TOOL_CLASSIFICATIONS, resolveClassification } from './toolClassifications.js';

type AnyFunction = (...args: unknown[]) => unknown;

/** Shape of an MCP tool result we care about. The SDK returns more fields; we only need `isError`. */
interface ToolResultLike {
  isError?: boolean;
}

/**
 * Wrap an `McpServer` instance so every `.tool()` registration is transparently
 * instrumented with the runtime accountability lifecycle AND MANDATORY gate
 * enforcement. The original server is not mutated; a Proxy is returned that
 * forwards all other access unchanged.
 *
 * @param server â€” the underlying McpServer
 * @param engine â€” the GovernanceEngine that owns the runtimeService and gate
 * @returns a Proxy that registers `server.tool()` calls with start/end session bookends + MANDATORY gating
 */
export function wrapServerWithRuntimeAccountability(
  server: McpServer,
  engine: GovernanceEngine,
): McpServer {
  /**
   * Fail loud at REGISTRATION time if a tool has no classification â€”
   * the whole point of this map is that an unclassified tool can't ship.
   */
  const requireClassification = (toolName: string) => {
    const classification = TOOL_CLASSIFICATIONS[toolName];
    if (!classification) {
      throw new Error(
        `Tool '${toolName}' is not classified in toolClassifications.ts. ` +
        `Every MCP tool must have a ratified MAI classification before it can be registered.`,
      );
    }
    return classification;
  };

  /**
   * Wrap a tool handler with MANDATORY gate enforcement + runtime session
   * bookends. Shared by both registration paths (.tool / registerTool) so
   * governance behavior is identical regardless of how the tool registered.
   */
  const instrumentHandler = (
    toolName: string,
    classification: (typeof TOOL_CLASSIFICATIONS)[string],
    originalHandler: AnyFunction,
  ): AnyFunction => {
    return async (...handlerArgs: unknown[]): Promise<unknown> => {
      const input = (handlerArgs[0] as Record<string, unknown>) ?? {};

      if (!classification.isGateResolver && !classification.selfEnforces) {
        const effective = resolveClassification(classification, input);
        if (effective === MaiClassification.MANDATORY) {
          const actor =
            (input.created_by as string) ??
            (input.approved_by as string) ??
            (input.agent_id as string) ??
            'unknown';
          const entry = engine.ledger.begin(`gate-wrapper:${toolName}`, MaiClassification.MANDATORY, GiaLayer.MCP, actor);
          entry.addMetadata('toolName', toolName);
          let gateDecision;
          try {
            gateDecision = await engine.gate.enforce(MaiClassification.MANDATORY, `mcp-tool:${toolName}`, entry.id);
          } catch (gateError) {
            const failedEntry = entry.fail(gateError instanceof Error ? gateError : new Error(String(gateError)), MaiClassification.MANDATORY);
            engine.ledger.record(failedEntry);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'GATE_REQUIRED',
                message: `${toolName} requires MANDATORY gate approval: ${gateError instanceof Error ? gateError.message : String(gateError)}`,
              }) }],
              isError: true,
            };
          }
          entry.addMetadata('gateId', gateDecision.gateId);
          entry.addMetadata('gateStatus', gateDecision.status);
          if (gateDecision.status !== 'APPROVED') {
            const failedEntry = entry.fail(new Error(`MANDATORY gate ${gateDecision.status} for ${toolName}`), MaiClassification.MANDATORY);
            engine.ledger.record(failedEntry);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'GATE_REQUIRED',
                gateId: gateDecision.gateId,
                gateStatus: gateDecision.status,
                message: `${toolName} requires MANDATORY gate approval. Use approve_gate tool with gate ID to approve.`,
              }) }],
              isError: true,
            };
          }
          const score = engine.scorer.scoreDefault(`gate-wrapper:${toolName}`);
          engine.ledger.record(entry.complete(score, { classification: MaiClassification.MANDATORY, confidence: 1.0, rationale: `${toolName} approved`, requiresGate: true }));
        }
      }

      const ctx = engine.runtimeService.startSession({
        sessionType: 'tool_invocation',
        metadata: { tool: toolName },
      });
      try {
        const result = await originalHandler(...handlerArgs);
        const isError = (result as ToolResultLike | null | undefined)?.isError === true;
        engine.runtimeService.endSession(ctx.runtimeId, isError ? 'failed' : 'completed');
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof Error ? err.name : 'UNKNOWN_ERROR';
        engine.runtimeService.endSession(ctx.runtimeId, 'failed', { message, code });
        throw err;
      }
    };
  };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool') {
        return function instrumentedTool(...args: unknown[]): unknown {
          if (args.length < 4) {
            return (target.tool as AnyFunction).apply(target, args);
          }

          const toolName = String(args[0] ?? 'unknown_tool');
          const lastIndex = args.length - 1;
          const handlerCandidate = args[lastIndex];

          if (typeof handlerCandidate !== 'function') {
            return (target.tool as AnyFunction).apply(target, args);
          }

          const classification = requireClassification(toolName);
          const wrappedHandler = instrumentHandler(toolName, classification, handlerCandidate as AnyFunction);
          const newArgs = [...args.slice(0, lastIndex), wrappedHandler];
          return (target.tool as AnyFunction).apply(target, newArgs);
        };
      }

      if (prop === 'registerTool') {
        return function instrumentedRegisterTool(...args: unknown[]): unknown {
          // registerTool(name, config, cb) â€” handler is always the last arg.
          const toolName = String(args[0] ?? 'unknown_tool');
          const lastIndex = args.length - 1;
          const handlerCandidate = args[lastIndex];

          if (typeof handlerCandidate !== 'function') {
            return (target.registerTool as AnyFunction).apply(target, args);
          }

          const classification = requireClassification(toolName);
          const wrappedHandler = instrumentHandler(toolName, classification, handlerCandidate as AnyFunction);
          const newArgs = [...args.slice(0, lastIndex), wrappedHandler];
          return (target.registerTool as AnyFunction).apply(target, newArgs);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
