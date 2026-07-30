/**
 * @module    test-runtime-accountability-wrapper
 * @layer     TEST
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Verifies that wrapServerWithRuntimeAccountability:
 *  - Calls runtimeService.startSession() once per tool invocation
 *  - Calls endSession('completed') on a successful handler return
 *  - Calls endSession('failed') when the handler returns isError: true
 *  - Calls endSession('failed') with error context when the handler throws,
 *    and re-throws the original error
 *  - Forwards non-tool property access (e.g. .connect, .resource) unchanged
 *  - Does not mutate the underlying McpServer instance
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { wrapServerWithRuntimeAccountability } from '../../src/mcp/runtime-accountability-wrapper.js';

// ──────────────────────────────────────────────────────────────────────────
// Test doubles
// ──────────────────────────────────────────────────────────────────────────

interface ServerStub {
  /** Captures the last handler registered, for direct invocation in assertions. */
  registeredHandler?: (...args: unknown[]) => unknown;
  registeredName?: string;
  tool: (name: string, description: string, schema: unknown, ...rest: unknown[]) => void;
  /** Sentinel non-tool method to verify Proxy forwarding. */
  connect: (transport: unknown) => string;
}

function makeServerStub(): ServerStub {
  const stub: ServerStub = {
    tool(name, _description, _schema, ...rest) {
      stub.registeredName = name;
      // The handler is always the LAST argument.
      const last = rest[rest.length - 1];
      if (typeof last === 'function') {
        stub.registeredHandler = last as (...args: unknown[]) => unknown;
      }
    },
    connect(transport: unknown): string {
      return `connected:${String(transport)}`;
    },
  };
  return stub;
}

interface EngineStub {
  runtimeService: {
    startSession: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
  };
}

function makeEngineStub(): EngineStub {
  return {
    runtimeService: {
      startSession: vi.fn(() => ({
        runtimeId: 'rt-test-123',
        instanceId: 'gia-test',
        environment: 'test',
        configFingerprint: 'test-hash',
      })),
      endSession: vi.fn(),
    },
  };
}

// Cast helpers — the Proxy is typed as McpServer/GovernanceEngine but our stubs
// only implement the surface the wrapper actually uses.
function wrap(server: ServerStub, engine: EngineStub): ServerStub {
  return wrapServerWithRuntimeAccountability(
    server as unknown as McpServer,
    engine as unknown as GovernanceEngine,
  ) as unknown as ServerStub;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('wrapServerWithRuntimeAccountability', () => {
  let server: ServerStub;
  let engine: EngineStub;
  let wrapped: ServerStub;

  beforeEach(() => {
    server = makeServerStub();
    engine = makeEngineStub();
    wrapped = wrap(server, engine);
  });

  describe('successful tool invocation', () => {
    it('starts a session, runs the handler, ends with completed', async () => {
      const originalHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

      wrapped.tool('score_governance', 'desc', {}, { title: 'Test' }, originalHandler);

      // Tool was registered on the underlying server with a wrapped handler
      expect(server.registeredName).toBe('score_governance');
      expect(server.registeredHandler).toBeDefined();
      expect(server.registeredHandler).not.toBe(originalHandler);

      // Invoke the wrapped handler as the SDK would
      const result = await server.registeredHandler!({ x: 1 }, { signal: undefined });

      expect(originalHandler).toHaveBeenCalledTimes(1);
      expect(originalHandler).toHaveBeenCalledWith({ x: 1 }, { signal: undefined });

      expect(engine.runtimeService.startSession).toHaveBeenCalledTimes(1);
      expect(engine.runtimeService.startSession).toHaveBeenCalledWith({
        sessionType: 'tool_invocation',
        metadata: { tool: 'score_governance' },
      });

      expect(engine.runtimeService.endSession).toHaveBeenCalledTimes(1);
      expect(engine.runtimeService.endSession).toHaveBeenCalledWith('rt-test-123', 'completed');

      // Return value is preserved exactly
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('also wraps tool() invocations with no annotations (4-arg shape)', async () => {
      const originalHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

      wrapped.tool('generate_report', 'desc', {}, originalHandler);

      await server.registeredHandler!({});

      expect(engine.runtimeService.startSession).toHaveBeenCalledTimes(1);
      expect(engine.runtimeService.endSession).toHaveBeenCalledWith('rt-test-123', 'completed');
    });
  });

  describe('handler returns isError: true', () => {
    it('ends the session as failed without throwing', async () => {
      const originalHandler = vi.fn(async () => ({
        content: [{ type: 'text', text: 'bad input' }],
        isError: true,
      }));

      wrapped.tool('record_governance_event', 'desc', {}, { title: 'Failing' }, originalHandler);
      const result = await server.registeredHandler!({});

      expect(engine.runtimeService.endSession).toHaveBeenCalledTimes(1);
      expect(engine.runtimeService.endSession).toHaveBeenCalledWith('rt-test-123', 'failed');
      expect((result as { isError?: boolean }).isError).toBe(true);
    });
  });

  describe('handler throws', () => {
    it('ends the session as failed with error context and re-throws', async () => {
      const boom = new TypeError('schema invalid');
      const originalHandler = vi.fn(async () => {
        throw boom;
      });

      wrapped.tool('assess_risk_tier', 'desc', {}, { title: 'Throwing' }, originalHandler);

      await expect(server.registeredHandler!({})).rejects.toBe(boom);

      expect(engine.runtimeService.endSession).toHaveBeenCalledTimes(1);
      expect(engine.runtimeService.endSession).toHaveBeenCalledWith('rt-test-123', 'failed', {
        message: 'schema invalid',
        code: 'TypeError',
      });
    });

    it('handles non-Error thrown values gracefully', async () => {
      const originalHandler = vi.fn(async () => {
        throw 'string-thrown';
      });

      wrapped.tool('map_compliance', 'desc', {}, { title: 'Weird' }, originalHandler);

      await expect(server.registeredHandler!({})).rejects.toBe('string-thrown');

      expect(engine.runtimeService.endSession).toHaveBeenCalledWith('rt-test-123', 'failed', {
        message: 'string-thrown',
        code: 'UNKNOWN_ERROR',
      });
    });
  });

  describe('proxy transparency', () => {
    it('forwards non-tool method calls to the underlying server', () => {
      // .connect is a non-tool method; the Proxy must forward it with correct binding.
      const result = wrapped.connect('stdio-transport');
      expect(result).toBe('connected:stdio-transport');
    });

    it('does not mutate the underlying server instance', () => {
      const originalTool = server.tool;
      wrapped.tool('classify_decision', 'd', {}, async () => ({ content: [] }));
      // The underlying server's tool method itself is unchanged.
      expect(server.tool).toBe(originalTool);
    });

    it('passes through registrations missing a function handler unchanged', () => {
      // Some SDK overloads might be called with fewer/different args. The wrapper
      // should not transform anything when the last arg is not a function.
      const malformed = ['name_only'] as unknown as [string, string, unknown, unknown];
      // Should not throw; underlying stub will simply not register a handler.
      expect(() => (wrapped.tool as unknown as (...args: unknown[]) => void)(...malformed))
        .not.toThrow();
    });
  });

  describe('session isolation', () => {
    it('produces a fresh session per invocation', async () => {
      let counter = 0;
      engine.runtimeService.startSession.mockImplementation(() => ({
        runtimeId: `rt-${++counter}`,
        instanceId: 'gia-test',
        environment: 'test',
        configFingerprint: 'test-hash',
      }));

      const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      wrapped.tool('get_gate_status', 'd', {}, { title: 'R' }, handler);

      await server.registeredHandler!({});
      await server.registeredHandler!({});
      await server.registeredHandler!({});

      expect(engine.runtimeService.startSession).toHaveBeenCalledTimes(3);
      expect(engine.runtimeService.endSession).toHaveBeenNthCalledWith(1, 'rt-1', 'completed');
      expect(engine.runtimeService.endSession).toHaveBeenNthCalledWith(2, 'rt-2', 'completed');
      expect(engine.runtimeService.endSession).toHaveBeenNthCalledWith(3, 'rt-3', 'completed');
    });
  });
});
