/**
 * @module    mcp-tool-governed-retrieval
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       ADVISORY — retrieval operations are permission-checked and audited
 * @audit     true — every retrieval and ingestion logged with full provenance
 * @owner     William J. Storey III / ACE / GIA
 *
 * Governed Retrieval MCP Tools — Hash-Verified, Permission-Checked Document Retrieval
 *
 * GIA doesn't just search documents — it governs retrieval.
 * Every chunk is hash-verified, permission-checked, TTL-enforced, and fully audited.
 *
 * Two tools:
 *   gia_retrieve          — Governed semantic search with verification
 *   gia_ingest_document   — Governed document ingestion with chunking and hashing
 *
 * NIST 800-53: AC-3 (Access Enforcement), AU-3 (Content of Audit Records),
 *              SI-7 (Software/Information Integrity), SC-28 (Protection of Information at Rest)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The API base URL — defaults to local Express server
const API_BASE = process.env.GIA_API_URL || 'http://localhost:3001';
const API_KEY = process.env.GIA_API_KEY || '';

/**
 * Structured retrieval error surfaced across the MCP boundary.
 *
 * Mirrors `RetrievalErrorBody` from
 * `server/src/services/retrievalTypes.ts` — keeps this tool free of a
 * cross-package type import while preserving the wire contract. The server
 * returns `{ error: { code, message, details? } }` on any failure; we
 * unwrap it here so MCP clients get the code, not a flattened 500.
 */
class RetrievalApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, httpStatus: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RetrievalApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function apiCall<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let code = 'INTERNAL_ERROR';
    let message = `API call failed: ${res.status}`;
    let details: Record<string, unknown> | undefined;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
      if (parsed && typeof parsed === 'object' && parsed.error) {
        code = parsed.error.code || code;
        message = parsed.error.message || message;
        details = parsed.error.details;
      }
    } catch {
      try {
        const text = await res.text();
        if (text) message = `${message}: ${text}`;
      } catch { /* swallow */ }
    }
    throw new RetrievalApiError(code, message, res.status, details);
  }

  return res.json() as Promise<T>;
}

function errorPayload(
  err: unknown,
  tool: string,
  context: Record<string, unknown>,
): { error: true; code: string; message: string; httpStatus?: number; details?: Record<string, unknown>; tool: string } & Record<string, unknown> {
  if (err instanceof RetrievalApiError) {
    return {
      error: true,
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
      details: err.details,
      tool,
      ...context,
    };
  }
  return {
    error: true,
    code: 'INTERNAL_ERROR',
    message: errMsg(err),
    tool,
    ...context,
  };
}

export function registerGovernedRetrievalTools(server: McpServer): void {

  // =========================================================================
  // gia_retrieve — Governed semantic search
  // =========================================================================
  server.tool(
    'gia_retrieve',
    'Governed semantic search — hash-verified, permission-checked, TTL-enforced document retrieval with full audit trail. Every retrieval is logged: what was retrieved, was it authorized, was it tampered with. When charter_id is provided, the retrieval is bound to that charter\'s contextAccess enforcement (domain allow/denyList, trust floor, classification floor, max chunks per query) and refusals are recorded with full provenance. classification_floor (MANDATORY|ADVISORY|INFORMATIONAL) lets callers demand the stricter of their own floor vs the charter\'s — chunks below the effective floor are denied with CLASSIFICATION_BELOW_FLOOR. Classification: ADVISORY — read-only search, results are permission-gated.',
    {
      query: z.string().describe('Search query — what information to find'),
      domain: z.string().describe('Domain to search within (e.g., va-claims, finance, eu-ai-act)'),
      max_results: z.number().optional().default(5).describe('Maximum chunks to return (default 5)'),
      similarity_threshold: z.number().optional().default(0.7).describe('Minimum similarity score 0-1 (default 0.7)'),
      agent_id: z.string().describe('Agent performing the retrieval'),
      run_id: z.string().optional().describe('Current run/pipeline ID'),
      charter_id: z.string().optional().describe('Optional charter ID — when set, retrieval is enforced against the charter\'s contextAccess block (domain allow/denyList, trust floor, classification floor, max chunks). Refusals are audit-logged with refusedAtCharterGate marker.'),
      classification_floor: z.enum(['MANDATORY', 'ADVISORY', 'INFORMATIONAL']).optional().describe('Minimum chunk classification to return. Combined with charter floor via stricter-wins — callers cannot relax charter authority.'),
    },
    {
      title: 'Governed Document Retrieval',
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      try {
        const result = await apiCall<unknown>('/api/retrieval/search', 'POST', {
          query: args.query,
          domains: [args.domain],
          maxResults: args.max_results,
          similarityThreshold: args.similarity_threshold,
          agentId: args.agent_id,
          runId: args.run_id,
          charterId: args.charter_id,
          classificationFloor: args.classification_floor,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              errorPayload(err, 'gia_retrieve', {
                query: args.query,
                domain: args.domain,
                charter_id: args.charter_id,
                classification_floor: args.classification_floor,
              }),
              null,
              2,
            ),
          }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // gia_ingest_document — Governed document ingestion
  // =========================================================================
  server.tool(
    'gia_ingest_document',
    'Governed document ingestion — upload text content for governed retrieval. Content is chunked, embedded, hash-verified, and stored with full audit trail. Each chunk gets SHA-256 integrity hash. Classification: ADVISORY — creates governed content, audited.',
    {
      title: z.string().describe('Document title'),
      content: z.string().describe('Full text content to ingest'),
      domain: z.string().describe('Domain classification (e.g., va-claims, finance, eu-ai-act)'),
      trust_level: z.enum(['SYSTEM', 'ORG', 'CASE', 'EPHEMERAL']).default('CASE').describe('Trust level (SYSTEM > ORG > CASE > EPHEMERAL)'),
      classification: z.enum(['MANDATORY', 'ADVISORY', 'INFORMATIONAL']).optional().describe('Document classification. Controls which retrievals can surface it when a classification floor is in force (MANDATORY > ADVISORY > INFORMATIONAL). Defaults to ADVISORY.'),
      allowed_roles: z.array(z.string()).optional().describe('Roles allowed to retrieve this document'),
      ttl_hours: z.number().optional().describe('Time-to-live in hours (auto-expires)'),
    },
    {
      title: 'Governed Document Ingestion',
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (args) => {
      try {
        const result = await apiCall<unknown>('/api/retrieval/ingest', 'POST', {
          title: args.title,
          content: args.content,
          filename: `${args.title.toLowerCase().replace(/\s+/g, '-')}.txt`,
          domain: args.domain,
          trustLevel: args.trust_level,
          classification: args.classification,
          allowedRoles: args.allowed_roles,
          ttlHours: args.ttl_hours,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              errorPayload(err, 'gia_ingest_document', {
                title: args.title,
                domain: args.domain,
                classification: args.classification,
              }),
              null,
              2,
            ),
          }],
          isError: true,
        };
      }
    }
  );
}
