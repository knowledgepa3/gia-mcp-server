/**
 * @module    mcp/tools/value-report
 * @layer     MCP (thin wrapper — NO valuation logic here, per the thin-wrapper rule)
 * @inherits  Express services/economics via /api/economics/reports (colony.ts fetch precedent)
 * @mai       Informational — creates a DRAFT report only; release is a human
 *            MANDATORY action available exclusively to the authenticated ISSO
 *            (this tool deliberately has NO release/revoke capability)
 * @audit     Server-side: the Express service anchors economics.value_report.created
 *            to the forensic ledger BEFORE persisting (anchor-first). This wrapper
 *            adds no second anchor and no new INSERT site.
 * @owner     William J. Storey III / ACE / GIA
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GovernanceEngine } from '../../core/governance.js';

const DRAFT_NOTE = 'DRAFT — release requires human ISSO approval via the authenticated console; this tool cannot release or revoke reports.';

export function registerValueReportTools(server: McpServer, _engine: GovernanceEngine): void {
  server.tool(
    'generate_value_report',
    'Generate a DRAFT ledger-anchored economic value report over real runtime sessions (three-scenario range, MEASURED/MODELED provenance, assumption-set hash on the forensic chain). Client-facing reports fail closed unless rates are BLS OEWS cited or client-declared with citations. Release is human-ISSO-only — agents propose, humans release.',
    {
      period_start: z.string().describe('ISO 8601 period start (inclusive), e.g. 2026-06-10T00:00:00.000Z'),
      period_end: z.string().describe('ISO 8601 period end (exclusive)'),
      tenant_id: z.string().max(100).optional().describe('Tenant scope; omit for platform-wide dogfood report'),
      client_facing: z.boolean().optional().describe('When true, generation FAILS CLOSED unless every rate is externally cited (BLS OEWS basis or client-declared overrides)'),
      rate_basis: z.enum(['internal', 'bls_oes']).optional().describe("'bls_oes' uses BLS OEWS 2025 cited median rates; default internal dogfood rates"),
      rate_overrides: z.array(z.object({
        role_key: z.string().max(100).describe("Rate row role key. The engine currently applies ONLY 'knowledge_worker_generalist' (the default row); any other roleKey is refused server-side rather than silently ignored"),
        hourly_base: z.number().gt(0).max(1000).describe('Client-declared base hourly rate (USD)'),
        loaded_multiplier: z.number().min(1).max(3).optional().describe('Loaded-cost multiplier (default 1.4)'),
        source: z.string().trim().min(8).max(300).describe('REQUIRED citation — who declared this rate and when'),
      })).max(8).optional().describe('CLIENT_DECLARED rate override for the default rate row; provenance is forced to CLIENT_DECLARED server-side'),
    },
    { title: 'Generate Value Report (draft)', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    async (input) => {
      const apiBase = process.env.GIA_API_URL || 'http://localhost:3001';
      // GIA_INTERNAL_API_KEY = server-side name; GIA_API_KEY = MCP container name (same value)
      const apiKey = process.env.GIA_INTERNAL_API_KEY || process.env.GIA_API_KEY || '';
      try {
        const resp = await fetch(`${apiBase}/api/economics/reports`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          // Bounded wait — a hung Express socket must not stall the MCP session.
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            periodStart: input.period_start,
            periodEnd: input.period_end,
            tenantId: input.tenant_id,
            clientFacing: input.client_facing,
            rateBasis: input.rate_basis,
            rateOverrides: input.rate_overrides?.map(o => ({
              roleKey: o.role_key,
              hourlyBase: o.hourly_base,
              loadedMultiplier: o.loaded_multiplier,
              source: o.source,
            })),
            // Ledger attribution: distinguishes MCP-originated drafts on the chain.
            requestedVia: 'mcp:generate_value_report',
          }),
        });

        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: (body as { error?: string }).error || `Report generation failed (HTTP ${resp.status})`, status: resp.status }, null, 2),
            }],
            isError: true,
          };
        }

        const r = body as {
          reportId: string; verifyCode: string; reportHash: string;
          result: {
            assumptionSetVersion: string; assumptionSetHash: string;
            totals: Record<string, number>; measurementCoverage: number;
            sessionsConsidered: number; sessionsValued: number; disclosures: string[];
          };
        };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: DRAFT_NOTE,
              reportId: r.reportId,
              verifyPath: `/api/economics/verify/${r.verifyCode}`,
              reportHash: r.reportHash,
              assumptionSetVersion: r.result.assumptionSetVersion,
              assumptionSetHash: r.result.assumptionSetHash,
              totals: r.result.totals,
              measurementCoverage: r.result.measurementCoverage,
              sessionsConsidered: r.result.sessionsConsidered,
              sessionsValued: r.result.sessionsValued,
              disclosures: r.result.disclosures,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `GIA API unreachable: ${err instanceof Error ? err.message : String(err)}` }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );
}
