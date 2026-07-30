/**
 * @module    gia-agent-hooks
 * @layer     SDK
 * @inherits  governance-root
 * @mai       M — all tool executions governed; gates enforced at hook boundary
 * @audit     true — every tool call recorded to forensic ledger via MCP
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA Governance Hooks for Claude Agent SDK
 *
 * Drop-in governance layer for any Claude Agent SDK agent.
 * Wraps PreToolUse, PostToolUse, SubagentStart, SubagentStop,
 * and Stop hooks to enforce MAI classification, gate approval,
 * forensic ledger recording, and provenance tracking.
 *
 * Works with ANY vendor's agents — Claude Agent SDK is one surface,
 * but GIA governs all of them through the same MCP protocol.
 *
 * Usage:
 *   import { createGiaGovernanceHooks } from './gia-agent-hooks';
 *
 *   const hooks = createGiaGovernanceHooks({
 *     giaUrl: 'https://gia.aceadvising.com',
 *     apiKey: process.env.GIA_API_KEY,
 *     domain: 'general',
 *     operatorId: 'steelcase-pilot',
 *   });
 *
 *   // Pass to Claude Agent SDK
 *   for await (const msg of query({
 *     prompt: 'Analyze the codebase',
 *     options: { hooks, allowedTools: ['Read', 'Glob', 'Grep'] }
 *   })) { ... }
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface GiaHookConfig {
  /** GIA platform URL (e.g. https://gia.aceadvising.com) */
  giaUrl: string;
  /** GIA API key for MCP authentication */
  apiKey: string;
  /** Governance domain (e.g. 'general', 'va-claims', 'finance', 'eu-ai-act') */
  domain: string;
  /** Operator/tenant identifier for audit trail */
  operatorId: string;
  /** If true, MANDATORY gates block tool execution until approved. Default: true */
  enforceGates?: boolean;
  /**
   * Fail-safe posture when GIA governance is UNREACHABLE (the classify call
   * throws — network error, 5xx, auth failure, timeout). This is distinct from
   * a successful classification.
   *   - 'closed' (default): deny any non-bypassed tool and notify the operator.
   *     The agent cannot prove the action is governed, so secure-by-default
   *     blocks it. Read-only tools on `bypassTools` are unaffected (they never
   *     reach classification). This makes "governs everything" hold even when
   *     GIA is down — the gap a security review probes first.
   *   - 'open': allow with a warning (availability over safety). Use only when
   *     an ungoverned action is acceptable for the domain. The pre-hardening
   *     behavior.
   * Ignored when `enforceGates` is false (advisory-only mode never blocks).
   * Default: 'closed'
   */
  failSafe?: 'closed' | 'open';
  /** Gate approval timeout in ms. Default: 300000 (5 minutes) */
  gateTimeoutMs?: number;
  /** Tools that bypass governance (e.g. Read, Glob — read-only). Default: [] */
  bypassTools?: string[];
  /** Callback for gate approval notifications (e.g. mobile push, Slack) */
  onGateRequired?: (gateInfo: GateNotification) => void | Promise<void>;
}

interface GateNotification {
  gateId: string;
  operation: string;
  classification: string;
  toolName: string;
  message: string;
}

interface MaiClassification {
  classification: 'MANDATORY' | 'ADVISORY' | 'INFORMATIONAL';
  confidence: number;
  rationale: string;
  requiresGate: boolean;
}

// Hook callback type (matches Claude Agent SDK HookCallback signature)
type HookCallback = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  context: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>;

// ─── MCP Client Helper ───────────────────────────────────────────────────────

async function giaMcpCall(
  config: GiaHookConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${config.giaUrl}/api/gia/tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ tool: toolName, arguments: args }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`GIA MCP ${toolName} failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return res.json();
}

// ─── Governance Hook Factory ─────────────────────────────────────────────────

/**
 * Creates a complete governance hook set for the Claude Agent SDK.
 *
 * Returned object maps directly to the Agent SDK `hooks` option:
 *
 *   const hooks = createGiaGovernanceHooks({ ... });
 *   query({ prompt: '...', options: { hooks } });
 *
 * Three enforcement layers:
 *   1. PreToolUse  — MAI classification + gate enforcement (blocks if MANDATORY)
 *   2. PostToolUse — Forensic ledger recording + provenance
 *   3. Subagent    — Delegation chain tracking
 */
export function createGiaGovernanceHooks(config: GiaHookConfig): Record<string, Array<{ matcher?: string; hooks: HookCallback[] }>> {
  const enforceGates = config.enforceGates ?? true;
  const failSafe = config.failSafe ?? 'closed';
  const gateTimeoutMs = config.gateTimeoutMs ?? 300_000;
  const bypassTools = new Set(config.bypassTools ?? []);

  // Track active operations for ledger correlation
  const activeOps = new Map<string, { auditId: string; startTime: number; classification: MaiClassification }>();

  // ── Layer 1: PreToolUse — Classify + Gate ────────────────────────────────

  const governanceGate: HookCallback = async (input, toolUseId, _context) => {
    const toolName = (input as Record<string, unknown>).tool_name as string;
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>;

    // Bypass read-only tools
    if (bypassTools.has(toolName)) {
      return {};
    }

    try {
      // Step 1: Classify the decision via GIA MAI
      const classifyResult = await giaMcpCall(config, 'classify_decision', {
        decision: `Agent executing ${toolName}${toolInput ? `: ${JSON.stringify(toolInput).slice(0, 200)}` : ''}`,
        domain: config.domain,
        is_client_facing: true,
      }) as { classification: MaiClassification };

      const mai = classifyResult.classification ?? classifyResult as unknown as MaiClassification;
      const classification = typeof mai === 'string' ? mai : (mai as MaiClassification).classification;

      // Track for PostToolUse correlation
      if (toolUseId) {
        activeOps.set(toolUseId, {
          auditId: `sdk-${toolUseId}`,
          startTime: Date.now(),
          classification: typeof mai === 'object' ? mai : { classification: classification as MaiClassification['classification'], confidence: 0.8, rationale: '', requiresGate: classification === 'MANDATORY' },
        });
      }

      // Step 2: Gate enforcement for MANDATORY decisions
      if (classification === 'MANDATORY' && enforceGates) {
        // Notify operator that approval is required
        if (config.onGateRequired) {
          await Promise.resolve(config.onGateRequired({
            gateId: `gate-sdk-${toolUseId ?? Date.now()}`,
            operation: toolName,
            classification: 'MANDATORY',
            toolName,
            message: `MANDATORY gate: agent wants to execute ${toolName}. Approve via GIA dashboard.`,
          }));
        }

        // Block execution — inject system message explaining why
        return {
          systemMessage: `[GIA GOVERNANCE] Tool "${toolName}" classified as MANDATORY. Human approval required before execution. The operator has been notified.`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `GIA MAI classification: MANDATORY — requires human approval. Gate ID: gate-sdk-${toolUseId ?? 'unknown'}`,
          },
        };
      }

      // ADVISORY: allow but inject governance context
      if (classification === 'ADVISORY') {
        return {
          systemMessage: `[GIA] Tool "${toolName}" classified as ADVISORY. Proceeding with governance logging.`,
        };
      }

      // INFORMATIONAL: allow silently
      return {};

    } catch (err: unknown) {
      // Governance-aware error handling: classification is UNAVAILABLE (GIA
      // unreachable / 5xx / auth / timeout). We cannot prove this non-bypassed
      // tool is safe — bypass (read-only) tools already returned above.
      const msg = err instanceof Error ? err.message : 'Unknown GIA error';

      // Advisory-only mode (enforceGates=false) or explicit availability opt-in
      // (failSafe='open') => fail open with a warning. This is the pre-hardening
      // behavior, now gated behind explicit configuration.
      if (!enforceGates || failSafe === 'open') {
        return {
          systemMessage: `[GIA] Governance classification unavailable (${msg}). Proceeding without gate enforcement.`,
        };
      }

      // Secure-by-default: FAIL CLOSED. The action could not be governed, so it
      // is denied and the operator is notified. The security decision must not
      // depend on the notification succeeding, so it is best-effort.
      if (config.onGateRequired) {
        try {
          await Promise.resolve(config.onGateRequired({
            gateId: `gate-sdk-failclosed-${toolUseId ?? Date.now()}`,
            operation: toolName,
            classification: 'UNKNOWN',
            toolName,
            message: `GIA governance UNREACHABLE (${msg}). Tool "${toolName}" denied (fail-closed). Restore GIA connectivity, or set failSafe:'open' to allow ungoverned execution.`,
          }));
        } catch {
          // Notification channel failure must not unblock the denial.
        }
      }

      return {
        systemMessage: `[GIA GOVERNANCE] Tool "${toolName}" DENIED — governance classification unavailable (${msg}) and fail-safe posture is 'closed'. The action could not be governed, so it was blocked. Operator notified.`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `GIA governance unreachable — fail-closed denial. Cannot verify MAI classification for "${toolName}".`,
        },
      };
    }
  };

  // ── Layer 2: PostToolUse — Ledger Recording ──────────────────────────────

  const ledgerRecorder: HookCallback = async (input, toolUseId, _context) => {
    const toolName = (input as Record<string, unknown>).tool_name as string;

    // Skip bypass tools
    if (bypassTools.has(toolName)) {
      return {};
    }

    try {
      // Record to GIA audit pipeline (fire-and-forget pattern)
      const opData = toolUseId ? activeOps.get(toolUseId) : undefined;
      const durationMs = opData ? Date.now() - opData.startTime : 0;

      await giaMcpCall(config, 'record_governance_event', {
        event_type: 'gate_triggered',
        details: JSON.stringify({
          source: 'claude-agent-sdk',
          toolName,
          toolUseId,
          operatorId: config.operatorId,
          domain: config.domain,
          classification: opData?.classification?.classification ?? 'INFORMATIONAL',
          durationMs,
          timestamp: new Date().toISOString(),
        }),
      });

      // Clean up tracking
      if (toolUseId) activeOps.delete(toolUseId);

    } catch {
      // Fire-and-forget: don't block agent on ledger write failures
    }

    return {};
  };

  // ── Layer 3: Subagent Tracking ───────────────────────────────────────────

  const subagentGovernance: HookCallback = async (input, _toolUseId, _context) => {
    const agentId = (input as Record<string, unknown>).agent_id as string | undefined;

    try {
      await giaMcpCall(config, 'record_governance_event', {
        event_type: 'gate_triggered',
        details: JSON.stringify({
          source: 'claude-agent-sdk',
          event: (input as Record<string, unknown>).hook_event_name,
          agentId,
          operatorId: config.operatorId,
          domain: config.domain,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Fire-and-forget
    }

    return {};
  };

  // ── Layer 4: Session Stop — Final Audit ──────────────────────────────────

  const sessionAudit: HookCallback = async (_input, _toolUseId, _context) => {
    try {
      await giaMcpCall(config, 'record_value_metric', {
        workflow_id: `sdk-session-${Date.now()}`,
        workflow_type: 'agent-sdk-session',
        agent_id: config.operatorId,
        autonomy_level: 'delegate',
        time_saved_minutes: 0, // Operator fills in post-session
        success: true,
      });
    } catch {
      // Fire-and-forget
    }

    return {};
  };

  // ── Assemble Hook Configuration ──────────────────────────────────────────

  return {
    PreToolUse: [
      // Governance gate runs on ALL tool calls (bypass list handled in callback)
      { hooks: [governanceGate] },
    ],
    PostToolUse: [
      // Ledger recording runs on ALL tool calls
      { hooks: [ledgerRecorder] },
    ],
    SubagentStart: [
      { hooks: [subagentGovernance] },
    ],
    SubagentStop: [
      { hooks: [subagentGovernance] },
    ],
    Stop: [
      { hooks: [sessionAudit] },
    ],
  };
}

// ─── Convenience: Quick Setup ────────────────────────────────────────────────

/**
 * Quick setup for governed Claude Agent SDK agents.
 *
 * Returns the full options object ready to pass to query():
 *
 *   const options = giaGovernedAgent({
 *     giaUrl: 'https://gia.aceadvising.com',
 *     apiKey: process.env.GIA_API_KEY!,
 *     domain: 'eu-ai-act',
 *     operatorId: 'steelcase-pilot',
 *     allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
 *   });
 *
 *   for await (const msg of query({ prompt: '...', options })) { ... }
 */
export function giaGovernedAgent(config: GiaHookConfig & {
  allowedTools?: string[];
  agents?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
}): Record<string, unknown> {
  const hooks = createGiaGovernanceHooks(config);

  return {
    hooks,
    allowedTools: config.allowedTools ?? ['Read', 'Glob', 'Grep'],
    ...(config.agents ? { agents: config.agents } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
  };
}
