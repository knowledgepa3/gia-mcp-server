# GIA MCP Server

**Governance enforcement layer for generative AI agents.** Classify every decision, enforce human approval gates, control what agents can access, score compliance posture, and maintain a cryptographic audit trail. Works with any MCP-compatible AI client or agent framework — model-agnostic and vendor-neutral.

```
Any AI Agent ──> GIA MCP Server ──> Governed Decision
                      │
                      ├── MAI Classification (Mandatory/Advisory/Informational)
                      ├── Human-in-the-Loop Gates (blocks until approved)
                      ├── Context Authority (bounded, hash-verified knowledge access)
                      ├── Governance Scoring (Integrity/Accuracy/Compliance)
                      ├── Forensic Ledger (SHA-256 hash-chained audit)
                      ├── Knowledge Packs (sealed, TTL-bound institutional knowledge)
                      ├── Phoenix Recovery (governed disaster recovery)
                      └── Compliance Mapping (NIST, EU AI Act, ISO 42001, CMMC)
```

**Production status:** the hosted deployment is live at [gia.aceadvising.com/mcp](https://gia.aceadvising.com/mcp) with 890+ hash-chained audit entries and a 96.5/100 enterprise-readiness score from a 7-phase internal validation (2026-07). Those figures describe that deployment, not your install — a fresh embedded engine starts with an empty ledger and builds its own. Governance overhead is single-digit milliseconds locally.

---

## Do I need an API key?

**No — not for the tool surface.** The governance engine in this package runs fully embedded: all 57 tools work offline with no key, no account, and no network call. Add `DATABASE_URL` when you want the audit trail to persist across restarts.

A key is only for **Option 2**, the hosted endpoint, where the ledger, gates, and knowledge packs are shared infrastructure rather than local state. [→ Starter key at gia.aceadvising.com/get-api-key](https://gia.aceadvising.com/get-api-key) — email in, key out, under 2 minutes, no credit card. Starter tier is 30 req/min and 1,000 tool calls/day.

## Why

Every enterprise deploying AI agents needs to answer three questions:

1. **What did the agent decide?** (Classification)
2. **Was a human involved?** (Gates)
3. **Can you prove it?** (Audit trail)

GIA answers all three at runtime, not after the fact.

A fourth question most governance frameworks miss:

4. **What was the agent allowed to know?** (Context Authority)

GIA controls what context an agent can access before it reasons. Not RAG. Governed cognition.

---

## Install

### Option 1: Any MCP-Compatible Client (Local / stdio)

Add to your MCP client config using the standard `mcpServers` block:

```json
{
  "mcpServers": {
    "gia": {
      "command": "npx",
      "args": ["gia-mcp-server"]
    }
  }
}
```

This works with any client that supports the Model Context Protocol over stdio. Config file locations differ per client; the JSON block above is the same for all of them. Consult your client's own MCP documentation for the current path — these move between releases:

| Client | Where MCP servers are declared |
|--------|-------------------------------|
| Cursor | `.cursor/mcp.json` |
| Continue | `.continue/config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop | `claude_desktop_config.json` in the app support directory |
| Claude Code | `.mcp.json` at the project root, or `claude mcp add gia -- npx gia-mcp-server` |
| Any other stdio MCP client | Per-client config; same `mcpServers` JSON block |

Nothing in the engine is client-specific — GIA governs whichever model sits behind the client.

### Option 2: Remote (Streamable HTTP)

Connect any MCP client to the hosted endpoint:

```
Endpoint: https://gia.aceadvising.com/mcp
Transport: Streamable HTTP
Auth:     Authorization: Bearer <your-api-key>
          (or ?GIA_API_KEY=<your-api-key> for gateways that cannot set headers)
```

The endpoint does **not** accept an `x-api-key` header.

### Option 3: Smithery

```bash
npx -y @smithery/cli mcp add knowledgepa3/gia-mcp-server
```

The package name must be namespaced — an unqualified `gia-mcp-server` does not resolve.

### Option 4: From source

```bash
git clone https://github.com/knowledgepa3/gia-mcp-server.git
cd gia-mcp-server
npm install
npm run build
npm start
```

`dist/` is not checked in, so the build step is required — `npm start` on a fresh clone would otherwise fail with `MODULE_NOT_FOUND`.

---

## Tools

GIA exposes **57 MCP tools** in three visibility tiers: 8 public, 36 tenant, 13 operator. The tables below are drift-guarded — `tests/docs/published-claims.test.ts` fails the release if this list stops matching the tools the server actually registers.

**How tiering behaves, precisely:** visibility is a property of the *session*, not of the package. The hosted endpoint (Option 2) issues tenant-tier sessions and hides operator tools. **Local stdio runs at operator tier by design** — every tool below is exposed, including `approve_gate` and `gia_apply_pack`, with no authentication. That is intentional: on a local embedded engine you are the operator, the ledger is your own process memory, and there is no one else to authorize you. It becomes load-bearing the moment you point `DATABASE_URL` at a shared database, so set `GIA_TOOL_VISIBILITY=tenant` (or `public`) for any install that is not a single-operator workstation. Call `list_available_tools` to see your effective set.

### Core Governance (Public — 8)

Available on every session, no authentication.

| Tool | Description |
|------|-------------|
| `classify_decision` | MAI classification (Mandatory/Advisory/Informational) with dynamic elevation, confidence, and gate registration |
| `score_governance` | Weighted integrity/accuracy/compliance composite against the release threshold |
| `evaluate_threshold` | Storey Threshold escalation-rate health metric |
| `assess_risk_tier` | EU AI Act risk classification (Unacceptable/High/Limited/Minimal) |
| `map_compliance` | Map controls to NIST AI RMF, EU AI Act, ISO 42001, NIST 800-53, FedRAMP, LINDDUN, MITRE ATLAS, OMB |
| `verify_ledger` | Self-consistency check of the in-memory hash chain from genesis (see the honesty note below) |
| `request_context` | Governed Context Authority — hash-verified, role-bound context envelopes |
| `list_available_tools` | Report which tools are available at your current tier, and which are withheld |

### classify_decision

Classify any AI agent decision using the MAI Framework. `decision` and `domain` are both required; the impact flags default to `false`.

```jsonc
// tools/call arguments
{
  "decision": "Generate client-facing deployment recommendations",
  "domain": "general",              // va-claims | legal | healthcare | finance | federal | general
  "is_client_facing": true,         // optional, default false
  "has_financial_impact": false,    // optional, default false
  "has_legal_impact": false,        // optional, default false
  "agent_name": "deploy-advisor"    // optional
}
```

```jsonc
// result
{
  "classification": "MANDATORY",
  "requiresGate": true,
  "gateId": "gate-5052d37c-c3a6-49ef-b011-d82bbecfe4cc",
  "gateStatus": "PENDING",
  "elevatedFrom": "INFORMATIONAL",
  "elevationReason": "Client-facing output requires MANDATORY gate",
  "auditId": "7495bc99-df25-4e31-b447-906f8e07df5f"
}
```

**A pending MANDATORY gate blocks the next decision.** While a gate is open, `classify_decision` returns `gateStatus: "HOLD"` with the blocking gate's ID instead of classifying — call `get_gate_status(gateId)` and wait for resolution. This is the enforcement, not a warning: an agent cannot queue work past an unapproved gate.

**MAI Framework:**

| Level | Behavior | Example |
|-------|----------|---------|
| **MANDATORY** | Blocks until human approves | Delete records, financial transactions, client-facing output |
| **ADVISORY** | Logs with recommendation, continues | Search queries, draft documents, analysis |
| **INFORMATIONAL** | Audit trail only | Status checks, read operations |

Context always **elevates**, never reduces. PII detected? Elevated to MANDATORY. Financial impact? MANDATORY. Client-facing? MANDATORY.

### request_context

Governed Context Authority. Agents declare what context they need. GIA decides what to serve based on role, scope, and contract.

```
"Request compliance context for high-risk AI operations"

> Envelope: GIA-CTX-mn0uanx1-upi2f7
  MAI: ADVISORY
  Hash: c83184d9caa88e76...
  Sources: memory_packs, governed_retrieval, compliance_mappings
  Compliance Maps: 18 returned
  Denials: 0
```

Five context classes: `policies_and_sops`, `architecture_and_systems`, `contract_and_compliance`, `playbooks_and_knowledge`, `operational_history`.

Every retrieval is role-bound, tenant-scoped, hash-verified, and ledgered. Agents don't know internals by default. They request context under contract.

### score_governance

Score any agent output on three dimensions. `operation` is required — the score is recorded against a named operation, not scored in the abstract.

```jsonc
// tools/call arguments
{
  "operation": "deployment-recommendation",
  "integrity": 0.92,
  "accuracy": 0.88,
  "compliance": 0.95
}
```

```jsonc
// result
{
  "composite": 0.9135,
  "integrity": 0.92, "accuracy": 0.88, "compliance": 0.95,
  "weights": { "integrity": 0.4, "accuracy": 0.35, "compliance": 0.25 },
  "meetsThreshold": true,
  "minimumThreshold": 0.7,
  "auditId": "6f28a241-4d72-4167-aea9-fa0da9ccde34"
}
```

The values are supplied by the caller — GIA computes and records the weighted composite and the pass/fail verdict against the release threshold. It does not measure integrity or accuracy for you.

| Score | Action |
|-------|--------|
| 0.70+ | Release (pass) |
| 0.50-0.70 | Repair required |
| Below 0.50 | Halt operations |

### evaluate_threshold

The Storey Threshold measures governance health by tracking MANDATORY escalation rate.

```
"Evaluate the governance threshold"

> Escalation Rate: 14.2% | Status: HEALTHY
  Recommendation: Within optimal band (10-18%). System is calibrated.
```

| Rate | Status | Meaning |
|------|--------|---------|
| Below 10% | DEGRADED | Under-classifying risks |
| 10-18% | HEALTHY | Appropriately calibrated |
| 18-25% | DEGRADED | Over-classifying, unnecessary friction |
| Above 25% | CRITICAL | System bottlenecked |

### Gates & Chain of Reasoning (Tenant — 3)

| Tool | Description |
|------|-------------|
| `get_gate_status` | Wait on a MANDATORY gate after `classify_decision` returns PENDING; polls up to 60s |
| `chain_of_reasoning` | Reconstruct the full Chain of Reasoning for a session, agent, or time range |
| `governed_sample` | Request a governed LLM completion via MCP Sampling — the client makes the model call, GIA governs whether and under what constraints |

### Knowledge Packs (Tenant — 6)

| Tool | Description |
|------|-------------|
| `seal_memory_pack` | Create hash-sealed, TTL-bound institutional knowledge artifacts |
| `load_memory_pack` | Load a knowledge pack after TTL, trust-level, role, context-class, and hash validation |
| `transfer_memory_pack` | Transfer packs between agents via governed knowledge corridors (always MANDATORY) |
| `compose_memory_packs` | Compose packs into one context — highest risk wins, shortest TTL wins, roles intersect |
| `distill_memory_pack` | Distill governance patterns from usage history into an EPHEMERAL draft pack |
| `promote_memory_pack` | Promote a pack to a higher trust level after human review (MANDATORY gate) |

### Recovery (Tenant — 3)

| Tool | Description |
|------|-------------|
| `phoenix_snapshot` | Create a governed state snapshot, hash-chained to the previous one |
| `phoenix_verify_integrity` | Verify ledger chain, agent health, threshold, and intelligence-layer continuity |
| `phoenix_recovery_health` | Assess disaster-recovery readiness (NIST CP-2 / CP-9 / CP-10) |

### Audit & Reporting (Tenant — 10)

| Tool | Description |
|------|-------------|
| `audit_pipeline` | Query the hash-chained forensic ledger by operation or recency |
| `verify_ledger_v2` | Verify the **persisted** PostgreSQL ledger rows, epoch-aware — not an in-memory reconstruction |
| `export_ledger` | Export the ledger as a compliance evidence package with chain verification |
| `system_status` | Read-only snapshot of engine state, ledger head, threshold, and module status |
| `monitor_agents` | Supervisor state, repair history, and failure counts for governed agents |
| `generate_report` | Governance status report (summary, detailed, or executive) |
| `record_value_metric` | Record time saved, risk blocked, success rate, autonomy level |
| `record_governance_event` | Record gates triggered, drift prevented, violations blocked, human interventions |
| `generate_impact_report` | Economic + governance impact report (an *illustrative* estimate, labelled as such) |
| `evaluate_routing_threshold` | Model-routing health: fallback rate, cache hit rate, batch utilization, premium spend leakage |

### Context Authority (Tenant — 1)

| Tool | Description |
|------|-------------|
| `context_revive` | Governed context compaction — detect context pressure and restore capacity under governance |

### Governed Boards (Tenant — 7)

Deliberation bodies: charters define seats, modes, and quorum; non-consensus escalates to a MANDATORY gate.

| Tool | Description |
|------|-------------|
| `board_list_institutions` | List governed institutions (e.g. Architecture Review Board, Federal AI Council) |
| `board_list_charters` | List charters under an institution with modes and seat configuration |
| `board_convene_session` | Convene a deliberation session — each seat deliberates per the charter's mode |
| `board_get_session` | Retrieve session status, per-seat positions, synthesis, and dissents |
| `board_install_kit` | Install a prebuilt Institution Kit — a governed org chart with sealed charters |
| `board_approve_gate` | Approve the MANDATORY gate on a deliberation output before it becomes authoritative |
| `board_search_precedent` | Search prior board rulings, ranked by quality score and gate-approval status |

### Colony — Agent Constitution (Tenant — 6)

| Tool | Description |
|------|-------------|
| `agent_rights` | Query and exercise constitutional agent rights; get structured rejection explanations |
| `agent_citizenship_status` | Query agent citizenship tier and merit score, or trigger re-evaluation |
| `branch_authority_status` | Separation of powers — query branch authority holders and validate branch actions |
| `colony_convene_request` | Agent-initiated requests to convene a governed session |
| `colony_suggestion` | Agent-proposed charter amendments, with review and upvoting |
| `colony_health` | Colony health score, 30-day trend, or an on-demand health snapshot |

### Infrastructure & Self-Repair (Operator — 13)

Withheld from tenant sessions. Exposed on local stdio — see the tiering note above.

| Tool | Description |
|------|-------------|
| `approve_gate` | Human-in-the-loop approval or rejection of a pending MANDATORY gate |
| `srt_run_watchdog` | Real health probes from the container (API, frontend, disk, memory, TLS, DB, DNS) |
| `srt_diagnose` | Match an incident to known playbooks and propose a staged repair plan |
| `srt_approve_repair` | MANDATORY gate for repair execution — plans cannot run without explicit approval |
| `srt_generate_postmortem` | Structured postmortem with timeline, root cause, and real TTD/TTR timings |
| `gia_scan_environment` | Scout swarm — detect OS, containers, services, network, storage for compatibility |
| `gia_list_packs` | List governed operations packs by intent, category, risk, or trust level |
| `gia_dry_run_pack` | Preview pack execution: hydrated commands, validation, blast radius, `inputsHash` |
| `gia_apply_pack` | Execute a pack under MANDATORY gate, bound to the approved `inputsHash` |
| `gia_run_patrol` | Read-only posture checks and compliance audits |
| `gia_retrieve` | Governed semantic search — hash-verified, permission-checked, TTL-enforced, ledgered |
| `gia_ingest_document` | Governed document ingestion (text or base64 PDF/DOCX/TXT/image) with hash verification |
| `generate_value_report` | DRAFT ledger-anchored economic value report over real sessions, MEASURED/MODELED provenance |
| `gia_retrieve` | Governed semantic search with permission checking |
| `gia_ingest_document` | Governed document ingestion with hash verification |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Clients (any vendor)                                    │
│  Any MCP client, agent runtime, or framework — any model     │
└────────────────────────┬────────────────────────────────────┘
                         │ stdio / Streamable HTTP
┌────────────────────────▼────────────────────────────────────┐
│  GIA MCP Server                                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Transport Layer (MCP Protocol)                         │ │
│  │  57 tools | 8 resources | 4 prompts | validate | route  │ │
│  └────────────────────┬───────────────────────────────────┘ │
│                        │                                     │
│  ┌────────────────────▼───────────────────────────────────┐ │
│  │  Governance Engine                                      │ │
│  │                                                         │ │
│  │  MAI Classifier ── Gate Enforcer ── Context Authority   │ │
│  │  Scoring Engine ── Storey Threshold ── Compliance Map   │ │
│  │  Knowledge Packs ── Phoenix Recovery ── SRT Watchdog    │ │
│  │  Forensic Ledger (SHA-256 hash-chained, persistent)     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                        │                                     │
│  ┌─────────────────────▼───────────────────────────────────┐ │
│  │  Persistence Layer (PostgreSQL)                          │ │
│  │  Ledger | Gates | Memory Packs | Intelligence | SRT     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Design principles:**
- Transport layer does zero business logic
- Every operation writes to the forensic ledger
- Classification is deterministic (pattern matching + rules, not LLM-based)
- Audit entries are hash-chained (SHA-256), persistent across restarts
- Context is bounded by contract, not by model training data
- Human principal traceability on every governed action

---

## Concepts

### MAI Framework

Every AI agent decision is classified as **Mandatory**, **Advisory**, or **Informational**:

- **MANDATORY** -- Blocks execution until a human approves through the gate. Deletions, submissions, deployments, financial transactions, PII operations, client-facing output.
- **ADVISORY** -- Logs a recommendation, continues execution. Searches, drafts, rankings, analysis.
- **INFORMATIONAL** -- Audit trail entry only. Status checks, read operations, internal routing.

Context elevates, never reduces. A search (ADVISORY) that touches PII becomes MANDATORY.

### Storey Threshold

A quantitative health metric. Measures what percentage of decisions require MANDATORY classification.

- Too low (<10%): Rubber-stamping. Critical decisions aren't being caught.
- Healthy (10-18%): Appropriate friction. Most decisions flow; critical ones stop.
- Too high (>18%): Bottleneck. Trust calibration needed.

### Context Authority

Agents don't know internals by default. They request context under contract. GIA checks role, scope, trust level, and content classification before serving a hash-verified context envelope. Five context classes cover policies, architecture, compliance, playbooks, and operational history. Every retrieval is audited. Every denial is logged with a reason code.

### Forensic Ledger

Append-only, hash-chained audit trail with PostgreSQL persistence. Every entry contains:
- Operation name, timestamp, and actor identity
- MAI classification level
- Input/output hashes (SHA-256)
- Chain link to previous entry
- Human principal traceability (delegatedBy field)

Verify chain integrity at any time. If any entry is modified, the chain breaks. The hosted deployment held 890+ entries with the chain verified INTACT as of 2026-07; your embedded engine verifies its own chain from its own genesis.

`verify_ledger` reports exactly what it checked. It walks the **in-memory** chain reconstruction and says so in its own output — it cannot detect a direct edit to a persisted database row. Use `verify_ledger_v2` to verify the persisted PostgreSQL rows. GIA states the scope of its own verification rather than letting "chain INTACT" imply more than was measured.

### Knowledge Packs

Sealed, TTL-bound institutional knowledge artifacts with trust level enforcement (SYSTEM > ORG > CASE > EPHEMERAL). Hash-verified at load time. Role-gated access. Transfer between agents requires MANDATORY gate approval.

### Phoenix Recovery

Governed disaster recovery. Hash-chained snapshots of governance engine state. Verifies audit chain integrity, gate states, knowledge pack inventory, and compliance posture on recovery. NIST 800-53 CP-2/CP-9/CP-10 aligned. Grade A in production.

---

## Performance

Measured on the live production system (gia.aceadvising.com):

| Operation | Median Latency | Grade |
|-----------|---------------|-------|
| Decision Classification | 9ms | A+ |
| Compliance Scoring | 11ms | A+ |
| Context Authority | 7ms | A+ |
| Audit Chain Verification (890+ hashes, hosted) | 98ms | B+ |
| 5 Concurrent Operations | 757ms total | Grade A |

Enterprise readiness score: 96.5/100 — a 7-phase internal validation (2026-07) including chaos engineering and Phoenix recovery. Internal assessment, not a third-party audit.

---

## Compliance Mapping

| Framework | Coverage |
|-----------|----------|
| NIST AI RMF 1.0 | MAP, MEASURE, MANAGE, GOVERN functions |
| NIST SP 800-53 Rev 5 | AU-2, AU-3, AC-2, AC-6, CP-2, CP-9, CP-10 |
| EU AI Act (2024/1689) | Articles 9-15, Annex III/IV, conformity assessment |
| ISO/IEC 42001 | AI Management System alignment |
| CMMC 2.0 | Cybersecurity maturity controls |
| MITRE ATLAS | Adversarial threat landscape mapping |

---

## Transports

| Transport | Use Case |
|-----------|----------|
| **stdio** | Any local MCP client, whichever model it is configured to use |
| **Streamable HTTP** | Remote clients, OpenAI Agents SDK, LangChain, custom agent frameworks, web integrations |

Both transports share the same governance engine. Same classification, same audit trail, same enforcement.

---

## Current Limitations

| Area | Status |
|------|--------|
| Distributed multi-region deployment | Single-region (planned) |
| FedRAMP authorization | In progress |
| SOC 2 Type II audit | Planned Q2 2026 |
| IL4/IL5 deployment | Planned Q4 2026 |

The governance engine, persistence, authentication, rate limiting, multi-vendor support, and compliance mapping are all production-grade and operational.

---

## License

Proprietary. Copyright (c) 2025-2026 William J. Storey III / Advanced Consulting Experts, LLC. All rights reserved.

The MAI Framework, Storey Threshold, Context Authority, Forensic Ledger architecture, and GIA governance patterns are intellectual property of the author. See [LICENSE](LICENSE) for terms.

Earlier snapshots of this repository (v0.3.x) carried an MIT LICENSE file in error; the npm package has always been distributed under the proprietary terms above. Grants already received under that MIT file are not affected by this correction, which applies going forward.

---

Built by [ACE](https://aceadvising.com) (SDVOSB) | [Live Platform](https://gia.aceadvising.com) | [Smithery](https://smithery.ai/servers/knowledgepa3/gia-mcp-server)
