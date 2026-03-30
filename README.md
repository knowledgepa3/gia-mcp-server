# GIA Governance Intelligence Automation

**Enterprise AI governance through the Model Context Protocol.**

GIA is a production governance engine that gives AI agents enforceable decision controls, compliance scoring, immutable audit chains, and human-in-the-loop gates. Built for organizations operating under NIST, FedRAMP, CMMC, EU AI Act, and SOC 2 requirements.

29 MCP tools. One integration point. Works with Claude Desktop, Claude Code, OpenAI Agent Builder, and any MCP-compatible client.

## Quick Start

```bash
npx gia-mcp-server
```

Or install globally:

```bash
npm install -g gia-mcp-server
gia-mcp-server
```

The server connects to the hosted GIA engine at `https://gia.aceadvising.com`. Configure your API key:

```bash
GIA_API_KEY=your-key npx gia-mcp-server
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gia-governance": {
      "command": "npx",
      "args": ["-y", "gia-mcp-server"],
      "env": {
        "GIA_API_KEY": "your-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add gia-governance -- npx -y gia-mcp-server
```

### OpenAI Agent Builder

Point to the Streamable HTTP endpoint:

```
https://gia.aceadvising.com/mcp
```

### Smithery

```
npx -y @smithery/cli install @knowledgepa3/gia-mcp-server --client claude
```

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/knowledgepa3-gia-mcp-server).

## Tools

### Decision Controls (MAI Framework)

| Tool | Description |
|------|-------------|
| `classify_decision` | Classify agent decisions as Mandatory, Advisory, or Informational |
| `approve_gate` | Human-in-the-loop approval for Mandatory gates |
| `evaluate_threshold` | Compute escalation health (Storey Threshold) |
| `score_governance` | Weighted governance scoring (Integrity, Accuracy, Compliance) |

### Compliance & Audit

| Tool | Description |
|------|-------------|
| `audit_pipeline` | Query the hash-chained forensic audit ledger |
| `verify_ledger` | Verify SHA-256 chain integrity from genesis |
| `map_compliance` | Map controls to NIST AI RMF, EU AI Act, ISO 42001, NIST 800-53 |
| `assess_risk_tier` | EU AI Act risk tier classification |
| `generate_report` | Governance status reports (summary, detailed, executive) |

### Knowledge Packs

| Tool | Description |
|------|-------------|
| `seal_memory_pack` | Create immutable, TTL-bound knowledge artifacts |
| `load_memory_pack` | Load packs with trust level and role enforcement |
| `transfer_memory_pack` | Governed knowledge transfer between agents |
| `compose_memory_packs` | Merge packs with risk contamination rules |
| `distill_memory_pack` | Extract governance patterns from usage history |
| `promote_memory_pack` | Promote packs to higher trust levels after review |

### Security & Operations

| Tool | Description |
|------|-------------|
| `monitor_agents` | Agent health, repair history, failure counts |
| `srt_run_watchdog` | Infrastructure health probes (API, disk, memory, TLS, DB, DNS) |
| `srt_diagnose` | Incident diagnosis with playbook matching |
| `srt_approve_repair` | Human-approved repair execution |
| `srt_generate_postmortem` | Structured incident postmortems with TTD/TTR metrics |

### Infrastructure Remediation

| Tool | Description |
|------|-------------|
| `gia_scan_environment` | Scout swarm for environment detection |
| `gia_list_packs` | List remediation, patrol, hardening, and audit packs |
| `gia_dry_run_pack` | Preview pack execution with blast radius analysis |
| `gia_apply_pack` | Execute remediation with mandatory human approval |
| `gia_run_patrol` | Read-only posture checks and compliance audits |

### Impact & Value

| Tool | Description |
|------|-------------|
| `record_value_metric` | Track time saved, risks blocked, autonomy levels |
| `record_governance_event` | Log gates, drift prevention, violations blocked |
| `generate_impact_report` | Economic + governance ROI reporting |
| `system_status` | Engine health, uptime, configuration |

## Architecture

GIA enforces governance through three layers:

1. **Decision Controls** — MAI classification gates side effects and high-impact actions
2. **Step Hooks** — Workflow progression control at each pipeline stage
3. **Kernel Hooks** — Resource control at the LLM boundary, including sub-agents

Every governance action is recorded in a SHA-256 hash-chained audit ledger that can be independently verified.

## Compliance Coverage

- **NIST AI RMF** — Risk management framework mapping
- **EU AI Act** — Risk tier assessment and control mapping
- **ISO 42001** — AI management system alignment
- **NIST 800-53** — Federal security control mapping
- **CMMC 2.0** — DoD cybersecurity maturity
- **FedRAMP** — Federal cloud authorization
- **SOC 2** — Service organization controls

## About

Built by [Advanced Consulting Experts (ACE)](https://aceadvising.com) — a Service-Disabled Veteran-Owned Small Business (SDVOSB).

GIA was designed by William J. Storey III, a 17-year Information System Security Officer with experience across DoD contracts and U.S. Army Ranger Battalion operations. The same discipline applied to securing classified systems now governs AI agent workforces.

## License

MIT
