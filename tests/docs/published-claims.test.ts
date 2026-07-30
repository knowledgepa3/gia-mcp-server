/**
 * Published-claims guard — "as advertised" is a testable property.
 *
 * The 2026-07-29 thin-client audit found the README advertising 33 tools while
 * the server served 57, a from-source install path that could not work as
 * written, and a registry manifest telling clients to authenticate with a
 * header the server rejects. Marketing copy drifted because nothing bound it
 * to the code. These tests bind it.
 *
 * The tool count is anchored to TOOL_CLASSIFICATIONS, which
 * tests/mcp/tool-classification-drift.test.ts already proves is exactly the set
 * of tools the server registers. So a README count that matches this map is a
 * count that matches reality.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CLASSIFICATIONS } from '../../src/mcp/toolClassifications.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const serverJson = JSON.parse(readFileSync(join(repoRoot, 'server.json'), 'utf8')) as {
  remotes?: Array<{ headers?: Array<{ name: string }> }>;
};
const ACTUAL_TOOL_COUNT = Object.keys(TOOL_CLASSIFICATIONS).length;

describe('README tool-count honesty', () => {
  it('every "N MCP tools" / "N tools" claim in the README equals the real tool count', () => {
    const claims = [...readme.matchAll(/(\d+)(?:\+)?\s+(?:MCP\s+)?tools\b/gi)].map(m => Number(m[1]));
    expect(claims.length, 'README should state the tool count at least once').toBeGreaterThan(0);
    const wrong = claims.filter(n => n !== ACTUAL_TOOL_COUNT);
    expect(wrong, `README advertises ${wrong.join(', ')} tools; actual is ${ACTUAL_TOOL_COUNT}`).toEqual([]);
  });

  it('the tool tables list exactly the tools that are actually registered', () => {
    // Tool names appear in tables as `| `tool_name` | description |`
    const documented = new Set(
      [...readme.matchAll(/^\|\s*`([a-z][a-z0-9_]+)`\s*\|/gim)].map(m => m[1]),
    );
    const registered = new Set(Object.keys(TOOL_CLASSIFICATIONS));
    const documentedButNotReal = [...documented].filter(n => !registered.has(n));
    const realButNotDocumented = [...registered].filter(n => !documented.has(n));
    expect(documentedButNotReal, `README documents tools that do not exist: ${documentedButNotReal.join(', ')}`).toEqual([]);
    expect(realButNotDocumented, `These registered tools are undocumented: ${realButNotDocumented.join(', ')}`).toEqual([]);
  });
});

describe('README install paths are executable as written', () => {
  it('the from-source path builds before it starts (dist/ is gitignored)', () => {
    const fromSource = readme.slice(readme.indexOf('From source'));
    const block = fromSource.slice(0, fromSource.indexOf('```', fromSource.indexOf('```') + 3));
    expect(block, 'from-source install must run the build — `npm start` alone hits MODULE_NOT_FOUND').toContain('npm run build');
  });

  it('install option numbering has no gaps', () => {
    const options = [...readme.matchAll(/^###\s+Option\s+(\d+)/gim)].map(m => Number(m[1]));
    expect(options.length).toBeGreaterThan(1);
    expect(options).toEqual(options.map((_, i) => i + 1));
  });

  it('does not advertise an unqualified Smithery package name (404s — the name must be namespaced)', () => {
    const smitheryCmds = [...readme.matchAll(/smithery[^\n]*\b(?:install|add)\s+(\S+)/gi)].map(m => m[1]);
    for (const name of smitheryCmds) {
      expect(name, `Smithery names must be namespaced (owner/package), got "${name}"`).toMatch(/\//);
    }
  });
});

describe('README examples match the real tool schemas', () => {
  it('the classify_decision example passes the argument the schema requires', () => {
    const section = readme.slice(readme.indexOf('### classify_decision'));
    const example = section.slice(0, section.indexOf('### ', 4));
    expect(example, 'classify_decision requires `domain` — an example without it returns -32602').toContain('domain');
  });

  it('the score_governance example passes the argument the schema requires', () => {
    const section = readme.slice(readme.indexOf('### score_governance'));
    const example = section.slice(0, section.indexOf('### ', 4));
    expect(example, 'score_governance requires `operation` — an example without it returns -32602').toContain('operation');
  });
});

describe('registry manifest matches what the server actually accepts', () => {
  it('declares Authorization, never x-api-key (the live endpoint rejects x-api-key)', () => {
    const headers = (serverJson.remotes ?? []).flatMap(r => r.headers ?? []).map(h => h.name.toLowerCase());
    expect(headers).not.toContain('x-api-key');
    expect(headers).toContain('authorization');
  });
});

describe('vendor neutrality', () => {
  const VENDOR_POSITIONING = /\b(?:anthropic|openai)\b/i;

  it('shipped package metadata carries no single-vendor positioning', () => {
    const pkg = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(pkg) as { description: string; keywords: string[] };
    expect(parsed.description).not.toMatch(VENDOR_POSITIONING);
    const vendorKeywords = parsed.keywords.filter(k => /^(claude|anthropic|openai|gpt|gemini|cursor|windsurf|copilot)$/i.test(k));
    expect(vendorKeywords, `vendor-brand keywords must not be used as positioning: ${vendorKeywords.join(', ')}`).toEqual([]);
  });

  it('the registry manifest describes the product without naming a model vendor', () => {
    const raw = readFileSync(join(repoRoot, 'server.json'), 'utf8');
    const parsed = JSON.parse(raw) as { title: string; description: string };
    expect(parsed.description).not.toMatch(VENDOR_POSITIONING);
    expect(parsed.title).not.toMatch(VENDOR_POSITIONING);
  });

  it('README headline positioning does not privilege one vendor', () => {
    // Client-config tables legitimately name many clients; the headline must not.
    const headline = readme.slice(0, readme.indexOf('## Install'));
    expect(headline).not.toMatch(VENDOR_POSITIONING);
  });
});
