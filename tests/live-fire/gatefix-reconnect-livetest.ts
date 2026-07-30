/**
 * LIVE-FIRE reproduction test for commit 392a977e (gate-reaping incident fix).
 *
 * Manual verification script — NOT part of the vitest suite (excluded from
 * tsc build via tsconfig's "tests" exclusion; not picked up by `npm test`).
 * Run directly with: npx tsx tests/live-fire/gatefix-reconnect-livetest.ts
 *
 * Spawns the REAL gia-mcp-server/src/mcp/server-http.ts against a throwaway
 * LOCAL Postgres container and drives it over the real HTTP MCP protocol
 * (StreamableHTTP JSON-RPC) to reproduce the exact reconnect-churn mechanism
 * that reaped a live MANDATORY gate in production, then proves it no longer
 * happens.
 *
 * Touches NOTHING in production. Everything is local and throwaway:
 *   - postgres:16-alpine container on 127.0.0.1:55432 (docker run --rm)
 *   - server-http.ts child process on 127.0.0.1:3199
 *   - a made-up API key, never a real credential
 * Torn down in finally{} regardless of outcome.
 *
 * Background (2026-07-18 incident): a customer's managed-agent orchestration
 * hit a MANDATORY gate that was falsely force-timed-out ~2 minutes after
 * being requested. Root cause: the /mcp (tenant-tier) session path had no
 * persistent per-tenant GovernanceEngine cache — every transport reconnect
 * rebuilt a brand-new engine via createGIAServer('tenant'), and each fresh
 * engine's cleanupStaleGates() swept the DB and marked ANY still-open gate
 * not in its own empty in-memory map as "orphaned by a crashed session."
 * Fix (392a977e): (1) gate-persistence.ts guards cleanupStaleGates() to run
 * its DB mutation at most once per process lifetime; (2) server-http.ts caches
 * one GovernanceEngine per tenant across reconnects (tenantEngines Map).
 */

import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = 'C:/Users/knowl/Downloads/ACE-VA-Agents-main/ACE-VA-Agents-main/gia-mcp-server';
const CONTAINER = 'gia-gatefix-livetest';
const PG_PORT = 55432;
const HTTP_PORT = 3199;
const HOST = '127.0.0.1';
const API_KEY = 'livetest-' + randomUUID().replace(/-/g, '').slice(0, 16);
// Throwaway per-run password for the disposable local Postgres container —
// generated fresh every run, never a stored credential.
const PG_PASSWORD = 'lt-' + randomUUID().replace(/-/g, '').slice(0, 20);
const DB_NAME = 'gatefixtest';
const RECONNECT_BURST_COUNT = 18;

let child: ReturnType<typeof spawn> | null = null;
let containerStarted = false;
const stderrLines: string[] = [];

function log(...args: unknown[]) {
  console.log(...args);
}

function psql(sql: string): string {
  const out = execSync(
    `docker exec ${CONTAINER} psql -U postgres -d ${DB_NAME} -t -A -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  );
  return out.trim();
}

async function waitForPg(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execSync(`docker exec ${CONTAINER} pg_isready -U postgres -d ${DB_NAME}`, { stdio: 'pipe' });
      log('[setup] Postgres accepting connections.');
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('Postgres did not become ready within timeout.');
}

async function waitForHealth(timeoutMs = 60000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Server process exited early with code ${child.exitCode} before becoming healthy.\n--- stderr tail ---\n${stderrLines.slice(-60).join('')}`);
    }
    try {
      const res = await fetch(`http://${HOST}:${HTTP_PORT}/health`);
      if (res.status === 200) {
        const body = await res.json();
        log('[setup] /health 200:', JSON.stringify(body));
        return body;
      }
    } catch {
      // not up yet
    }
    await sleep(750);
  }
  throw new Error(`Server did not become healthy within timeout.\n--- stderr tail ---\n${stderrLines.slice(-60).join('')}`);
}

/** Parse a StreamableHTTP response body — either plain JSON or SSE "data: {...}" frames. */
function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  const messages: any[] = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      const jsonPart = l.slice(5).trim();
      try { messages.push(JSON.parse(jsonPart)); } catch { /* ignore */ }
    }
  }
  return messages.length === 1 ? messages[0] : messages;
}

let msgId = 0;
let currentSessionId: string | null = null;

async function mcpPost(method: string, params: any, opts: { sessionId?: string | null; isNotification?: boolean } = {}) {
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : currentSessionId;
  const isNotification = !!opts.isNotification;
  const id = isNotification ? undefined : ++msgId;
  const body: any = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(id !== undefined ? { id } : {}) };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${API_KEY}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(`http://${HOST}:${HTTP_PORT}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const returnedSessionId = res.headers.get('mcp-session-id');
  const text = await res.text();
  const parsed = parseRpcBody(text);
  return { status: res.status, sessionId: returnedSessionId, message: parsed, raw: text };
}

async function mcpDelete(sessionId: string | null = currentSessionId) {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${API_KEY}` };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(`http://${HOST}:${HTTP_PORT}/mcp`, { method: 'DELETE', headers });
  return { status: res.status };
}

async function initializeSession(): Promise<string> {
  const initRes = await mcpPost('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'livetest', version: '1.0.0' },
  }, { sessionId: null });
  if (initRes.status !== 200) {
    throw new Error(`initialize failed: status=${initRes.status} body=${initRes.raw}`);
  }
  const sid = initRes.sessionId;
  if (!sid) throw new Error(`initialize did not return Mcp-Session-Id header. body=${initRes.raw}`);
  currentSessionId = sid;
  await mcpPost('notifications/initialized', {}, { sessionId: sid, isNotification: true });
  return sid;
}

async function callTool(name: string, args: any, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${API_KEY}`,
    };
    if (currentSessionId) headers['Mcp-Session-Id'] = currentSessionId;
    const id = ++msgId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const res = await fetch(`http://${HOST}:${HTTP_PORT}/mcp`, { method: 'POST', headers, body, signal: controller.signal });
    const text = await res.text();
    const parsed = parseRpcBody(text);
    let payload: any = null;
    try {
      const contentText = parsed?.result?.content?.[0]?.text;
      if (contentText) payload = JSON.parse(contentText);
    } catch { /* leave payload null */ }
    return { status: res.status, message: parsed, payload };
  } finally {
    clearTimeout(timer);
  }
}

function countMatches(lines: string[], re: RegExp): number {
  let n = 0;
  for (const l of lines) {
    const m = l.match(new RegExp(re.source, 'g'));
    if (m) n += m.length;
  }
  return n;
}

async function main() {
  const results: Record<string, unknown> = {
    serverBootedClean: false,
    gateSurvivedBurst: null,
    engineInitStderrCount: null,
    engineInitDbCount: null,
    dbRowStatusAfterBurst: null,
    dbRowRationaleAfterBurst: null,
    resolutionPropagated: null,
    circuitBreakerReleased: null,
    tenantSessionCreatedCount: null,
  };
  let gateId: string | undefined;

  try {
    log(`[setup] API key: ${API_KEY}`);
    log('[setup] Starting throwaway postgres:16-alpine container on 127.0.0.1:' + PG_PORT + ' ...');
    // Password is passed by NAME only (`-e POSTGRES_PASSWORD`): docker reads
    // the value from this process's environment, so the throwaway credential
    // never appears on a command line or in process listings.
    execSync(
      `docker run --rm -d -p ${PG_PORT}:5432 -e POSTGRES_PASSWORD -e POSTGRES_DB=${DB_NAME} --name ${CONTAINER} postgres:16-alpine`,
      { stdio: 'pipe', env: { ...process.env, POSTGRES_PASSWORD: PG_PASSWORD } }
    );
    containerStarted = true;
    await waitForPg();

    log('[setup] Spawning real server-http.ts as a child process...');
    const env = {
      ...process.env,
      DATABASE_URL: `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${DB_NAME}`,
      GIA_HTTP_PORT: String(HTTP_PORT),
      GIA_HTTP_HOST: HOST,
      GIA_API_KEYS: API_KEY,
      NODE_ENV: 'development',
    };
    child = spawn('npx', ['tsx', 'src/mcp/server-http.ts'], { cwd: REPO, env, shell: true });
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrLines.push(s);
      process.stdout.write('[SERVER-ERR] ' + s);
    });
    child.stdout!.on('data', () => { /* drained, not needed for assertions */ });
    child.on('exit', (code) => log(`[server] process exited with code ${code}`));

    await waitForHealth();
    results.serverBootedClean = true;
    log('[PASS] Server booted clean against fresh throwaway Postgres.');

    // --- Step c: classify_decision -> force MANDATORY gate ---
    log('\n[step-c] initialize + classify_decision (forcing MANDATORY)...');
    await initializeSession();
    const classifyRes = await callTool('classify_decision', {
      decision: 'Evaluate deployment of an automated hiring-screen tool',
      domain: 'general',
      agent_name: 'livetest-agent',
      is_client_facing: true,
      has_financial_impact: false,
      has_legal_impact: true,
    });
    log('[step-c] classify_decision payload:', JSON.stringify(classifyRes.payload));
    if (classifyRes.payload?.classification !== 'MANDATORY') {
      throw new Error(`classify_decision did not return MANDATORY: ${JSON.stringify(classifyRes.payload)}`);
    }
    gateId = classifyRes.payload.gateId;
    if (!gateId) throw new Error('No gateId returned from classify_decision.');
    log(`[step-c] MANDATORY gate registered: ${gateId}`);

    // Close this session before the burst so the burst starts from a clean slate.
    await mcpDelete();
    currentSessionId = null;

    // --- Step d: reconnect burst ---
    log(`\n[step-d] reconnect burst: ${RECONNECT_BURST_COUNT} fresh initialize+delete cycles...`);
    for (let i = 1; i <= RECONNECT_BURST_COUNT; i++) {
      const sid = await initializeSession();
      if (i < RECONNECT_BURST_COUNT) {
        await mcpDelete(sid);
        currentSessionId = null;
      }
      process.stdout.write(`  reconnect ${i}/${RECONNECT_BURST_COUNT} -> session ${sid.slice(0, 8)}\n`);
    }
    log('[step-d] Reconnect burst complete. Final session left open for step e.');

    // --- Step e: gate must NOT be timed out ---
    log('\n[step-e] get_gate_status on the surviving session (blocking poll, up to 60s)...');
    const statusRes = await callTool('get_gate_status', { gate_id: gateId, agent_name: 'livetest-agent' }, 70000);
    log('[step-e] get_gate_status payload:', JSON.stringify(statusRes.payload));
    const statusAfterBurst = statusRes.payload?.status;
    results.gateSurvivedBurst = statusAfterBurst !== 'TIMED_OUT';
    if (statusAfterBurst === 'TIMED_OUT') {
      log(`[FAIL] Gate ${gateId} was TIMED_OUT after the reconnect burst — THE FIX FAILED. rationale=${statusRes.payload?.rationale}`);
    } else {
      log(`[PASS] Gate ${gateId} is NOT timed out after ${RECONNECT_BURST_COUNT} reconnects (status=${statusAfterBurst}).`);
    }

    // --- Step f: raw DB row ---
    log('\n[step-f] querying raw Postgres row for the gate...');
    const rawRow = psql(`SELECT gate_id, status, rationale FROM gate_approvals_persistent WHERE gate_id='${gateId}';`);
    log('[step-f] raw row (gate_id|status|rationale):', rawRow);
    const parts = rawRow.split('|');
    results.dbRowStatusAfterBurst = parts[1] || '(null)';
    results.dbRowRationaleAfterBurst = parts.slice(2).join('|') || '(null)';

    // --- governance-engine-init counting ---
    log('\n[count] counting governance-engine-init evidence...');
    const literalStderrCount = countMatches(stderrLines, /governance-engine-init/g);
    const proxyStderrCount = countMatches(stderrLines, /\[GovernanceEngine\] (Persistence active|Running in-memory only)/g);
    const tenantSessionCreatedCount = countMatches(stderrLines, /\[GIA-HTTP\] Tenant session created:/g);
    const dbLedgerCount = psql(`SELECT count(*) FROM forensic_ledger WHERE operation='governance-engine-init';`);
    results.engineInitStderrCount = { literal: literalStderrCount, proxyMarkerLines: proxyStderrCount };
    results.engineInitDbCount = parseInt(dbLedgerCount, 10);
    results.tenantSessionCreatedCount = tenantSessionCreatedCount;
    log(`[count] literal "governance-engine-init" string in stderr: ${literalStderrCount}`);
    log(`[count] [GovernanceEngine] init-marker lines in stderr (proxy for engine.initialize() calls): ${proxyStderrCount}`);
    log(`[count] "[GIA-HTTP] Tenant session created:" lines in stderr (new session/transport objects): ${tenantSessionCreatedCount}`);
    log(`[count] forensic_ledger rows with operation='governance-engine-init' (authoritative DB count): ${results.engineInitDbCount}`);

    // --- Step 5: resolve the gate via direct DB update (mirrors persistGateResolution) ---
    log('\n[step-5] resolving gate via direct Postgres UPDATE (as the console would)...');
    psql(`UPDATE gate_approvals_persistent SET status='APPROVED', approved_by='livetest-isso', rationale='live-fire test approval', resolved_at=NOW() WHERE gate_id='${gateId}';`);
    const afterUpdate = psql(`SELECT status, approved_by FROM gate_approvals_persistent WHERE gate_id='${gateId}';`);
    log('[step-5] row after UPDATE (status|approved_by):', afterUpdate);

    // --- Step 6: get_gate_status again -> should report APPROVED ---
    log('\n[step-6] get_gate_status again — should now report APPROVED (internal 5s poll)...');
    const statusRes2 = await callTool('get_gate_status', { gate_id: gateId, agent_name: 'livetest-agent' }, 70000);
    log('[step-6] get_gate_status payload:', JSON.stringify(statusRes2.payload));
    results.resolutionPropagated = statusRes2.payload?.status === 'APPROVED';
    if (results.resolutionPropagated) {
      log('[PASS] Gate resolution propagated to get_gate_status as APPROVED.');
    } else {
      log(`[FAIL] get_gate_status did not report APPROVED: ${JSON.stringify(statusRes2.payload)}`);
    }

    // --- Step 7: classify_decision again -> circuit breaker should be released ---
    log('\n[step-7] classify_decision again — circuit breaker must be released (no Gate hold)...');
    const classifyRes2 = await callTool('classify_decision', {
      decision: 'Evaluate a routine internal documentation update',
      domain: 'general',
      agent_name: 'livetest-agent',
      is_client_facing: false,
      has_financial_impact: false,
      has_legal_impact: false,
    });
    log('[step-7] classify_decision (post-resolution) payload:', JSON.stringify(classifyRes2.payload));
    results.circuitBreakerReleased = classifyRes2.payload?.gateStatus !== 'HOLD';
    if (results.circuitBreakerReleased) {
      log('[PASS] classify_decision circuit breaker released — new call proceeded normally.');
    } else {
      log(`[FAIL] classify_decision still HOLDing: ${JSON.stringify(classifyRes2.payload)}`);
    }

    log('\n=== SUMMARY ===');
    log(JSON.stringify(results, null, 2));
  } finally {
    log('\n[teardown] killing server-http.ts child process...');
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await sleep(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (containerStarted) {
      log('[teardown] stopping throwaway postgres container...');
      try { execSync(`docker stop ${CONTAINER}`, { stdio: 'pipe' }); } catch (e: any) { log('[teardown] docker stop error:', e.message); }
    }
    log('[teardown] done.');
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exitCode = 1;
});
