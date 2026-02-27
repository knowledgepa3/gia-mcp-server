# GIA MCP Server

[![npm version](https://img.shields.io/npm/v/gia-mcp-server)](https://www.npmjs.com/package/gia-mcp-server)
[![License](https://img.shields.io/badge/license-proprietary-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple)](https://modelcontextprotocol.io)

**Governance Intelligence Architecture** — the governance layer for Claude AI agents.

This package connects [Claude Desktop](https://claude.ai/download) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to the hosted GIA governance engine, giving your AI workflows enterprise-grade governance: decision classification, forensic audit trails, human-in-the-loop gates, compliance mapping, and more.

Built on Anthropic's [Model Context Protocol](https://modelcontextprotocol.io).

<a href="https://glama.ai/mcp/servers/@knowledgepa3/gia-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@knowledgepa3/gia-mcp-server/badge" alt="GIA Server MCP server" />
</a>

## Why GIA?

AI agents are powerful — but **ungoverned AI agents are a liability**. GIA solves this by providing:

- **Decision Classification** — Every AI decision is classified as Mandatory (human required), Advisory (human optional), or Informational (agent autonomous)
- **Forensic Audit Trail** — Hash-chained, tamper-evident ledger of every operation, decision, and gate approval
- **Human-in-the-Loop Gates** — High-impact actions require explicit human approval before execution
- **Compliance Mapping** — Map governance controls to NIST AI RMF, EU AI Act, ISO 42001, and NIST 800-53
- **Governed Memory** — Hash-sealed knowledge packs with trust levels, TTL, and role-based access

GIA is the governance layer that makes Claude deployments enterprise-ready.

## Quick Start

### 1. Get an API Key

Visit [gia.aceadvising.com](https://gia.aceadvising.com) to create an account and generate an API key.

### 2. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gia": {
      "command": "npx",
      "args": ["-y", "gia-mcp-server"],
      "env": {
        "GIA_API_KEY": "gia_your_api_key_here"
      }
    }
  }
}
```

### 3. Configure Claude Code

```bash
claude mcp add gia -- npx -y gia-mcp-server
```

Then set your API key in your environment:

```bash
export GIA_API_KEY=gia_your_api_key_here
```

## How It Works

```
Claude Desktop/Code  <--stdio-->  gia-mcp-server  <--HTTPS-->  gia.aceadvising.com
     (MCP Client)                  (this package)               (Governance Engine)
```

This package is a lightweight proxy. All governance logic runs on the hosted GIA server — nothing is computed locally. When you add new tools or capabilities on the server, they appear automatically without updating this package.

## Available Tools

### Governance Core
| Tool | Description |
|------|-------------|
| `classify_decision` | Classify an AI agent decision using the MAI Framework |
| `score_governance` | Compute weighted governance score from integrity, accuracy, and compliance values |
| `evaluate_threshold` | Compute the Storey Threshold — governance health metric |
| `assess_risk_tier` | Assess AI system risk tier with governance recommendations |
| `map_compliance` | Map governance components to regulatory compliance frameworks |
| `approve_gate` | Approve or reject a pending mandatory gate decision (human-in-the-loop) |

### Audit & Monitoring
| Tool | Description |
|------|-------------|
| `audit_pipeline` | Query the hash-chained forensic audit ledger |
| `verify_ledger` | Verify integrity of the audit ledger hash chain |
| `generate_report` | Generate a governance status report |
| `system_status` | Get full system health and configuration |
| `monitor_agents` | Monitor status and health of governed AI agents |

### Governed Memory Packs
| Tool | Description |
|------|-------------|
| `seal_memory_pack` | Create a hash-sealed Governed Memory Pack |
| `load_memory_pack` | Load a memory pack into agent context with validation |
| `transfer_memory_pack` | Transfer a memory pack between agents via governed corridor |
| `compose_memory_packs` | Compose multiple memory packs into a unified context |
| `distill_memory_pack` | Distill governance patterns from usage history |
| `promote_memory_pack` | Promote a memory pack to a higher trust level |

### Site Reliability
| Tool | Description |
|------|-------------|
| `srt_run_watchdog` | Submit health check results to the SRT Watchdog |
| `srt_diagnose` | Run diagnostician on an incident |
| `srt_approve_repair` | Approve or reject a pending repair plan |
| `srt_generate_postmortem` | Generate a structured postmortem report |

### Infrastructure Operations
| Tool | Description |
|------|-------------|
| `gia_scan_environment` | Detect target environment (OS, containers, services) |
| `gia_list_packs` | List available operations packs |
| `gia_dry_run_pack` | Preview pack execution with blast radius analysis |
| `gia_apply_pack` | Execute a remediation or hardening pack |
| `gia_run_patrol` | Execute read-only patrol or audit checks |

### Value & Impact
| Tool | Description |
|------|-------------|
| `record_value_metric` | Record a workflow value metric for ROI reporting |
| `record_governance_event` | Record a governance event |
| `generate_impact_report` | Generate economic and governance impact report |

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `GIA_API_KEY` | Yes | — | Your GIA API key |
| `GIA_SERVER_URL` | No | `https://gia.aceadvising.com/mcp` | Custom server URL |

## Requirements

- Node.js 18 or later
- A GIA API key ([get one here](https://gia.aceadvising.com))

## License

Proprietary. See [LICENSE](LICENSE) for details.

Copyright (c) 2025-2026 William J. Storey III / Advanced Consulting Experts (ACE)
