/**
 * @module    runtime-accountability-wrapper
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — observability instrumentation, no governance decision
 * @audit     true — every tool invocation registers a runtime session
 * @owner     William J. Storey III / ACE / GIA
 *
 * Transparent Proxy that bookends every MCP tool registration with
 * `runtimeService.startSession()` / `endSession()` so the runtime
 * accountability counters populate for every governed tool invocation.
 *
 * Why a Proxy at the registration layer:
 * - Single change site — applies to all 32+ existing tools and any future ones.
 * - No change to tool authoring patterns — handlers register via `server.tool()`
 *   exactly as before.
 * - No HIGH-RISK files touched (gate.ts, approve-gate.ts, server-http.ts gate
 *   logic all remain untouched).
 *
 * Lifecycle contract:
 * - On `.tool()` registration the user-supplied handler is wrapped.
 * - On every invocation, `startSession()` runs first; `runtimeId` is captured.
 * - The original handler runs to completion (or throws).
 * - If it returns `{ isError: true }` → `endSession('failed')`.
 * - If it returns a normal result → `endSession('completed')`.
 * - If it throws → `endSession('failed')` with error context, then the error
 *   is re-thrown. Caller error semantics are preserved exactly.
 *
 * The wrapper never swallows errors and never alters return values.
 *
 * Methods other than `.tool()` (e.g. `.connect()`, `.resource()`, `.prompt()`)
 * are forwarded to the underlying `McpServer` with `this` correctly bound to
 * the original target so SDK internals continue to work.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../core/governance.js';

type AnyFunction = (...args: unknown[]) => unknown;

/** Shape of an MCP tool result we care about. The SDK returns more fields; we only need `isError`. */
interface ToolResultLike {
  isError?: boolean;
}

/**
 * Wrap an `McpServer` instance so every `.tool()` registration is transparently
 * instrumented with the runtime accountability lifecycle. The original server
 * is not mutated; a Proxy is returned that forwards all other access unchanged.
 *
 * @param server — the underlying McpServer
 * @param engine — the GovernanceEngine that owns the runtimeService
 * @returns a Proxy that registers `server.tool()` calls with start/end session bookends
 */
export function wrapServerWithRuntimeAccountability(
  server: McpServer,
  engine: GovernanceEngine,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'tool') {
        // Forward everything else. Bind methods to the original target so that
        // SDK internals using `this` resolve correctly through the Proxy.
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      // Intercept `.tool()`. Wrap the handler (which is always the LAST argument
      // in the SDK's `tool(name, description, schema, [annotations,] handler)` shapes).
      return function instrumentedTool(...args: unknown[]): unknown {
        // Defensive: tool() requires at least 4 args. If fewer, hand back to SDK
        // unchanged so it produces its own error.
        if (args.length < 4) {
          return (target.tool as AnyFunction).apply(target, args);
        }

        const toolName = String(args[0] ?? 'unknown_tool');
        const lastIndex = args.length - 1;
        const handlerCandidate = args[lastIndex];

        // Only wrap if the last arg is actually a function (the handler).
        if (typeof handlerCandidate !== 'function') {
          return (target.tool as AnyFunction).apply(target, args);
        }

        const originalHandler = handlerCandidate as AnyFunction;

        // Replacement handler: start session → invoke original → end session.
        const wrappedHandler: AnyFunction = async (...handlerArgs: unknown[]): Promise<unknown> => {
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

        const newArgs = [...args.slice(0, lastIndex), wrappedHandler];
        return (target.tool as AnyFunction).apply(target, newArgs);
      };
    },
  });
}
