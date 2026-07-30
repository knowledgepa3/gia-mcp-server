/**
 * The structural "a tool cannot ship unclassified" guarantee. Spins up every
 * real registration function against a stub server (no DB, no network) and
 * asserts the resulting tool-name set is EXACTLY the classification map's key
 * set — not a subset, not a superset. This is what makes toolClassifications.ts
 * trustworthy as documentation: it can't silently go stale.
 */
import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../src/core/governance.js';
import { TOOL_REGISTRY } from '../../src/mcp/toolRegistry.js';
import { registerGovernedRetrievalTools } from '../../src/mcp/tools/governed-retrieval.js';
import { TOOL_CLASSIFICATIONS } from '../../src/mcp/toolClassifications.js';

function collectRegisteredNames(register: (server: McpServer, engine: GovernanceEngine) => void): string[] {
  const names: string[] = [];
  const stub = {
    tool: (...args: unknown[]) => { names.push(String(args[0])); },
  } as unknown as McpServer;
  register(stub, {} as GovernanceEngine);
  return names;
}

describe('tool classification drift guard', () => {
  it('every tool registered by TOOL_REGISTRY + governed retrieval + list_available_tools has exactly one classification entry, and vice versa', () => {
    const registered = new Set<string>();
    for (const entry of TOOL_REGISTRY) {
      for (const name of collectRegisteredNames(entry.register)) registered.add(name);
    }
    for (const name of collectRegisteredNames((s) => registerGovernedRetrievalTools(s))) registered.add(name);
    // list_available_tools is registered inline in createMcpServer (not via TOOL_REGISTRY,
    // not DB-dependent) — it's a fixed, always-present introspection tool.
    registered.add('list_available_tools');

    const classified = new Set(Object.keys(TOOL_CLASSIFICATIONS));

    const missingClassification = [...registered].filter(n => !classified.has(n));
    const classifiedButNotRegistered = [...classified].filter(n => !registered.has(n));

    expect(missingClassification, `These registered tools have NO classification entry: ${missingClassification.join(', ')}`).toEqual([]);
    expect(classifiedButNotRegistered, `These classified tools are NOT actually registered anywhere: ${classifiedButNotRegistered.join(', ')}`).toEqual([]);
  });
});
