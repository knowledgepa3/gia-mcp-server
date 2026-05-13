/**
 * @module    mcp-tool-institution
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       A — list/read (advisory); M — convene session (mandatory gate possible)
 * @audit     true — all convene operations logged to forensic ledger
 * @owner     William J. Storey III / ACE / GIA
 *
 * Governed Organizational Architecture MCP Tools
 *
 * Exposes GIA's Board Room — Institutions, Charters, and governed Sessions —
 * to any MCP-connected client (ChatGPT, Claude, Gemini, Claude Code).
 *
 * Five tools:
 *   board_list_institutions  — List all institutions in the governance org chart
 *   board_list_charters      — List charters (committees/boards) under an institution
 *   board_convene_session    — Convene a governed deliberation session for a charter
 *   board_get_session        — Retrieve session status and output
 *   board_install_kit        — Install a prebuilt Institution Kit (org chart template)
 *
 * USAGE PATTERN:
 *   1. board_list_institutions → pick institution_id
 *   2. board_list_charters(institution_id) → pick charter_id
 *   3. board_convene_session(institution_id, charter_id, topic) → get session_id
 *   4. board_get_session(session_id) → read deliberation output + consensus
 *
 * DELIBERATION MODES (set in charter):
 *   parallel    — all seats respond independently, synthesizer merges
 *   chain       — each seat builds on the previous (sequential reasoning)
 *   adversarial — proposer + devil's advocate + arbiter structure
 *   roundtable  — multi-round Delphi method, positions refine across rounds
 *   auto        — GIA selects best mode for the topic
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The API base URL — defaults to local Express server (matches governed-retrieval pattern)
const API_BASE = process.env.GIA_API_URL || 'http://localhost:3001';
const API_KEY  = process.env.GIA_API_KEY  || '';

class BoardApiError extends Error {
  constructor(
    public readonly statusCode: number | null,
    public readonly apiPath: string,
    public readonly userMessage: string,
    originalMessage: string,
  ) {
    super(originalMessage);
    this.name = 'BoardApiError';
  }
}

async function apiCall(path: string, method: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: unknown) {
    // Network-level failure: server down, DNS fail, connection refused
    const msg = err instanceof Error ? err.message : 'Unknown network error';
    const envDiag = [
      `GIA_API_URL: ${process.env.GIA_API_URL ? 'set' : 'NOT SET (using default: http://localhost:3001)'}`,
      `GIA_API_KEY: ${process.env.GIA_API_KEY ? 'set' : 'NOT SET'}`,
      `GIA_SERVER_URL: ${process.env.GIA_SERVER_URL ? 'set' : 'NOT SET'}`,
    ].join(', ');
    throw new BoardApiError(
      null, path,
      `Board API unavailable at ${API_BASE}. Check that the Express server is running. Env: ${envDiag}. (${msg})`,
      `API ${method} ${path} → network error: ${msg}`,
    );
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new BoardApiError(
      res.status, path,
      `Board API returned ${res.status} for ${method} ${path}. ${res.status === 503 ? 'Server may be restarting — retry in 30 seconds.' : errText.slice(0, 200)}`,
      `API ${method} ${path} → ${res.status}: ${errText.slice(0, 300)}`,
    );
  }

  return res.json();
}

/** Wraps tool handlers to catch BoardApiError and return user-facing error responses. */
function boardErrorResponse(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (err instanceof BoardApiError) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: 'BOARD_API_ERROR',
        statusCode: err.statusCode,
        path: err.apiPath,
        message: err.userMessage,
      }, null, 2) }],
      isError: true,
    };
  }
  // Re-throw unexpected errors
  throw err;
}

export function registerInstitutionTools(server: McpServer): void {

  // =========================================================================
  // board_list_institutions — list all governed institutions
  // =========================================================================
  server.tool(
    'board_list_institutions',
    'List all institutions in the GIA Governed Organizational Architecture. Each institution is a governed body (e.g. Architecture Review Board, Federal AI Board) with its own charter hierarchy. Returns institution IDs needed to convene sessions.',
    {},
    { title: 'List Institutions', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const data = await apiCall('/api/institution', 'GET') as any;
        const institutions = (data.institutions || data || []) as any[];

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            count: institutions.length,
            institutions: institutions.map((i: any) => ({
              institution_id:       i.institution_id,
              name:                 i.name,
              description:          i.description,
              status:               i.status,
              compliance_frameworks: i.compliance_frameworks,
              created_at:           i.created_at,
            })),
            next_step: institutions.length > 0
              ? `Call board_list_charters with institution_id from above to see committees`
              : `Call board_install_kit to install a prebuilt institution template`,
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );

  // =========================================================================
  // board_list_charters — list charters under an institution
  // =========================================================================
  server.tool(
    'board_list_charters',
    'List all charters (boards, committees, subcommittees) under a governed institution. Returns charter IDs, types, deliberation modes, seat configurations, and status. Use charter_id to convene sessions.',
    {
      institution_id: z.string().describe('Institution ID from board_list_institutions'),
    },
    { title: 'List Charters', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const data = await apiCall(`/api/institution/${args.institution_id}/charters`, 'GET') as any;
        const charters = (data.charters || data || []) as any[];

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            institution_id: args.institution_id,
            count: charters.length,
            charters: charters.map((c: any) => ({
              charter_id:    c.charter_id,
              name:          c.name,
              short_code:    c.short_code,
              type:          c.type,
              status:        c.status,
              parent_id:     c.parent_id,
              deliberation_mode: c.charter_document?.deliberation?.mode,
              seat_count:    c.charter_document?.membership?.seats?.length,
              seats:         c.charter_document?.membership?.seats?.map((s: any) => ({
                role: s.role, label: s.label, model: s.model,
              })),
              decision_rights: {
                mandatory:    c.charter_document?.decisionRights?.mandatory,
                advisory:     c.charter_document?.decisionRights?.advisory,
                prohibited:   c.charter_document?.decisionRights?.prohibited,
              },
              cadence: c.cadence,
              compliance_frameworks: c.compliance_frameworks,
            })),
            next_step: `Call board_convene_session with institution_id and charter_id to start a governed deliberation`,
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );

  // =========================================================================
  // board_convene_session — start a governed deliberation
  // =========================================================================
  server.tool(
    'board_convene_session',
    'Convene a governed deliberation session for a charter. Each seat (AI model with a specific role) deliberates on the topic according to the charter\'s mode (parallel/chain/adversarial/roundtable/auto). Returns a session_id — use board_get_session to retrieve the output once complete. Typical runtime: 30–120 seconds depending on seat count and mode.',
    {
      institution_id: z.string().describe('Institution ID'),
      charter_id:     z.string().describe('Charter ID of the board or committee to convene'),
      topic:          z.string().describe('The question, decision, or matter to deliberate on. Be specific — this is what every seat will reason about.'),
      context:        z.string().optional().describe('Additional background context, documents, or data to inject into all seat prompts'),
    },
    { title: 'Convene Governed Session', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const data = await apiCall(
          `/api/institution/${args.institution_id}/charter/${args.charter_id}/convene`,
          'POST',
          {
            topic:       args.topic,
            context:     args.context,
            triggeredBy: 'mcp-client',
          }
        ) as any;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            session_id:     data.sessionId || data.session_id,
            charter_id:     args.charter_id,
            institution_id: args.institution_id,
            topic:          args.topic,
            status:         data.status || 'running',
            message:        data.message || 'Session convened — deliberation in progress',
            next_step:      `Call board_get_session with session_id "${data.sessionId || data.session_id}" to retrieve the deliberation output. Sessions typically complete in 30–90 seconds.`,
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );

  // =========================================================================
  // board_get_session — retrieve session output
  // =========================================================================
  server.tool(
    'board_get_session',
    'Retrieve the status and output of a governed deliberation session. Returns each seat\'s position, the synthesized consensus output, dissenting views, and the governance record. If still running, status will be "running" — poll again in 10–15 seconds.',
    {
      institution_id: z.string().describe('Institution ID'),
      charter_id:     z.string().describe('Charter ID'),
      session_id:     z.string().describe('Session ID from board_convene_session'),
    },
    { title: 'Get Session Output', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const data = await apiCall(
          `/api/institution/${args.institution_id}/charter/${args.charter_id}/sessions/${args.session_id}`,
          'GET'
        ) as any;

        const session = data.session || data;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            session_id:     args.session_id,
            status:         session.status,
            topic:          session.topic,
            started_at:     session.started_at,
            completed_at:   session.completed_at,
            deliberation_mode: session.deliberation_mode,
            // Core output
            consensus_output:  session.consensus_output,
            dissent_record:    session.dissent_record,
            // Seat-level positions
            seat_outputs: session.seat_outputs,
            // Governance record
            governance: {
              charter_id:     args.charter_id,
              institution_id: args.institution_id,
              sealed_as_pack: session.knowledge_pack_id,
              audit_ref:      session.audit_ref,
            },
            // Gate info — surfaces when session needs human approval
            gate_id: session.gate_id || session.gateId || undefined,
            board_id: session.board_id || session.boardId || undefined,
            mai_level: session.mai_level || session.maiLevel || undefined,
            note: session.status === 'deliberating' || session.status === 'running'
              ? 'Session still in progress — call again in 15 seconds'
              : session.status === 'pending-gate'
              ? `MANDATORY gate requires human approval. Call board_approve_gate with gate_id "${session.gate_id || session.gateId}" to approve.`
              : session.status === 'complete' || session.status === 'completed'
              ? 'Deliberation complete — consensus_output contains the governed result'
              : null,
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );

  // =========================================================================
  // board_install_kit — install a prebuilt institution template
  // =========================================================================
  server.tool(
    'board_install_kit',
    'Install a prebuilt Institution Kit — a complete governed org chart template with sealed charters ready to convene. Three kits available: "engineering-suite" (ARB + RAB for tech teams), "federal-ai-board" (ARMB + AEOB, NIST/CMMC/FedRAMP/EO14110 aligned), "eu-ai-risk-council" (HRAAB + CAB, EU AI Act + GDPR aligned). Each kit creates an institution with multiple charters, all pre-sealed and ready to use.',
    {
      kit_id: z.enum(['engineering-suite', 'federal-ai-board', 'eu-ai-risk-council'])
        .describe('Which prebuilt kit to install'),
    },
    { title: 'Install Institution Kit', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const data = await apiCall(`/api/institution/kits/${args.kit_id}/install`, 'POST') as any;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            kit_id:         args.kit_id,
            institution_id: data.institutionId,
            name:           data.name,
            charter_count:  data.charterCount,
            message:        data.message,
            next_step:      `Kit installed. Call board_list_charters with institution_id "${data.institutionId}" to see the sealed charters, then board_convene_session to start deliberating.`,
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );

  // =========================================================================
  // board_approve_gate — approve a MANDATORY governance gate
  // =========================================================================
  server.tool(
    'board_approve_gate',
    'Approve a MANDATORY governance gate on a deliberation session. When a board session reaches "pending-gate" status, a human must approve the output before it finalizes. This is the human-in-the-loop enforcement mechanism. After approval, the session transitions to "complete" and the full deliberation output becomes available via board_get_session.',
    {
      gate_id:     z.string().describe('Gate ID from the session status (e.g. "gate-rb-xxx-yyy")'),
      approved_by: z.string().describe('Identity of the human approver (e.g. "william.storey")'),
      rationale:   z.string().optional().describe('Reason for approval — recorded in the forensic audit chain'),
    },
    { title: 'Approve MANDATORY Gate', readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        const data = await apiCall(
          `/api/reasoning-board/gate/${args.gate_id}/approve`,
          'POST',
          {
            approved_by: args.approved_by,
            rationale:   args.rationale || 'Approved via MCP tool',
          }
        ) as any;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            gate_id:    args.gate_id,
            status:     data.status || 'approved',
            approved_by: args.approved_by,
            message:    'MANDATORY gate approved — deliberation output is now finalized.',
            next_step:  'Call board_get_session to retrieve the complete deliberation output.',
          }, null, 2) }],
        };
      } catch (err: unknown) {
        return boardErrorResponse(err);
      }
    }
  );
}
