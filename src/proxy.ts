#!/usr/bin/env node
/**
 * GIA MCP Server — Proxy
 *
 * Transparent MCP bridge that connects Claude Desktop / Claude Code
 * to the hosted GIA governance engine at gia.aceadvising.com.
 *
 * All governance logic executes server-side. This package contains
 * zero governance algorithms — it is a pure protocol relay.
 *
 * Architecture:
 *   Claude <--stdio--> this proxy <--HTTPS--> gia.aceadvising.com/mcp
 *
 * @author ACE Advising
 * @version 0.2.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.2.1';
const DEFAULT_SERVER_URL = 'https://gia.aceadvising.com/mcp';

// Result schema map — tells the SDK how to validate upstream responses
const RESULT_SCHEMAS: Record<string, unknown> = {
  'tools/list':                ListToolsResultSchema,
  'tools/call':                CallToolResultSchema,
  'resources/list':            ListResourcesResultSchema,
  'resources/read':            ReadResourceResultSchema,
  'resources/templates/list':  ListResourceTemplatesResultSchema,
  'prompts/list':              ListPromptsResultSchema,
  'prompts/get':               GetPromptResultSchema,
  'completion/complete':       CompleteResultSchema,
  'ping':                      EmptyResultSchema,
  'logging/setLevel':          EmptyResultSchema,
};

function log(msg: string): void {
  process.stderr.write(`[GIA] ${msg}\n`);
}

async function main(): Promise<void> {
  // ── Read configuration from environment ──
  const apiKey = process.env.GIA_API_KEY;
  const serverUrl = process.env.GIA_SERVER_URL || DEFAULT_SERVER_URL;

  if (!apiKey) {
    log('ERROR: GIA_API_KEY environment variable is required.');
    log('');
    log('Get your API key at https://gia.aceadvising.com');
    log('Then set it:');
    log('  export GIA_API_KEY=gia_your_key_here');
    log('');
    log('Or configure it in your Claude Desktop / Claude Code settings.');
    process.exit(1);
  }

  // ── Connect to upstream GIA server ──
  log(`Connecting to ${serverUrl}...`);

  const upstreamTransport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      },
    }
  );

  const upstream = new Client(
    { name: 'gia-mcp-proxy', version: VERSION },
    { capabilities: {} }
  );

  try {
    await upstream.connect(upstreamTransport);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: Failed to connect to GIA server: ${message}`);
    log('');
    log('Check that:');
    log('  1. Your GIA_API_KEY is valid');
    log(`  2. The server at ${serverUrl} is reachable`);
    log('  3. Your network connection is active');
    process.exit(1);
  }

  log('Connected to upstream GIA server.');

  // ── Create local stdio server ──
  // Advertise capabilities that the upstream server supports
  const local = new Server(
    { name: 'gia-mcp-server', version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // ── Bridge: forward all requests to upstream ──
  local.fallbackRequestHandler = async (request: JSONRPCRequest) => {
    const method = request.method;
    const params = request.params ?? {};
    const schema = RESULT_SCHEMAS[method];

    if (!schema) {
      throw new Error(`Unsupported method: ${method}`);
    }

    // Use the Client's generic request method to forward
    const result = await (upstream as any).request(
      { method, params },
      schema
    );

    return result;
  };

  // Forward notifications from Claude to upstream
  local.fallbackNotificationHandler = async (notification) => {
    try {
      await (upstream as any).notification({
        method: notification.method,
        params: notification.params,
      });
    } catch {
      // Notifications are fire-and-forget; don't crash on failure
    }
  };

  // ── Start stdio transport ──
  const stdioTransport = new StdioServerTransport();
  await local.connect(stdioTransport);

  log(`GIA Governance MCP Proxy v${VERSION}`);
  log(`Upstream: ${serverUrl}`);
  log('Transport: stdio <-> HTTPS');
  log('Ready.');

  // ── Graceful shutdown ──
  const shutdown = async (): Promise<void> => {
    log('Shutting down...');
    try {
      await local.close();
      await upstream.close();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Handle upstream errors ──
  upstreamTransport.onerror = (err: Error) => {
    log(`Upstream error: ${err.message}`);
  };

  upstreamTransport.onclose = () => {
    log('Upstream connection closed.');
    process.exit(1);
  };
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`FATAL: ${message}`);
  process.exit(1);
});
