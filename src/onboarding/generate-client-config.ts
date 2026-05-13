/**
 * @module    client-onboarding
 * @layer     TRANSPORT
 * @mai       ADVISORY — generates config with API key
 * @audit     true — onboarding events recorded
 * @owner     William J. Storey III / ACE / GIA
 *
 * Generates client connection configs for GIA governance.
 *
 * Three connection modes:
 * 1. Remote HTTP — Client connects to gia.aceadvising.com/mcp
 * 2. Local stdio — Client runs GIA MCP server locally
 * 3. Docker — Client runs GIA in their own Docker environment
 *
 * Usage:
 *   npx tsx src/onboarding/generate-client-config.ts \
 *     --client "acme-corp" \
 *     --domain "va-claims" \
 *     --mode remote
 */

import { randomBytes } from 'node:crypto';
import { type ClientProfile, type ClientTier, TIER_DEFAULTS } from '../mcp/client-registry.js';

// --- Types ---

interface ClientConfig {
  clientId: string;
  clientName: string;
  domain: string;
  apiKey: string;
  mode: 'remote' | 'local' | 'docker';
  tier: ClientTier;
  contactEmail: string;
  generatedAt: string;
}

interface MCPConfig {
  mcpServers: {
    gia: {
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
    };
  };
}

// --- Config Generators ---

function generateApiKey(): string {
  return `gia_${randomBytes(32).toString('hex')}`;
}

function generateRemoteConfig(client: ClientConfig): MCPConfig {
  // Embed the API key as a query parameter — works universally across all MCP
  // clients including Claude Web, ChatGPT, and Smithery (which don't support
  // custom headers). Claude Desktop and Claude Code also support this format.
  return {
    mcpServers: {
      gia: {
        url: `https://gia.aceadvising.com/mcp?GIA_API_KEY=${client.apiKey}`,
      },
    },
  };
}

function generateLocalConfig(_client: ClientConfig): MCPConfig {
  return {
    mcpServers: {
      gia: {
        command: 'node',
        args: ['node_modules/gia-mcp-server/dist/mcp/server.js'],
      },
    },
  };
}

function generateDockerConfig(client: ClientConfig): MCPConfig {
  return {
    mcpServers: {
      gia: {
        url: 'http://localhost:3100/mcp',
        headers: {
          Authorization: `Bearer ${client.apiKey}`,
        },
      },
    },
  };
}

// --- Client Onboarding Package ---

interface OnboardingPackage {
  config: MCPConfig;
  client: ClientConfig;
  registryEntry: ClientProfile;
  instructions: string;
}

export function generateOnboardingPackage(
  clientName: string,
  domain: string,
  mode: 'remote' | 'local' | 'docker' = 'remote',
  tier: ClientTier = 'starter',
  contactEmail: string = '',
): OnboardingPackage {
  const apiKey = generateApiKey();
  const clientId = clientName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const now = new Date().toISOString();

  const client: ClientConfig = {
    clientId,
    clientName,
    domain,
    apiKey,
    mode,
    tier,
    contactEmail,
    generatedAt: now,
  };

  // Full registry entry for GIA_CLIENT_REGISTRY env var
  const registryEntry: ClientProfile = {
    clientId,
    clientName,
    apiKey,
    domain,
    tier,
    contactEmail,
    tenantId: 'default',
    createdAt: now,
    limits: { ...TIER_DEFAULTS[tier] },
    allowedToolPrefixes: [],
  };

  const generators = {
    remote: generateRemoteConfig,
    local: generateLocalConfig,
    docker: generateDockerConfig,
  };

  const config = generators[mode](client);

  const instructions = generateInstructions(client, config);

  return { config, client, registryEntry, instructions };
}

function generateInstructions(client: ClientConfig, config: MCPConfig): string {
  const configJson = JSON.stringify(config, null, 2);

  if (client.mode === 'remote') {
    const connectionUrl = `https://gia.aceadvising.com/mcp?GIA_API_KEY=${client.apiKey}`;
    return `
# GIA Governance — Client Setup (${client.clientName})
# Domain: ${client.domain}
# Generated: ${client.generatedAt}

## Your Connection URL

\`\`\`
${connectionUrl}
\`\`\`

This URL works in ALL MCP clients — Claude Web, ChatGPT, Smithery,
Claude Desktop, and Claude Code. Your API key is embedded directly in the URL.

Keep this URL secure — it contains your API key.
Do NOT commit it to version control.

## 1. Claude Web / ChatGPT / Smithery

Paste the connection URL directly into the MCP connector field.

## 2. Claude Code

\`\`\`bash
claude mcp add gia "${connectionUrl}"
\`\`\`

Or save this as \`.mcp.json\` in your project root:

\`\`\`json
${configJson}
\`\`\`

## 3. Claude Desktop

Add to your Claude Desktop settings (Settings > Developer > MCP Servers):

\`\`\`json
${configJson}
\`\`\`

## 4. Verify Connection

Try asking:
- "Check GIA system status" — should return server version and health
- "Classify this decision: approve a loan application" — should return MAI classification

## Available Tools (33)

| Category | Example Tools |
|----------|---------------|
| Classification | classify_decision, evaluate_threshold, score_governance |
| Audit | audit_pipeline, monitor_agents, system_status, verify_ledger, export_ledger |
| Compliance | map_compliance, assess_risk_tier, generate_report |
| Gates | approve_gate, board_approve_gate |
| Memory Packs | seal, load, transfer, compose, distill, promote |
| Governed Retrieval | gia_ingest_document, gia_retrieve, governed_sample |
| Reasoning | chain_of_reasoning, board_convene_session, board_search_precedent |
| Colony | agent_citizenship_status, agent_rights, colony_health, colony_suggestion |
| Phoenix Recovery | phoenix_snapshot, phoenix_verify_integrity, phoenix_recovery_health |
| Value Metrics | record_value_metric, record_governance_event, generate_impact_report |
| SRT | srt_run_watchdog, srt_diagnose, srt_approve_repair, srt_generate_postmortem |

See full catalog: https://gia.aceadvising.com/docs
`.trim();
  }

  if (client.mode === 'local') {
    return `
# GIA Governance — Local Setup (${client.clientName})

## 1. Install GIA

\`\`\`bash
npm install gia-mcp-server
\`\`\`

## 2. Add to your project

Save this as \`.mcp.json\` in your project root:

\`\`\`json
${configJson}
\`\`\`

## 3. Verify

In Claude Code, try: "Check GIA system status"
`.trim();
  }

  return `
# GIA Governance — Docker Setup (${client.clientName})

> Until the published image lands on Docker Hub, build the container from source.
> This is a one-time build — subsequent runs reuse the local image.

## 1. Clone and build

\`\`\`bash
git clone https://github.com/knowledgepa3/gia-mcp-server.git
cd gia-mcp-server
docker build -t gia-mcp-server:local .
\`\`\`

## 2. Run GIA

\`\`\`bash
docker run -d \\
  --name gia-mcp \\
  -p 3100:3100 \\
  -e GIA_API_KEYS=${client.apiKey} \\
  gia-mcp-server:local
\`\`\`

## 3. Add to your project

Save this as \`.mcp.json\` in your project root:

\`\`\`json
${configJson}
\`\`\`

## 4. Verify

In Claude Code, try: "Check GIA system status"
`.trim();
}

// --- CLI Entry Point ---

if (process.argv[1]?.includes('generate-client-config')) {
  const args = process.argv.slice(2);
  const clientIdx = args.indexOf('--client');
  const domainIdx = args.indexOf('--domain');
  const modeIdx = args.indexOf('--mode');
  const tierIdx = args.indexOf('--tier');
  const emailIdx = args.indexOf('--email');

  const clientName = clientIdx >= 0 ? args[clientIdx + 1] : undefined;
  const domain = domainIdx >= 0 ? args[domainIdx + 1] : 'general';
  const mode = (modeIdx >= 0 ? args[modeIdx + 1] : 'remote') as 'remote' | 'local' | 'docker';
  const tier = (tierIdx >= 0 ? args[tierIdx + 1] : 'starter') as ClientTier;
  const email = emailIdx >= 0 ? args[emailIdx + 1] : '';

  if (!clientName) {
    console.error('Usage: npm run onboard -- --client <name> [--domain <domain>] [--mode remote|local|docker] [--tier starter|professional|enterprise] [--email <email>]');
    console.error('\nDomains: va-claims, federal-bd, healthcare, finance, legal, general');
    console.error('Tiers:   starter (30 req/min), professional (120 req/min), enterprise (600 req/min)');
    process.exit(1);
  }

  const pkg = generateOnboardingPackage(clientName, domain, mode, tier, email);

  console.log('='.repeat(60));
  console.log(' GIA Client Onboarding Package');
  console.log('='.repeat(60));
  console.log(`\nClient:  ${pkg.client.clientName}`);
  console.log(`ID:      ${pkg.client.clientId}`);
  console.log(`Domain:  ${pkg.client.domain}`);
  console.log(`Tier:    ${pkg.client.tier}`);
  console.log(`Mode:    ${pkg.client.mode}`);
  const maskedKey = pkg.client.apiKey.slice(0, 12) + '...';
  console.log(`Key:     ${maskedKey}`);
  console.log(`\nRate Limits:`);
  console.log(`  Requests/min:      ${pkg.registryEntry.limits.requestsPerMinute}`);
  console.log(`  Tool calls/day:    ${pkg.registryEntry.limits.toolCallsPerDay}`);
  console.log(`  Max sessions:      ${pkg.registryEntry.limits.maxConcurrentSessions}`);
  console.log(`  Monthly budget:    $${pkg.registryEntry.limits.maxMonthlyCostUsd}`);
  console.log(`\n--- .mcp.json (give to client) ---\n`);
  console.log(JSON.stringify(pkg.config, null, 2));
  console.log(`\n--- GIA_CLIENT_REGISTRY entry (add to server) ---\n`);
  console.log(JSON.stringify(pkg.registryEntry, null, 2));
  console.log(`\n--- Setup Instructions ---\n`);
  console.log(pkg.instructions);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SERVER SETUP: Add this JSON to your GIA_CLIENT_REGISTRY env var array`);
  console.log(`Or for legacy mode, add the masked key above to the GIA keys env var`);
  console.log('='.repeat(60));
}
