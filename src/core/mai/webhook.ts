/**
 * @module    mai-webhook
 * @layer     GOVERNANCE
 * @inherits  ROOT
 * @mai       N/A - notification layer, no gate decisions
 * @audit     true - webhook dispatch is logged
 * @owner     William J. Storey III / ACE / GIA
 *
 * GATE WEBHOOK NOTIFICATION DISPATCHER
 *
 * Vendor-agnostic webhook notifications for MANDATORY gate lifecycle events.
 * Fires on gate creation, resolution (approve/reject), and timeout (fail-closed).
 *
 * Design:
 * - Fire-and-forget: never blocks the gate pipeline
 * - HMAC-SHA256 signature in X-GIA-Signature header for receiver verification
 * - 5-second timeout on HTTP calls
 * - Slack-compatible payload (text + blocks fields)
 * - Tenant config takes precedence over global config
 * - Errors are logged but never thrown
 */

import { createHmac } from 'crypto';
import { GOVERNANCE_CONFIG } from '../../config/governance.config.js';

// ─── ntfy.sh Native Integration ─────────────────────────────────────────────
// When GIA_GATE_WEBHOOK_URL is not set, fall back to ntfy.sh push notifications.
// This bridges the MCP gate lifecycle to the operator's phone.
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';

/**
 * Send a push notification to ntfy.sh for MANDATORY gate events.
 * Fire-and-forget — errors logged, never thrown.
 */
async function sendNtfyNotification(
  title: string,
  message: string,
  priority: 'urgent' | 'high' | 'default' = 'high',
  gateId?: string,
  tags?: string[]
): Promise<void> {
  if (!NTFY_TOPIC) return;

  try {
    const headers: Record<string, string> = {
      'Title': title,
      'Priority': priority,
      'Tags': (tags || ['rotating_light', 'lock']).join(','),
    };

    // NOTE: No approve/deny action buttons here. This notifier runs inside
    // gia-mcp-server, a separate process from the main `server/` app — it has
    // no access to server/'s in-memory single-use approval tokens
    // (server/src/srt/gateNotifier.ts's tokenStore), and /api/gia/gates/:id/approve
    // requires requireAuth, so an unauthenticated ntfy tap against that URL
    // always 401s. Resolution for this gate still works: gate.ts's polling loop
    // reads gate_approvals_persistent by gate_id (no token needed) for the
    // operator console / board_approve_gate / operator.ts dashboard paths.
    void gateId;

    const url = `${NTFY_URL}/${NTFY_TOPIC}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    await fetch(url, {
      method: 'POST',
      headers,
      body: message,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    console.error(`[Gate-ntfy] Sent: ${title}`);
  } catch (err) {
    console.error('[Gate-ntfy] Failed:', (err as Error).message);
  }
}

// --- Types -------------------------------------------------------------------

export interface IWebhookGatePayload {
  event: 'gate_created' | 'gate_resolved' | 'gate_expired';
  gateId: string;
  decision: string;
  classification: string;
  rationale: string;
  confidence?: number;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  action?: string;
  text: string;
  blocks: SlackBlock[];
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

export interface IWebhookConfig {
  url: string;
  secret?: string;
}

// --- Tenant config resolver --------------------------------------------------

/**
 * Resolve webhook config for a tenant.
 * Priority: tenant policy config > global env/config.
 * Returns null if no webhook URL is configured.
 */
let tenantConfigResolver: ((tenantId?: string) => Promise<IWebhookConfig | null>) | null = null;

/**
 * Register a tenant-level config resolver.
 * Called once at startup from the server-side tenant policy integration.
 * The resolver queries tenant_policy_config for gateWebhookUrl/gateWebhookSecret.
 */
export function registerTenantWebhookResolver(
  resolver: (tenantId?: string) => Promise<IWebhookConfig | null>
): void {
  tenantConfigResolver = resolver;
}

async function resolveWebhookConfig(tenantId?: string): Promise<IWebhookConfig | null> {
  // Tenant-level config takes precedence
  if (tenantConfigResolver && tenantId) {
    try {
      const tenantConfig = await tenantConfigResolver(tenantId);
      if (tenantConfig) return tenantConfig;
    } catch {
      // Fall through to global config
    }
  }

  // Global config fallback
  const url = GOVERNANCE_CONFIG.gateWebhookUrl;
  if (!url) return null;

  return {
    url,
    secret: GOVERNANCE_CONFIG.gateWebhookSecret,
  };
}

// --- HMAC signing ------------------------------------------------------------

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// --- HTTP dispatch -----------------------------------------------------------

async function dispatchWebhook(
  config: IWebhookConfig,
  payload: IWebhookGatePayload
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'GIA-Governance/1.0',
  };

  if (config.secret) {
    headers['X-GIA-Signature'] = signPayload(body, config.secret);
  }

  // AbortController for 5-second timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (response.ok) {
      console.error(`[Gate-Webhook] ${payload.event} dispatched to ${config.url} (${response.status})`);
    } else {
      console.error(`[Gate-Webhook] ${payload.event} failed: ${config.url} responded ${response.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      console.error(`[Gate-Webhook] ${payload.event} timed out (5s) for ${config.url}`);
    } else {
      console.error(`[Gate-Webhook] ${payload.event} dispatch error: ${message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// --- Slack Block Kit helpers -------------------------------------------------

function buildGateCreatedBlocks(gate: IGateEventData): SlackBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'MANDATORY Gate Requires Approval', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Gate ID:*\n\`${gate.gateId}\`` },
        { type: 'mrkdwn', text: `*Classification:*\n${gate.classification}` },
        { type: 'mrkdwn', text: `*Operation:*\n${gate.operation}` },
        { type: 'mrkdwn', text: `*Owner:*\n${gate.ownerRole || 'isso'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Rationale:* ${gate.rationale || 'Human approval required'}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Created: ${gate.createdAt} | Expires: ${gate.expiresAt || 'N/A'}` },
      ],
    },
  ];
}

function buildGateResolvedBlocks(gate: IGateEventData, action: string): SlackBlock[] {
  const emoji = action === 'APPROVED' ? 'white_check_mark' : 'x';
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Gate ${action}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Gate ID:*\n\`${gate.gateId}\`` },
        { type: 'mrkdwn', text: `*Status:*\n:${emoji}: ${action}` },
        { type: 'mrkdwn', text: `*Operation:*\n${gate.operation}` },
        { type: 'mrkdwn', text: `*Resolved By:*\n${gate.resolvedBy || 'unknown'}` },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Resolved: ${gate.resolvedAt || new Date().toISOString()}` },
      ],
    },
  ];
}

function buildGateExpiredBlocks(gate: IGateEventData): SlackBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'MANDATORY Gate Expired (Fail-Closed)', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Gate ID:*\n\`${gate.gateId}\`` },
        { type: 'mrkdwn', text: `*Classification:*\n${gate.classification}` },
        { type: 'mrkdwn', text: `*Operation:*\n${gate.operation}` },
        { type: 'mrkdwn', text: `*Status:*\n:warning: TIMED_OUT` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*No human approval received within the configured timeout. Gate auto-denied (fail-closed).*' },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Created: ${gate.createdAt} | Expired: ${new Date().toISOString()}` },
      ],
    },
  ];
}

// --- Public API: gate event data ---------------------------------------------

export interface IGateEventData {
  gateId: string;
  classification: string;
  operation: string;
  rationale?: string;
  confidence?: number;
  ownerRole?: string;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  tenantId?: string;
}

// --- Public API: notification functions ---------------------------------------

/**
 * Notify webhook that a MANDATORY gate has been created and awaits approval.
 * Fire-and-forget - never blocks the gate pipeline.
 */
export function notifyGateCreated(gate: IGateEventData): void {
  // Async dispatch, errors caught internally
  void (async () => {
    try {
      const config = await resolveWebhookConfig(gate.tenantId);
      if (config) {
        const payload: IWebhookGatePayload = {
          event: 'gate_created',
          gateId: gate.gateId,
          decision: gate.operation,
          classification: gate.classification,
          rationale: gate.rationale || 'Human approval required',
          confidence: gate.confidence,
          createdAt: gate.createdAt,
          expiresAt: gate.expiresAt,
          text: `MANDATORY Gate Requires Approval: ${gate.operation} - ${gate.rationale || 'Human approval required'}`,
          blocks: buildGateCreatedBlocks(gate),
        };
        await dispatchWebhook(config, payload);
      }

      // ntfy.sh fallback — always send if topic is configured
      await sendNtfyNotification(
        `MANDATORY Gate: ${gate.operation}`,
        `Gate ${gate.gateId} requires human approval.\nOperation: ${gate.operation}\nOwner: ${gate.ownerRole || 'isso'}`,
        'urgent',
        gate.gateId,
        ['rotating_light', 'lock']
      );
    } catch (err) {
      console.error('[Gate-Webhook] notifyGateCreated error:', (err as Error).message);
    }
  })();
}

/**
 * Notify webhook that a gate has been resolved (approved or rejected).
 * Fire-and-forget - never blocks the gate pipeline.
 */
export function notifyGateResolved(gate: IGateEventData, action: 'APPROVED' | 'REJECTED' | 'BREAK_GLASS'): void {
  void (async () => {
    try {
      const config = await resolveWebhookConfig(gate.tenantId);
      if (config) {
        const payload: IWebhookGatePayload = {
          event: 'gate_resolved',
          gateId: gate.gateId,
          decision: gate.operation,
          classification: gate.classification,
          rationale: gate.rationale || `Gate ${action.toLowerCase()} by ${gate.resolvedBy || 'unknown'}`,
          confidence: gate.confidence,
          createdAt: gate.createdAt,
          resolvedAt: gate.resolvedAt || new Date().toISOString(),
          resolvedBy: gate.resolvedBy,
          action,
          text: `Gate ${action}: ${gate.operation} - ${action.toLowerCase()} by ${gate.resolvedBy || 'unknown'}`,
          blocks: buildGateResolvedBlocks(gate, action),
        };
        await dispatchWebhook(config, payload);
      }

      // ntfy.sh notification for resolution
      const emoji = action === 'APPROVED' ? 'white_check_mark' : action === 'BREAK_GLASS' ? 'warning' : 'x';
      await sendNtfyNotification(
        `Gate ${action}: ${gate.operation}`,
        `Gate ${gate.gateId} ${action.toLowerCase()} by ${gate.resolvedBy || 'unknown'}`,
        'default',
        undefined,
        [emoji]
      );
    } catch (err) {
      console.error('[Gate-Webhook] notifyGateResolved error:', (err as Error).message);
    }
  })();
}

/**
 * Notify webhook that a gate has expired (timed out, fail-closed).
 * Fire-and-forget - never blocks the gate pipeline.
 */
export function notifyGateExpired(gate: IGateEventData): void {
  void (async () => {
    try {
      const config = await resolveWebhookConfig(gate.tenantId);
      if (config) {
        const payload: IWebhookGatePayload = {
          event: 'gate_expired',
          gateId: gate.gateId,
          decision: gate.operation,
          classification: gate.classification,
          rationale: gate.rationale || 'Gate timed out - no human approval received',
          confidence: gate.confidence,
          createdAt: gate.createdAt,
          expiresAt: gate.expiresAt,
          text: `MANDATORY Gate Expired (Fail-Closed): ${gate.operation} - No human approval received within timeout`,
          blocks: buildGateExpiredBlocks(gate),
        };
        await dispatchWebhook(config, payload);
      }

      // ntfy.sh notification for expiration
      await sendNtfyNotification(
        `Gate EXPIRED: ${gate.operation}`,
        `Gate ${gate.gateId} timed out (fail-closed). No human approval received.`,
        'high',
        undefined,
        ['hourglass', 'x']
      );
    } catch (err) {
      console.error('[Gate-Webhook] notifyGateExpired error:', (err as Error).message);
    }
  })();
}
