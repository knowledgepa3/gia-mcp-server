/**
 * GIA MCP Server — Live Smoke Test
 *
 * Spawns the actual MCP server as a child process and sends
 * real MCP protocol messages over stdio. This validates:
 * - Server starts without error
 * - MCP initialization handshake completes
 * - Tools are registered and callable
 * - Responses contain valid governance data
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '../../src/mcp/server.ts');
const PROJECT_ROOT = resolve(__dirname, '../../');
let messageId = 0;
let buffer = '';

function jsonRpcMessage(method: string, params?: Record<string, unknown>): string {
  const msg = {
    jsonrpc: '2.0',
    id: ++messageId,
    method,
    ...(params !== undefined ? { params } : {}),
  };
  const body = JSON.stringify(msg);
  return body + '\n';
}

async function runSmokeTest(): Promise<void> {
  console.log('═══════════════════════════════════════════════');
  console.log('  GIA MCP Server — Live Smoke Test');
  console.log('═══════════════════════════════════════════════\n');

  const server = spawn('npx', ['tsx', SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });

  const responses: Record<number, unknown> = {};
  let resolveWaiter: ((id: number) => void) | null = null;

  // Collect stderr (server logs)
  server.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      console.log(`  [SERVER] ${line}`);
    }
  });

  // Parse JSON-RPC responses from stdout
  server.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id) {
          responses[msg.id] = msg;
          if (resolveWaiter) resolveWaiter(msg.id);
        }
      } catch {
        // Not JSON — might be partial or log line
      }
    }
  });

  function send(method: string, params?: Record<string, unknown>): number {
    const id = messageId + 1;
    const msg = jsonRpcMessage(method, params);
    server.stdin.write(msg);
    return id;
  }

  function waitForResponse(id: number, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (responses[id]) {
        resolve(responses[id]);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for response id=${id}`));
      }, timeoutMs);

      resolveWaiter = (receivedId: number) => {
        if (receivedId === id) {
          clearTimeout(timer);
          resolveWaiter = null;
          resolve(responses[id]);
        }
      };
    });
  }

  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
      failed++;
    }
  }

  try {
    // Wait for server startup
    await new Promise(r => setTimeout(r, 3000));

    // ─────────────────────────────────────────
    // Test 1: MCP Initialize
    // ─────────────────────────────────────────
    console.log('\n─── Test 1: MCP Initialize ───');
    const initId = send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gia-smoke-test', version: '1.0.0' },
    });
    const initResp = await waitForResponse(initId) as any;

    check('Server responds to initialize', !!initResp?.result);
    check('Server name is gia-governance-server',
      initResp?.result?.serverInfo?.name === 'gia-governance-server',
      initResp?.result?.serverInfo?.name);
    check('Server reports tool capabilities',
      !!initResp?.result?.capabilities?.tools);

    // Send initialized notification
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    // ─────────────────────────────────────────
    // Test 2: List Tools
    // ─────────────────────────────────────────
    console.log('\n─── Test 2: List Tools ───');
    const toolsId = send('tools/list', {});
    const toolsResp = await waitForResponse(toolsId) as any;

    const tools = toolsResp?.result?.tools ?? [];
    const toolNames = tools.map((t: any) => t.name);
    check('Tools list returns results', tools.length > 0, `${tools.length} tools`);
    check('classify_decision registered', toolNames.includes('classify_decision'));
    check('evaluate_threshold registered', toolNames.includes('evaluate_threshold'));
    check('score_governance registered', toolNames.includes('score_governance'));
    check('audit_pipeline registered', toolNames.includes('audit_pipeline'));
    check('monitor_agents registered', toolNames.includes('monitor_agents'));
    check('map_compliance registered', toolNames.includes('map_compliance'));
    check('assess_risk_tier registered', toolNames.includes('assess_risk_tier'));
    check('generate_report registered', toolNames.includes('generate_report'));
    check('system_status registered', toolNames.includes('system_status'));
    check('approve_gate registered', toolNames.includes('approve_gate'));

    // ─────────────────────────────────────────
    // Test 3: Call system_status
    // ─────────────────────────────────────────
    console.log('\n─── Test 3: Call system_status ───');
    const statusId = send('tools/call', {
      name: 'system_status',
      arguments: {},
    });
    const statusResp = await waitForResponse(statusId) as any;
    const statusData = JSON.parse(statusResp?.result?.content?.[0]?.text ?? '{}');

    check('system_status returns data', !!statusData.version);
    check('Engine is initialized', statusData.initialized === true);
    check('Auto-run mode active', statusData.autoRunMode === true);
    check('Ledger has entries', statusData.ledgerSize > 0, `${statusData.ledgerSize} entries`);

    // ─────────────────────────────────────────
    // Test 4: Call classify_decision
    // ─────────────────────────────────────────
    console.log('\n─── Test 4: Call classify_decision ───');
    const classifyId = send('tools/call', {
      name: 'classify_decision',
      arguments: {
        decision: 'Generate final ECV report for veteran disability claim',
        domain: 'va-claims',
        agent_name: 'report-generator',
        is_client_facing: true,
        has_financial_impact: false,
        has_legal_impact: true,
      },
    });
    const classifyResp = await waitForResponse(classifyId) as any;
    const classifyData = JSON.parse(classifyResp?.result?.content?.[0]?.text ?? '{}');

    check('Classification returned', !!classifyData.classification);
    check('Classified as MANDATORY (client-facing + legal)',
      classifyData.classification === 'MANDATORY',
      classifyData.classification);
    check('Requires gate', classifyData.requiresGate === true);
    check('Has confidence score', classifyData.confidence > 0, `${classifyData.confidence}`);

    // ─────────────────────────────────────────
    // Test 5: Call score_governance
    // ─────────────────────────────────────────
    console.log('\n─── Test 5: Call score_governance ───');
    const scoreId = send('tools/call', {
      name: 'score_governance',
      arguments: {
        operation: 'ecv-report-generation',
        integrity: 0.95,
        accuracy: 0.88,
        compliance: 0.92,
      },
    });
    const scoreResp = await waitForResponse(scoreId) as any;
    const scoreData = JSON.parse(scoreResp?.result?.content?.[0]?.text ?? '{}');

    check('Score returned', !!scoreData.composite);
    check('Composite above release threshold', scoreData.composite >= 0.70, `${scoreData.composite}`);
    check('Meets threshold', scoreData.meetsThreshold === true);
    check('Has audit ID', !!scoreData.auditId);

    // ─────────────────────────────────────────
    // Test 6: Call evaluate_threshold
    // ─────────────────────────────────────────
    console.log('\n─── Test 6: Call evaluate_threshold ───');
    const threshId = send('tools/call', {
      name: 'evaluate_threshold',
      arguments: {},
    });
    const threshResp = await waitForResponse(threshId) as any;
    const threshData = JSON.parse(threshResp?.result?.content?.[0]?.text ?? '{}');

    check('Threshold reading returned', !!threshData.status);
    check('Has escalation rate', !!threshData.escalationRate);
    check('Has healthy band reference', threshData.healthyBand === '10-18%');
    check('Has recommendation', !!threshData.recommendation);

    // ─────────────────────────────────────────
    // Test 7: Call map_compliance
    // ─────────────────────────────────────────
    console.log('\n─── Test 7: Call map_compliance ───');
    const compId = send('tools/call', {
      name: 'map_compliance',
      arguments: { framework: 'ALL' },
    });
    const compResp = await waitForResponse(compId) as any;
    const compData = JSON.parse(compResp?.result?.content?.[0]?.text ?? '{}');

    check('Compliance mappings returned', compData.totalControls > 0, `${compData.totalControls} controls`);
    check('All implemented', compData.coverage === '100%', compData.coverage);

    // ─────────────────────────────────────────
    // Test 8: Call generate_report
    // ─────────────────────────────────────────
    console.log('\n─── Test 8: Call generate_report ───');
    const reportId = send('tools/call', {
      name: 'generate_report',
      arguments: { format: 'executive' },
    });
    const reportResp = await waitForResponse(reportId) as any;
    const reportData = JSON.parse(reportResp?.result?.content?.[0]?.text ?? '{}');

    check('Report generated', reportData.reportType?.includes('executive'));
    check('Has system health', !!reportData.systemHealth);
    check('Has operations metrics', reportData.operations?.total > 0);
    check('Has MAI breakdown', !!reportData.maiBreakdown);
    check('Author is William J. Storey III', reportData.author === 'William J. Storey III');

    // ─────────────────────────────────────────
    // Test 9: Call audit_pipeline
    // ─────────────────────────────────────────
    console.log('\n─── Test 9: Call audit_pipeline ───');
    const auditId = send('tools/call', {
      name: 'audit_pipeline',
      arguments: { limit: 10 },
    });
    const auditResp = await waitForResponse(auditId) as any;
    const auditData = JSON.parse(auditResp?.result?.content?.[0]?.text ?? '{}');

    check('Audit entries returned', auditData.totalEntries > 0, `${auditData.totalEntries} total`);
    check('Has entries array', Array.isArray(auditData.entries));
    check('Entries have governance context', auditData.entries?.length > 0 && !!auditData.entries[0].maiLevel);

    // ─────────────────────────────────────────
    // Test 10: Call approve_gate (list mode)
    // ─────────────────────────────────────────
    console.log('\n─── Test 10: Call approve_gate ───');
    const gateId = send('tools/call', {
      name: 'approve_gate',
      arguments: { action: 'list' },
    });
    const gateResp = await waitForResponse(gateId) as any;
    const gateData = JSON.parse(gateResp?.result?.content?.[0]?.text ?? '{}');

    check('Gate list returned', gateData.pendingCount !== undefined);
    check('No pending gates (auto-run mode)', gateData.pendingCount === 0);

    // ─────────────────────────────────────────
    // Test 11: List Resources
    // ─────────────────────────────────────────
    console.log('\n─── Test 11: List Resources ───');
    const resId = send('resources/list', {});
    const resResp = await waitForResponse(resId) as any;
    const resources = resResp?.result?.resources ?? [];

    check('Resources list returns results', resources.length > 0, `${resources.length} resources`);
    const resUris = resources.map((r: any) => r.uri);
    check('MAI spec resource', resUris.includes('gia://spec/mai-framework'));
    check('Threshold spec resource', resUris.includes('gia://spec/storey-threshold'));
    check('Scoring spec resource', resUris.includes('gia://spec/governance-scoring'));
    check('Architecture guide', resUris.includes('gia://spec/architecture'));
    check('Live status resource', resUris.includes('gia://status/live'));

    // ─────────────────────────────────────────
    // Test 12: List Prompts
    // ─────────────────────────────────────────
    console.log('\n─── Test 12: List Prompts ───');
    const promptId = send('prompts/list', {});
    const promptResp = await waitForResponse(promptId) as any;
    const prompts = promptResp?.result?.prompts ?? [];

    check('Prompts list returns results', prompts.length > 0, `${prompts.length} prompts`);
    const promptNames = prompts.map((p: any) => p.name);
    check('/gia-assess prompt', promptNames.includes('gia-assess'));
    check('/gia-design-gate prompt', promptNames.includes('gia-design-gate'));
    check('/gia-compliance-report prompt', promptNames.includes('gia-compliance-report'));
    check('/gia-health-check prompt', promptNames.includes('gia-health-check'));

    // ─────────────────────────────────────────
    // RESULTS
    // ─────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('═══════════════════════════════════════════════\n');

    if (failed > 0) {
      console.log('  ⚠ SOME TESTS FAILED');
    } else {
      console.log('  ✓ ALL TESTS PASSED — GIA MCP Server is LIVE');
    }

  } catch (err) {
    console.error('\n  FATAL:', err);
    failed++;
  } finally {
    server.kill();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runSmokeTest();
