/**
 * @module    mcp-ui-apps
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — resource registration, not a governed operation
 * @audit     false — read-only UI resources
 * @owner     William J. Storey III / ACE / GIA
 *
 * MCP Apps — interactive HTML UIs served as ui:// resources.
 * Rendered by Claude.ai (desktop + iOS/Android) as sandboxed iframes.
 * Communication via postMessage JSON-RPC only — no external network.
 *
 * Resources:
 *   ui://gate-approval   — MANDATORY gate approve/deny card
 *   ui://system-status   — live governance health dashboard
 *   ui://srt-health      — SRT watchdog health monitor
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ─── GIA Dark Theme CSS (shared across all apps) ─────────────────────────────

const GIA_BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0c10;
    color: #e2e8f0;
    min-height: 100vh;
    padding: 16px;
  }
  .brand {
    font-size: 10px;
    color: #334155;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-align: center;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #1e2535;
  }
  .brand span { color: #475569; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .badge-mandatory { background: #7c3aed22; color: #a78bfa; border: 1px solid #7c3aed44; }
  .badge-advisory  { background: #d9770622; color: #fdba74; border: 1px solid #d9770644; }
  .badge-info      { background: #0e7490aa; color: #22d3ee; border: 1px solid #22d3ee44; }
  .badge-pass      { background: #16532d44; color: #4ade80; border: 1px solid #16a34a44; }
  .badge-warn      { background: #78350f44; color: #fbbf24; border: 1px solid #d9770644; }
  .badge-crit      { background: #7f1d1d44; color: #f87171; border: 1px solid #dc262644; }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 14px;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    min-height: 48px;
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-approve { background: #16a34a; color: #fff; }
  .btn-approve:hover:not(:disabled) { background: #15803d; }
  .btn-deny    { background: #dc2626; color: #fff; }
  .btn-deny:hover:not(:disabled) { background: #b91c1c; }
  .btn-diagnose { background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f644; }
  .btn-diagnose:hover:not(:disabled) { background: #1e40af33; }
`;

// ─── Gate Approval App ────────────────────────────────────────────────────────

const GATE_APPROVAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>GIA Gate Approval</title>
  <style>
    ${GIA_BASE_CSS}
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .header-icon {
      width: 36px;
      height: 36px;
      background: #7c3aed22;
      border: 1px solid #7c3aed55;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .header-title { font-size: 15px; font-weight: 700; color: #e2e8f0; }
    .header-sub   { font-size: 11px; color: #64748b; margin-top: 1px; }
    .gate-card {
      background: #12172a;
      border: 1px solid #1e2d4a;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .gate-card:last-of-type { margin-bottom: 0; }
    .gate-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .gate-field label {
      font-size: 9px;
      color: #475569;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      display: block;
      margin-bottom: 2px;
    }
    .gate-field value {
      font-size: 12px;
      color: #94a3b8;
      font-family: 'SF Mono', 'Fira Code', monospace;
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gate-id {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 11px;
      color: #22d3ee;
      margin-bottom: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
    .empty-state {
      text-align: center;
      padding: 40px 16px;
      color: #475569;
    }
    .empty-icon { font-size: 36px; margin-bottom: 12px; }
    .empty-title { font-size: 14px; font-weight: 600; color: #64748b; margin-bottom: 4px; }
    .empty-sub   { font-size: 12px; color: #334155; }
    .confirmed-state {
      text-align: center;
      padding: 24px 16px;
    }
    .confirmed-icon { font-size: 40px; margin-bottom: 10px; }
    .confirmed-title { font-size: 14px; font-weight: 700; }
    .confirmed-approve { color: #4ade80; }
    .confirmed-deny    { color: #f87171; }
    .loading { text-align: center; padding: 32px; color: #475569; font-size: 13px; }
    .spinner {
      width: 24px; height: 24px;
      border: 2px solid #1e2535;
      border-top-color: #22d3ee;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-icon">⛩</div>
    <div>
      <div class="header-title">Gate Approval</div>
      <div class="header-sub">Governed Intelligence Architecture · ACE</div>
    </div>
  </div>

  <div id="root">
    <div class="loading">
      <div class="spinner"></div>
      Loading pending gates…
    </div>
  </div>

  <div class="brand">Governed Intelligence Architecture <span>· ACE · SDVOSB</span></div>

  <script>
    const root = document.getElementById('root');
    const pendingActions = new Map(); // gateId → pending action

    function renderGates(data) {
      const gates = data?.pendingApprovals || data?.pending || [];
      if (!Array.isArray(gates) || gates.length === 0) {
        root.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">✓</div>
            <div class="empty-title">No pending gates</div>
            <div class="empty-sub">Governance is clear — all actions proceed.</div>
          </div>\`;
        return;
      }
      root.innerHTML = gates.map(g => buildGateCard(g)).join('');
    }

    function buildGateCard(g) {
      const id = g.gateId || g.gate_id || g.id || 'unknown';
      const action = g.action || g.actionType || g.type || '—';
      const detail = g.detail || g.target || g.resource || '—';
      const level = g.priority || g.maiLevel || 'MANDATORY';
      const ts = g.createdAt ? new Date(g.createdAt).toLocaleTimeString() : '—';
      const levelClass = level === 'MANDATORY' ? 'badge-mandatory' : level === 'ADVISORY' ? 'badge-advisory' : 'badge-info';
      return \`
        <div class="gate-card" id="card-\${id}">
          <div class="gate-id">\${id.slice(0, 36)}</div>
          <div class="gate-meta">
            <div class="gate-field">
              <label>Action</label>
              <value>\${action}</value>
            </div>
            <div class="gate-field">
              <label>MAI Level</label>
              <value><span class="badge \${levelClass}">\${level}</span></value>
            </div>
            <div class="gate-field" style="grid-column:1/-1">
              <label>Target / Detail</label>
              <value>\${String(detail).slice(0, 60)}</value>
            </div>
            <div class="gate-field">
              <label>Requested</label>
              <value>\${ts}</value>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn btn-approve" onclick="decide('\${id}', 'approve')">✓ Approve</button>
            <button class="btn btn-deny"    onclick="decide('\${id}', 'reject')">✕ Deny</button>
          </div>
        </div>\`;
    }

    function decide(gateId, action) {
      const card = document.getElementById('card-' + gateId);
      if (!card) return;
      // Disable both buttons
      card.querySelectorAll('.btn').forEach(b => b.disabled = true);
      // Show spinner
      card.querySelector('.btn-row').innerHTML = '<div class="loading" style="padding:12px"><div class="spinner"></div></div>';
      pendingActions.set(gateId, action);
      window.parent.postMessage({
        type: 'mcp:invoke',
        tool: 'approve_gate',
        params: {
          action,
          gate_id: gateId,
          rationale: action === 'approve' ? 'Approved via GIA MCP App' : 'Denied via GIA MCP App'
        }
      }, '*');
    }

    function handleResult(result, error) {
      // Find which gate this result corresponds to
      for (const [gateId, action] of pendingActions.entries()) {
        const card = document.getElementById('card-' + gateId);
        if (!card) continue;
        if (error) {
          card.innerHTML = '<div class="confirmed-state"><div class="confirmed-icon">⚠</div><div class="confirmed-title" style="color:#fbbf24">Error — try again</div></div>';
        } else {
          const isApprove = action === 'approve';
          card.innerHTML = \`
            <div class="confirmed-state">
              <div class="confirmed-icon">\${isApprove ? '✓' : '✕'}</div>
              <div class="confirmed-title \${isApprove ? 'confirmed-approve' : 'confirmed-deny'}">
                Gate \${isApprove ? 'Approved' : 'Denied'}
              </div>
              <div style="font-size:11px;color:#475569;margin-top:6px">\${gateId.slice(0,24)}…</div>
            </div>\`;
        }
        pendingActions.delete(gateId);
        break;
      }
    }

    // PostMessage bridge
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      switch (e.data.type) {
        case 'mcp:data':   renderGates(e.data.data);           break;
        case 'mcp:result': handleResult(e.data.result, null);  break;
        case 'mcp:error':  handleResult(null, e.data.error);   break;
      }
    });

    // Signal ready — host will send mcp:data with tool result
    window.parent.postMessage({ type: 'mcp:ready' }, '*');
  </script>
</body>
</html>`;

// ─── System Status App ────────────────────────────────────────────────────────

const SYSTEM_STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>GIA System Status</title>
  <style>
    ${GIA_BASE_CSS}
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .header-icon {
      width: 36px; height: 36px;
      background: #0e749033;
      border: 1px solid #22d3ee33;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .header-title { font-size: 15px; font-weight: 700; }
    .header-sub   { font-size: 11px; color: #64748b; margin-top: 1px; }
    .refresh-btn {
      background: none;
      border: 1px solid #1e2535;
      border-radius: 6px;
      color: #475569;
      font-size: 11px;
      padding: 4px 10px;
      cursor: pointer;
    }
    .refresh-btn:hover { color: #22d3ee; border-color: #22d3ee44; }
    .health-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .health-cell {
      background: #12172a;
      border: 1px solid #1e2d4a;
      border-radius: 10px;
      padding: 12px;
    }
    .health-cell label {
      font-size: 9px;
      color: #475569;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      display: block;
      margin-bottom: 6px;
    }
    .health-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-green  { background: #4ade80; box-shadow: 0 0 6px #4ade8088; }
    .dot-amber  { background: #fbbf24; box-shadow: 0 0 6px #fbbf2488; }
    .dot-red    { background: #f87171; box-shadow: 0 0 6px #f8717188; }
    .dot-gray   { background: #475569; }
    .metrics-row {
      background: #12172a;
      border: 1px solid #1e2d4a;
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .metrics-row label {
      font-size: 9px; color: #475569;
      letter-spacing: 0.1em; text-transform: uppercase;
      display: block; margin-bottom: 8px;
    }
    .metrics-cols {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .metric { text-align: center; }
    .metric-val { font-size: 20px; font-weight: 700; color: #22d3ee; }
    .metric-key { font-size: 10px; color: #475569; margin-top: 2px; }
    .threshold-bar-wrap {
      background: #12172a;
      border: 1px solid #1e2d4a;
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .threshold-bar-wrap label {
      font-size: 9px; color: #475569;
      letter-spacing: 0.1em; text-transform: uppercase;
      display: flex; justify-content: space-between;
      margin-bottom: 8px;
    }
    .bar-track {
      background: #0a0c10;
      border-radius: 4px;
      height: 8px;
      position: relative;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .bar-healthy-zone {
      position: absolute;
      top: 0; height: 100%;
      background: #16a34a22;
      border-left: 1px solid #16a34a55;
      border-right: 1px solid #16a34a55;
    }
    .bar-label {
      display: flex; justify-content: space-between;
      font-size: 9px; color: #334155;
      margin-top: 4px;
    }
    .gate-alert {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #7c3aed11;
      border: 1px solid #7c3aed33;
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .gate-alert-icon { font-size: 20px; }
    .gate-alert-count { font-size: 20px; font-weight: 700; color: #a78bfa; }
    .gate-alert-label { font-size: 11px; color: #7c3aed; }
    .loading { text-align: center; padding: 32px; color: #475569; font-size: 13px; }
    .spinner {
      width: 24px; height: 24px;
      border: 2px solid #1e2535;
      border-top-color: #22d3ee;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-icon">⚡</div>
      <div>
        <div class="header-title">GIA Status</div>
        <div class="header-sub">Live Governance Health</div>
      </div>
    </div>
    <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
  </div>

  <div id="root">
    <div class="loading">
      <div class="spinner"></div>
      Loading system status…
    </div>
  </div>

  <div class="brand">Governed Intelligence Architecture <span>· ACE · SDVOSB</span></div>

  <script>
    const root = document.getElementById('root');

    function renderStatus(data) {
      const status = data?.status || data;
      const healthy = status?.healthy ?? true;
      const threshold = status?.thresholdStatus || {};
      const telemetry = status?.telemetry || {};
      const gates = status?.gates || {};
      const activeSessions = status?.activeSessions ?? 0;
      const version = status?.version || '—';

      // Health cells
      const cells = [
        { label: 'Governance Engine', ok: healthy, text: healthy ? 'Operational' : 'Degraded' },
        { label: 'Forensic Ledger',   ok: healthy, text: healthy ? 'Chain intact' : 'Error' },
        { label: 'MAI Gate',          ok: healthy, text: healthy ? 'Enforcing'   : 'Offline' },
        { label: 'Storey Threshold',  ok: threshold.status !== 'CRITICAL', text: threshold.status || 'HEALTHY' },
      ];

      const pendingGates = gates.pending ?? 0;
      const escalationRate = threshold.escalationRate ?? 0;
      const escalationPct = Math.round(escalationRate * 100);
      const barFillPct = Math.min(escalationPct, 100);
      const barColor = escalationPct < 5 || escalationPct > 25 ? '#dc2626' :
                       escalationPct >= 10 && escalationPct <= 18 ? '#4ade80' : '#fbbf24';

      const gateAlert = pendingGates > 0 ? \`
        <div class="gate-alert">
          <div class="gate-alert-icon">⛩</div>
          <div>
            <div class="gate-alert-count">\${pendingGates}</div>
            <div class="gate-alert-label">gate\${pendingGates !== 1 ? 's' : ''} pending approval</div>
          </div>
        </div>\` : '';

      root.innerHTML = \`
        \${gateAlert}
        <div class="health-grid">
          \${cells.map(c => \`
            <div class="health-cell">
              <label>\${c.label}</label>
              <div class="health-indicator">
                <div class="dot \${c.ok ? 'dot-green' : 'dot-red'}"></div>
                <span style="color:\${c.ok ? '#4ade80' : '#f87171'}">\${c.text}</span>
              </div>
            </div>\`).join('')}
        </div>
        <div class="threshold-bar-wrap">
          <label>
            <span>Escalation Health</span>
            <span>\${escalationPct}%</span>
          </label>
          <div class="bar-track">
            <div class="bar-healthy-zone" style="left:10%;width:8%"></div>
            <div class="bar-fill" style="width:\${barFillPct}%;background:\${barColor}"></div>
          </div>
          <div class="bar-label"><span>0%</span><span>10–18% healthy</span><span>100%</span></div>
        </div>
        <div class="metrics-row">
          <label>Session Metrics</label>
          <div class="metrics-cols">
            <div class="metric">
              <div class="metric-val">\${activeSessions}</div>
              <div class="metric-key">Active Sessions</div>
            </div>
            <div class="metric">
              <div class="metric-val">\${telemetry.totalEvents ?? 0}</div>
              <div class="metric-key">Events</div>
            </div>
            <div class="metric">
              <div class="metric-val">\${telemetry.totalToolCalls ?? 0}</div>
              <div class="metric-key">Tool Calls</div>
            </div>
          </div>
        </div>
        <div style="text-align:right;font-size:10px;color:#334155;margin-top:4px">v\${version} · \${new Date().toLocaleTimeString()}</div>\`;
    }

    function refresh() {
      root.innerHTML = '<div class="loading"><div class="spinner"></div>Refreshing…</div>';
      window.parent.postMessage({ type: 'mcp:invoke', tool: 'system_status', params: {} }, '*');
    }

    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      switch (e.data.type) {
        case 'mcp:data': {
          try {
            const parsed = typeof e.data.data === 'string' ? JSON.parse(e.data.data) : e.data.data;
            renderStatus(parsed);
          } catch { renderStatus(e.data.data); }
          break;
        }
        case 'mcp:result': {
          try {
            const text = e.data.result?.content?.[0]?.text;
            renderStatus(text ? JSON.parse(text) : e.data.result);
          } catch { renderStatus(e.data.result); }
          break;
        }
        case 'mcp:error':
          root.innerHTML = '<div class="loading" style="color:#f87171">⚠ Failed to load status</div>';
          break;
      }
    });

    window.parent.postMessage({ type: 'mcp:ready' }, '*');
  </script>
</body>
</html>`;

// ─── SRT Health Monitor App ───────────────────────────────────────────────────

const SRT_HEALTH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>GIA SRT Health Monitor</title>
  <style>
    ${GIA_BASE_CSS}
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .header-icon {
      width: 36px; height: 36px;
      background: #16532d22;
      border: 1px solid #16a34a44;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .header-title { font-size: 15px; font-weight: 700; }
    .header-sub   { font-size: 11px; color: #64748b; margin-top: 1px; }
    .summary-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 12px;
      font-weight: 600;
      font-size: 13px;
    }
    .banner-healthy { background: #16532d22; border: 1px solid #16a34a44; color: #4ade80; }
    .banner-warn    { background: #78350f22; border: 1px solid #d9770644; color: #fbbf24; }
    .banner-crit    { background: #7f1d1d22; border: 1px solid #dc262644; color: #f87171; }
    .checks-grid { display: flex; flex-direction: column; gap: 8px; }
    .check-card {
      background: #12172a;
      border: 1px solid #1e2d4a;
      border-radius: 10px;
      padding: 12px;
    }
    .check-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .check-name { font-size: 13px; font-weight: 600; color: #e2e8f0; }
    .check-detail { font-size: 11px; color: #64748b; margin-top: 2px; }
    .check-value  { font-size: 11px; color: #94a3b8; font-family: 'SF Mono','Fira Code',monospace; }
    .check-actions { margin-top: 10px; }
    .pipeline {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: #334155;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .pipeline-step { padding: 3px 8px; background: #12172a; border: 1px solid #1e2d4a; border-radius: 4px; color: #475569; }
    .pipeline-step.active { border-color: #22d3ee44; color: #22d3ee; }
    .pipeline-arrow { color: #1e2d4a; }
    .diagnosis-panel {
      background: #0a0c10;
      border: 1px solid #1e3a5f;
      border-radius: 8px;
      padding: 10px;
      margin-top: 8px;
    }
    .diagnosis-title { font-size: 11px; font-weight: 700; color: #93c5fd; margin-bottom: 6px; }
    .diagnosis-step {
      font-size: 11px;
      color: #94a3b8;
      padding: 4px 0;
      border-bottom: 1px solid #1e2535;
      display: flex; align-items: flex-start; gap: 6px;
    }
    .diagnosis-step:last-child { border-bottom: none; }
    .step-num { color: #22d3ee; font-weight: 700; flex-shrink: 0; }
    .loading { text-align: center; padding: 32px; color: #475569; font-size: 13px; }
    .spinner {
      width: 24px; height: 24px;
      border: 2px solid #1e2535;
      border-top-color: #4ade80;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-icon">🔬</div>
    <div>
      <div class="header-title">SRT Health Monitor</div>
      <div class="header-sub">Site Reliability Team · Watchdog</div>
    </div>
  </div>

  <div class="pipeline">
    <div class="pipeline-step active" id="ps-watchdog">Watchdog</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step" id="ps-diagnose">Diagnose</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step" id="ps-repair">Repair</div>
    <span class="pipeline-arrow">→</span>
    <div class="pipeline-step" id="ps-gate">Gate</div>
  </div>

  <div id="root">
    <div class="loading">
      <div class="spinner"></div>
      Running health probes…
    </div>
  </div>

  <div class="brand">Governed Intelligence Architecture <span>· ACE · SRT</span></div>

  <script>
    const root = document.getElementById('root');
    const diagnosing = new Set();

    const CHECK_LABELS = {
      api:      'API Health',
      frontend: 'Frontend',
      disk:     'Disk Space',
      memory:   'Memory',
      tls:      'TLS Certificate',
      database: 'Database',
      dns:      'DNS',
      port:     'Port Check',
    };

    function statusClass(s) {
      if (!s || s === 'PASS' || s === 'HEALTHY' || s === 'OK') return 'pass';
      if (s === 'WARNING' || s === 'WARN')  return 'warn';
      return 'crit';
    }

    function statusLabel(s) {
      if (!s || s === 'PASS' || s === 'HEALTHY' || s === 'OK') return 'PASS';
      if (s === 'WARNING' || s === 'WARN') return 'WARN';
      return 'CRIT';
    }

    function renderChecks(data) {
      const status = data?.status || 'UNKNOWN';
      const checks = data?.checks || data?.results || [];
      const findings = data?.findings || [];
      const incidentId = data?.incidentId;

      let bannerClass = 'banner-healthy';
      let bannerIcon = '✓';
      let bannerText = 'All systems healthy';
      if (status === 'CRITICAL' || status === 'DEGRADED') {
        bannerClass = 'banner-crit'; bannerIcon = '✕'; bannerText = 'Critical issues detected';
      } else if (status === 'WARNING' || status === 'INVESTIGATING') {
        bannerClass = 'banner-warn'; bannerIcon = '!'; bannerText = 'Warnings detected — investigation recommended';
      }

      const checkItems = checks.length > 0 ? checks : findings.map(f => ({
        name: f.signal || f.type,
        status: f.severity || 'WARNING',
        detail: f.detail || f.message,
        value: f.value,
      }));

      root.innerHTML = \`
        <div class="summary-banner \${bannerClass}">\${bannerIcon} \${bannerText}\${incidentId ? ' · ' + incidentId.slice(0,16) : ''}</div>
        <div class="checks-grid">
          \${checkItems.length > 0
            ? checkItems.map((c, i) => buildCheckCard(c, i)).join('')
            : '<div style="color:#475569;text-align:center;padding:16px">No check data available</div>'}
        </div>\`;
    }

    function buildCheckCard(c, idx) {
      const name = c.name || c.check || c.type || 'Check ' + (idx + 1);
      const label = CHECK_LABELS[name.toLowerCase()] || name;
      const sc = statusClass(c.status || c.severity);
      const sl = statusLabel(c.status || c.severity);
      const detail = c.detail || c.message || c.description || '';
      const value = c.value != null ? c.value : '';
      const needsAction = sc !== 'pass';
      return \`
        <div class="check-card" id="check-\${idx}">
          <div class="check-header">
            <div>
              <div class="check-name">\${label}</div>
              \${detail ? '<div class="check-detail">' + String(detail).slice(0,80) + '</div>' : ''}
              \${value !== '' ? '<div class="check-value">' + value + '</div>' : ''}
            </div>
            <span class="badge badge-\${sc}">\${sl}</span>
          </div>
          \${needsAction ? \`<div class="check-actions"><button class="btn btn-diagnose" style="font-size:11px;min-height:36px;padding:8px" onclick="diagnose(\${idx}, '\${name}')">⚡ Diagnose</button></div>\` : ''}
          <div id="diagnosis-\${idx}"></div>
        </div>\`;
    }

    function diagnose(idx, checkName) {
      if (diagnosing.has(idx)) return;
      diagnosing.add(idx);
      const panel = document.getElementById('diagnosis-' + idx);
      const btn = document.querySelector('#check-' + idx + ' .btn-diagnose');
      if (btn) btn.disabled = true;
      if (panel) panel.innerHTML = '<div class="loading" style="padding:10px"><div class="spinner" style="width:16px;height:16px;margin-bottom:6px"></div>Diagnosing…</div>';
      document.getElementById('ps-diagnose').classList.add('active');
      window.parent.postMessage({
        type: 'mcp:invoke',
        tool: 'srt_diagnose',
        params: { finding_type: checkName }
      }, '*');
    }

    function renderDiagnosis(result) {
      // Find first diagnosing card
      for (const idx of diagnosing) {
        const panel = document.getElementById('diagnosis-' + idx);
        if (!panel) continue;
        const steps = result?.repairCommands || result?.steps || [];
        panel.innerHTML = \`
          <div class="diagnosis-panel">
            <div class="diagnosis-title">⚡ Repair Plan · \${result?.playbook || 'Manual'}</div>
            \${steps.slice(0,5).map((s, i) => \`
              <div class="diagnosis-step">
                <span class="step-num">\${i+1}.</span>
                <span>\${s.description || s.command || String(s)}</span>
              </div>\`).join('')}
            \${steps.length > 0 ? \`<div style="margin-top:8px"><button class="btn btn-approve" style="font-size:11px;min-height:36px;padding:8px" onclick="approveRepair()">✓ Approve Repair</button></div>\` : ''}
          </div>\`;
        diagnosing.delete(idx);
        document.getElementById('ps-repair').classList.add('active');
        break;
      }
    }

    function approveRepair() {
      document.getElementById('ps-gate').classList.add('active');
      window.parent.postMessage({
        type: 'mcp:invoke',
        tool: 'srt_approve_repair',
        params: { action: 'approve', approved_by: 'MCP-App' }
      }, '*');
    }

    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      switch (e.data.type) {
        case 'mcp:data': {
          try {
            const parsed = typeof e.data.data === 'string' ? JSON.parse(e.data.data) : e.data.data;
            renderChecks(parsed);
          } catch { renderChecks(e.data.data); }
          break;
        }
        case 'mcp:result': {
          try {
            const text = e.data.result?.content?.[0]?.text;
            const parsed = text ? JSON.parse(text) : e.data.result;
            if (diagnosing.size > 0) { renderDiagnosis(parsed); } else { renderChecks(parsed); }
          } catch { /* ignore */ }
          break;
        }
        case 'mcp:error':
          root.innerHTML = '<div class="loading" style="color:#f87171">⚠ Health check failed</div>';
          break;
      }
    });

    window.parent.postMessage({ type: 'mcp:ready' }, '*');
  </script>
</body>
</html>`;

// ─── Resource Registration ────────────────────────────────────────────────────

export function registerUIAppResources(server: McpServer): void {

  // Gate Approval — interactive approve/deny card for MANDATORY gates
  server.resource(
    'gate-approval-app',
    'ui://gate-approval',
    { description: 'Interactive GIA gate approval card. Shows pending MANDATORY gates with Approve/Deny buttons.' },
    async () => ({
      contents: [{
        uri: 'ui://gate-approval',
        mimeType: 'text/html',
        text: GATE_APPROVAL_HTML,
      }],
    })
  );

  // System Status Dashboard — live governance health
  server.resource(
    'system-status-app',
    'ui://system-status',
    { description: 'Live GIA governance health dashboard. Shows engine status, Storey Threshold, gate queue, and session metrics.' },
    async () => ({
      contents: [{
        uri: 'ui://system-status',
        mimeType: 'text/html',
        text: SYSTEM_STATUS_HTML,
      }],
    })
  );

  // SRT Health Monitor — watchdog findings with diagnose/repair flow
  server.resource(
    'srt-health-app',
    'ui://srt-health',
    { description: 'SRT health monitor. Shows watchdog check results with inline diagnose and governed repair approval flow.' },
    async () => ({
      contents: [{
        uri: 'ui://srt-health',
        mimeType: 'text/html',
        text: SRT_HEALTH_HTML,
      }],
    })
  );
}
