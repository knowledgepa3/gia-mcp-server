/**
 * @module    mcp-tool-context-authority
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       ADVISORY (elevated to MANDATORY if SYSTEM-trust content matched)
 * @audit     true — every context retrieval is ledger-recorded with full provenance
 * @owner     William J. Storey III / ACE / GIA
 *
 * Governed Context Authority — `request_context`
 *
 * Agents don't know internals by default. They request context under contract.
 *
 * Single MCP tool that unifies:
 *   - Memory Packs (policies, SOPs, playbooks, heuristics)
 *   - Governed Retrieval (hash-verified documents via pgvector)
 *   - Compliance Mappings (NIST, EU AI Act, ISO 42001, etc.)
 *
 * into one governed knowledge pipeline. The agent declares intent and context class,
 * GIA resolves from the right source, enforces governance, and returns a context
 * envelope with only what the agent is allowed to see — hash-logged.
 *
 * NIST 800-53: AC-3 (Access Enforcement), AU-3 (Content of Audit Records),
 *              PM-11 (Mission/Business Process Definition)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { GovernanceEngine } from '../../core/governance.js';
import { MaiClassification, GiaLayer } from '../../shared/types.js';
import { sanitize } from '../../shared/utils.js';
import { GovernedError } from '../../shared/errors.js';
import { getGMPPacksByFilter, type GMPPack } from './memory-packs.js';
import { getComplianceMappings, MAPPING_DISCLAIMER } from './map-compliance.js';

// ═══════════════════════════════════════════════════════════════════
// Context Classes — what kind of knowledge is being requested
// ═══════════════════════════════════════════════════════════════════

const CONTEXT_CLASSES = ['policies_and_sops', 'architecture_and_systems', 'contract_and_compliance', 'playbooks_and_knowledge', 'operational_history'] as const;
type ContextClass = typeof CONTEXT_CLASSES[number];

interface ContextRouting {
  memoryPackTypes: string[];
  retrievalDomains: string[];
  complianceFrameworks: string[];
  defaultMai: MaiClassification;
}

const CONTEXT_CLASS_ROUTING: Record<ContextClass, ContextRouting> = {
  policies_and_sops: {
    memoryPackTypes: ['DOMAIN_SOP', 'REGULATORY', 'RISK_GUARDRAILS'],
    retrievalDomains: [],
    complianceFrameworks: [],
    defaultMai: MaiClassification.ADVISORY,
  },
  architecture_and_systems: {
    memoryPackTypes: [],
    retrievalDomains: ['architecture', 'infrastructure', 'engineering', 'operations'],
    complianceFrameworks: [],
    defaultMai: MaiClassification.ADVISORY,
  },
  contract_and_compliance: {
    memoryPackTypes: ['REGULATORY'],
    retrievalDomains: ['compliance', 'legal'],
    complianceFrameworks: ['NIST_800_53', 'EU_AI_ACT', 'ISO_42001', 'NIST_AI_RMF'],
    defaultMai: MaiClassification.ADVISORY,
  },
  playbooks_and_knowledge: {
    memoryPackTypes: ['PLAYBOOK', 'HEURISTIC', 'KNOWLEDGE'],
    retrievalDomains: [],
    complianceFrameworks: [],
    defaultMai: MaiClassification.ADVISORY,
  },
  operational_history: {
    memoryPackTypes: [],
    retrievalDomains: [],
    complianceFrameworks: [],
    defaultMai: MaiClassification.ADVISORY,
  },
};

// ═══════════════════════════════════════════════════════════════════
// Governed Retrieval API helper (calls ace-server's /api/retrieval)
// ═══════════════════════════════════════════════════════════════════

const API_BASE = process.env.GIA_API_URL || 'http://localhost:3001';
const API_KEY = process.env.GIA_API_KEY || '';

async function retrieveDocuments(
  query: string,
  domains: string[],
  maxResults: number
): Promise<{ chunks: any[]; denied: any[]; stats: any }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    const res = await fetch(`${API_BASE}/api/retrieval/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        domains: domains.length > 0 ? domains : undefined,
        maxResults,
        similarityThreshold: 0.6,
      }),
    });

    if (!res.ok) return { chunks: [], denied: [], stats: { error: `API ${res.status}` } };
    const data = await res.json() as any;
    return {
      chunks: (data.results || []).map((c: any) => ({
        chunkId: c.chunkId,
        documentTitle: c.documentTitle,
        content: c.content,
        similarity: c.similarity,
        domain: c.domain,
        trustLevel: c.trustLevel,
        hashValid: c.verification?.hashValid ?? true,
      })),
      denied: data.denied || [],
      stats: data.stats || {},
    };
  } catch (err) {
    return { chunks: [], denied: [], stats: { error: (err as Error).message } };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Context Envelope — the governed response format
// ═══════════════════════════════════════════════════════════════════

interface ContextEnvelope {
  envelopeId: string;
  contextClass: string;
  query: string;
  requestedBy: string;
  sources: {
    memoryPacks: {
      count: number;
      packs: Array<{
        packId: string;
        type: string;
        trustLevel: string;
        domain: string;
        hash: string;
        content: {
          principles: string[];
          sop: string[];
          heuristics: string[];
          antiPatterns: string[];
        };
      }>;
    };
    governedDocuments: {
      count: number;
      chunks: Array<{
        chunkId: string;
        documentTitle: string;
        content: string;
        similarity: number;
        domain: string;
        trustLevel: string;
        hashValid: boolean;
      }>;
    };
    complianceMappings: {
      count: number;
      // M12: design-mapping disclaimer travels WITH the data so an agent consuming
      // the envelope cannot read status 'IMPLEMENTED' as certified/enforced.
      disclaimer?: string;
      mappings: Array<{
        framework: string;
        control: string;
        description: string;
        giaComponent: string;
        status: string;
      }>;
    };
    operationalHistory: {
      count: number;
      entries: Array<{
        auditId: string;
        operation: string;
        classification: string;
        timestamp: string;
        agentId: string;
        summary: string;
      }>;
      timeWindow: string;
    };
  };
  governance: {
    maiClassification: string;
    auditId: string;
    envelopeHash: string;
    retrievedAt: string;
    sourcesQueried: string[];
    denials: Array<{
      source: string;
      reason: string;
      detail: string;
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tool Registration
// ═══════════════════════════════════════════════════════════════════

export function registerContextAuthorityTool(server: McpServer, engine: GovernanceEngine): void {
  server.tool(
    'request_context',
    'Request governed internal context — policies, SOPs, architecture docs, compliance rules, or playbooks. Agents declare intent, GIA decides what to serve. Every retrieval is role-bound, tenant-bound, hash-verified, and ledgered. "Agents don\'t know internals by default. They request context under contract."',
    {
      query: z.string().max(500).describe('What context is needed — natural language description'),
      context_class: z.enum(CONTEXT_CLASSES).describe('Category: policies_and_sops, architecture_and_systems, contract_and_compliance, playbooks_and_knowledge, operational_history'),
      domain: z.string().max(100).describe('Domain scope (e.g., va-claims, finance, eu-ai-act, general)'),
      agent_id: z.string().max(100).describe('Agent requesting context'),
      run_id: z.string().optional().describe('Current run/pipeline ID'),
      operator_role: z.string().max(100).default('agent').describe('Role of the requesting operator'),
      max_results: z.number().min(1).max(20).default(5).describe('Maximum results per source'),
      include_compliance: z.boolean().default(false).describe('Include compliance mapping overlay'),
      time_window: z.enum(['1h', '6h', '24h', '7d']).optional().describe('Time window for operational history recall (default: 24h)'),
      session_id: z.string().max(100).optional().describe('Session ID for voice/ephemeral agents -- bridges context across sessions without persistent memory'),
    },
    {
      title: 'Request Governed Context',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (input) => {
      const startMs = Date.now();
      const routing = CONTEXT_CLASS_ROUTING[input.context_class];

      // Begin forensic ledger entry
      const entry = engine.ledger.begin(
        'request-context',
        routing.defaultMai,
        GiaLayer.MCP,
        input.agent_id || 'SYSTEM'
      );
      entry.addMetadata('contextClass', input.context_class);
      entry.addMetadata('domain', input.domain);
      entry.addMetadata('query', sanitize(input.query).slice(0, 200));
      entry.addMetadata('operatorRole', input.operator_role);
      if (input.session_id) entry.addMetadata('sessionId', input.session_id);

      try {
        const sourcesQueried: string[] = [];
        const denials: ContextEnvelope['governance']['denials'] = [];
        let maiLevel = routing.defaultMai;

        // ─── Resolve Memory Packs ───
        let packResults: ContextEnvelope['sources']['memoryPacks'] = { count: 0, packs: [] };
        if (routing.memoryPackTypes.length > 0) {
          sourcesQueried.push('memory_packs');
          const filtered = await getGMPPacksByFilter({
            types: routing.memoryPackTypes,
            domains: [input.domain],
            role: input.operator_role,
          });

          // Also try without domain filter if no domain-specific results
          let allFiltered = filtered;
          if (filtered.filter(f => !f.denialReason).length === 0) {
            const broader = await getGMPPacksByFilter({
              types: routing.memoryPackTypes,
              role: input.operator_role,
            });
            allFiltered = broader;
          }

          const resolvedPacks: GMPPack[] = [];
          for (const { pack, denialReason } of allFiltered) {
            if (denialReason) {
              denials.push({ source: 'memory_pack', reason: denialReason, detail: pack.memoryPackId });
              continue;
            }
            resolvedPacks.push(pack);
          }

          // MANDATORY gate enforcement — SYSTEM-trust pack content MUST go
          // through a real human-in-the-loop gate BEFORE it is placed into
          // the response envelope. Previously this only set a local
          // `maiLevel = MANDATORY` variable that was surfaced cosmetically
          // in the response and ledger metadata — the SYSTEM-trust content
          // itself flowed through unconditionally, with no gate call
          // anywhere in this file (fleet verification finding, 2026-07-14).
          // The gate is checked BEFORE the content below is appended — a
          // rejected/timed-out gate must return an error envelope with NO
          // pack content, not a partially-filtered one.
          const hasSystemTrust = resolvedPacks.some(p => p.trustLevel === 'SYSTEM');
          if (hasSystemTrust) {
            maiLevel = MaiClassification.MANDATORY;
            let gateDecision;
            try {
              gateDecision = await engine.gate.enforce(
                MaiClassification.MANDATORY,
                `request-context:${input.agent_id}→SYSTEM-trust:${input.domain}`,
                entry.id,
              );
            } catch (gateError) {
              const failedEntry = entry.fail(
                gateError instanceof Error ? gateError : new Error(String(gateError)),
                MaiClassification.MANDATORY,
              );
              engine.ledger.record(failedEntry);
              return { content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'GATE_REQUIRED',
                message: `SYSTEM-trust context requires MANDATORY gate approval: ${gateError instanceof Error ? gateError.message : String(gateError)}`,
                domain: input.domain,
                contextClass: input.context_class,
              }) }], isError: true };
            }
            entry.addMetadata('gateId', gateDecision.gateId);
            entry.addMetadata('gateStatus', gateDecision.status);

            if (gateDecision.status !== 'APPROVED') {
              const failedEntry = entry.fail(
                new Error(`MANDATORY gate ${gateDecision.status} for SYSTEM-trust context request`),
                MaiClassification.MANDATORY,
              );
              engine.ledger.record(failedEntry);
              return { content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'GATE_REQUIRED',
                gateId: gateDecision.gateId,
                gateStatus: gateDecision.status,
                message: 'SYSTEM-trust context requires MANDATORY gate approval. Use approve_gate tool with gate ID to approve.',
                domain: input.domain,
                contextClass: input.context_class,
              }) }], isError: true };
            }
          }

          for (const pack of resolvedPacks) {
            packResults.packs.push({
              packId: pack.memoryPackId,
              type: pack.type,
              trustLevel: pack.trustLevel,
              domain: pack.domain,
              hash: pack.hash,
              content: pack.content,
            });
          }
          packResults.count = packResults.packs.length;
        }

        // ─── Resolve Governed Documents ───
        let docResults: ContextEnvelope['sources']['governedDocuments'] = { count: 0, chunks: [] };
        if (routing.retrievalDomains.length > 0) {
          sourcesQueried.push('governed_retrieval');
          const retrieval = await retrieveDocuments(
            input.query,
            routing.retrievalDomains,
            input.max_results
          );
          docResults.chunks = retrieval.chunks.slice(0, input.max_results);
          docResults.count = docResults.chunks.length;

          // An upstream retrieval failure (403/5xx/network) must surface as a
          // denial — an empty envelope is indistinguishable from an empty corpus.
          const retrievalApiError = (retrieval.stats as { error?: unknown })?.error;
          if (retrievalApiError) {
            denials.push({
              source: 'governed_retrieval',
              reason: 'RETRIEVAL_API_ERROR',
              detail: String(retrievalApiError),
            });
          }

          for (const denied of retrieval.denied) {
            denials.push({
              source: 'governed_retrieval',
              reason: denied.reason || 'RETRIEVAL_DENIED',
              detail: denied.chunkId || 'unknown',
            });
          }
        }

        // ─── Resolve Compliance Mappings ───
        let complianceResults: ContextEnvelope['sources']['complianceMappings'] = { count: 0, mappings: [] };
        if (routing.complianceFrameworks.length > 0 || input.include_compliance) {
          sourcesQueried.push('compliance_mappings');
          complianceResults.disclaimer = MAPPING_DISCLAIMER;
          const frameworks = routing.complianceFrameworks.length > 0
            ? routing.complianceFrameworks
            : ['NIST_800_53', 'EU_AI_ACT', 'ISO_42001'];

          for (const fw of frameworks) {
            const mappings = getComplianceMappings(fw);
            for (const m of mappings.slice(0, input.max_results)) {
              complianceResults.mappings.push({
                framework: (m as any).framework || fw,
                control: (m as any).controlId || (m as any).control || '',
                description: (m as any).description || '',
                giaComponent: (m as any).giaComponent || (m as any).component || '',
                status: (m as any).status || (m as any).implemented || 'mapped',
              });
            }
          }
          complianceResults.count = complianceResults.mappings.length;
        }

        // ─── Resolve Operational History (Governed Recall) ───
        // Agents don't remember. They recall under contract from an immutable record.
        // Scoped, contract-bounded, TTL-aware, explainable in the envelope.
        let historyResults: ContextEnvelope['sources']['operationalHistory'] = { count: 0, entries: [], timeWindow: '' };
        if (input.context_class === 'operational_history') {
          sourcesQueried.push('forensic_ledger');
          const timeWindow = input.time_window || '24h';
          const windowMs: Record<string, number> = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
          const cutoffMs = windowMs[timeWindow] || 86400000;
          const now = new Date();
          const cutoff = new Date(now.getTime() - cutoffMs);

          // Use ledger's queryByTimeRange for governed recall
          // This returns only COMPLETED entries (not started/failed) within the window
          const rangeEntries = engine.ledger.queryByTimeRange(cutoff, now);

          // Scope by agent ID if provided (agents can only recall their own history)
          // This prevents cross-agent information leakage.
          // SECURITY: 'system' agent gets broader view (governance oversight),
          // all other agents are strictly scoped to their own operations.
          const scopedEntries = rangeEntries
            .filter(e => {
              // System/operator agents can recall broader history (for oversight)
              if (!input.agent_id || input.agent_id === 'system') return true;
              // Session-scoped recall: if session_id provided, match on session
              // This is the voice agent bridge -- recall only operations from prior sessions
              // with the same session identifier (e.g., customer ID, conversation thread)
              if (input.session_id && (e.metadata as any)?.sessionId === input.session_id) return true;
              // All other agents: strict scoping to own operations only
              return e.actor === input.agent_id ||
                     (e.metadata as any)?.agentId === input.agent_id;
            })
            .filter(e => e.status === 'COMPLETED' || e.status === 'ESCALATED')
            .slice(-input.max_results);

          // Sanitize entries -- strip internal metadata, expose only what's needed
          // This is the "least context exposure" principle applied to history recall
          const mappedEntries = scopedEntries.map(e => ({
            auditId: e.id,
            operation: e.operation || 'unknown',
            classification: String(e.maiLevel || 'INFORMATIONAL'),
            timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp || ''),
            agentId: e.actor || 'unknown',
            summary: (e.metadata as any)?.rationale ||
                     `${e.operation} [${e.maiLevel}] ${e.status}`,
          }));

          historyResults = {
            count: mappedEntries.length,
            entries: mappedEntries,
            timeWindow,
          };

          // If no history found, note as denial
          if (mappedEntries.length === 0) {
            denials.push({
              source: 'operational_history',
              reason: 'NO_HISTORY',
              detail: `No completed operations found for agent ${input.agent_id} in ${timeWindow} window`,
            });
          }
        }

        // ─── Build Context Envelope ───
        const envelopeId = `GIA-CTX-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
        const retrievedAt = new Date().toISOString();

        // Hash the envelope content for integrity verification
        const contentForHash = JSON.stringify({
          packs: packResults.packs.map(p => p.hash),
          chunks: docResults.chunks.map(c => c.chunkId),
          mappings: complianceResults.count,
          history: historyResults.count,
        });
        const envelopeHash = createHash('sha256').update(contentForHash).digest('hex').slice(0, 16);

        const envelope: ContextEnvelope = {
          envelopeId,
          contextClass: input.context_class,
          query: input.query,
          requestedBy: input.agent_id,
          sources: {
            memoryPacks: packResults,
            governedDocuments: docResults,
            complianceMappings: complianceResults,
            operationalHistory: historyResults,
          },
          governance: {
            maiClassification: maiLevel,
            auditId: entry.id,
            envelopeHash,
            retrievedAt,
            sourcesQueried,
            denials,
          },
        };

        // ─── Record to Forensic Ledger ───
        const durationMs = Date.now() - startMs;
        entry.addMetadata('maiClassification', maiLevel);
        entry.addMetadata('envelopeId', envelopeId);
        entry.addMetadata('envelopeHash', envelopeHash);
        entry.addMetadata('sourcesQueried', sourcesQueried.join(','));
        entry.addMetadata('packsReturned', packResults.count);
        entry.addMetadata('chunksReturned', docResults.count);
        entry.addMetadata('complianceMappings', complianceResults.count);
        entry.addMetadata('operationalHistoryEntries', historyResults.count);
        entry.addMetadata('timeWindow', historyResults.timeWindow || 'none');
        entry.addMetadata('denials', denials.length);
        entry.addMetadata('durationMs', durationMs);

        const score = engine.scorer.scoreDefault('request-context');
        const completedEntry = entry.complete(score, {
          classification: maiLevel,
          confidence: 0.95,
          rationale: `Governed context delivered: ${packResults.count} packs, ${docResults.count} chunks, ${complianceResults.count} mappings, ${historyResults.count} history entries. ${denials.length} denials. ${durationMs}ms.`,
          requiresGate: maiLevel === MaiClassification.MANDATORY,
        });
        engine.ledger.record(completedEntry);

        // Emit telemetry
        engine.telemetryService.emitToolCall(
          'request_context',
          entry.id,
          maiLevel,
          true,
          undefined,
          input.agent_id
        );

        // Record threshold
        engine.thresholdMonitor.record({
          classification: maiLevel,
          confidence: 0.95,
          rationale: `Context authority: ${input.context_class}`,
          requiresGate: maiLevel === MaiClassification.MANDATORY,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(envelope, null, 2),
          }],
        };

      } catch (error) {
        // Record failure
        const failedEntry = entry.fail(
          error instanceof Error ? error : new Error('Context authority failed'),
          MaiClassification.MANDATORY
        );
        engine.ledger.record(failedEntry);

        engine.telemetryService.emitToolCall(
          'request_context',
          entry.id,
          'MANDATORY',
          false,
          undefined,
          input.agent_id
        );

        if (error instanceof GovernedError) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(error.toPublicResponse()),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'CONTEXT_AUTHORITY_FAILED',
              message: error instanceof Error ? error.message : 'Unknown error',
              auditId: entry.id,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
