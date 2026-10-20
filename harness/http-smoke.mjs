import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createActivityFixture, FIXTURE_ACCOUNT, FIXTURE_RECIPIENT, FIXTURE_TRANSACTION
} from './controller-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC_DELAY_MS = 600;
const ACTIVITY_BUDGET_MS = 120;
const BLOCK_HASH = `0x${'cc'.repeat(32)}`;
const lanes = new Map();
const responseTimers = new Set();
const report = {
  scope: 'Actual upstream provider factory and ActivityController; controlled ProvidersController, storage, account and portfolio collaborators; local HTTP only.',
  rpcDelayMs: RPC_DELAY_MS,
  activityBudgetMs: ACTIVITY_BUDGET_MS,
  localOnly: true,
  fixtures: 'One ordinary synthetic EOA transaction; no signing or broadcast; JSON-RPC receipt status1 at block100.',
  productionOrBrowserClaims: false,
  scenarios: [],
  success: false
};

function rpcReceipt(hash) {
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: BLOCK_HASH,
    blockNumber: '0x64',
    from: FIXTURE_ACCOUNT,
    to: FIXTURE_RECIPIENT,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x2'
  };
}

function countMethods(requests) {
  return Object.fromEntries([...new Set(requests.map(({method}) => method))].map(method => [method, requests.filter(item => item.method === method).length]));
}

async function waitFor(predicate, maxMs = 3000) {
  const began = performance.now();
  while (!predicate()) {
    if (performance.now() - began >= maxMs) throw new Error('Controlled HTTP fixture did not finish in time');
    await delay(10);
  }
}

const server = http.createServer(async (req, res) => {
  const label = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
  const lane = lanes.get(label);
  if (!lane || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const isBatch = Array.isArray(payload);
    const calls = isBatch ? payload : [payload];
    lane.httpRequests += 1;
    const answers = [];
    let hasReceipt = false;
    for (const call of calls) {
      lane.requests.push({ method: call.method, params: call.params ?? [], receivedAtMs: performance.now() - lane.start });
      if (call.method === 'eth_chainId') answers.push({ jsonrpc: '2.0', id: call.id, result: '0x1' });
      else if (call.method === 'eth_getTransactionReceipt') {
        assert.equal(call.params?.[0], FIXTURE_TRANSACTION);
        hasReceipt = true;
        answers.push({ jsonrpc: '2.0', id: call.id, result: rpcReceipt(call.params[0]) });
      } else {
        lane.unexpectedMethods.push(call.method);
        answers.push({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method is outside this controlled receipt fixture' } });
      }
    }
    const finish = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isBatch ? answers : answers[0]));
      if (hasReceipt) lane.receiptResponses += 1;
    };
    if (hasReceipt) {
      const timer = setTimeout(() => { responseTimers.delete(timer); finish(); }, RPC_DELAY_MS);
      responseTimers.add(timer);
    } else finish();
  } catch (error) {
    lane.serverErrors.push(String(error?.stack ?? error));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({error: String(error)}));
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  report.listenHost = '127.0.0.1';
  for (const commonVersion of ['pr35', 'current']) {
    for (const variant of ['baseline', 'candidate']) {
      const label = `${commonVersion}-${variant}`;
      const bundleContents = await fs.readFile(path.join(here, 'bundles', `${label}.mjs`));
      const bundleSha256 = createHash('sha256').update(bundleContents).digest('hex');
      const upstream = await import(`./bundles/${label}.mjs`);
      const url = `http://127.0.0.1:${address.port}/${label}`;
      const lane = { start: performance.now(), requests: [], httpRequests: 0, receiptResponses: 0, unexpectedMethods: [], serverErrors: [] };
      lanes.set(label, lane);
      // These options select unbatched/no-cache requests for this smoke only.
      // Network timeout remains the actual provider's default.
      const provider = upstream.getRpcProvider([url], 1n, url, { batchMaxCount: 1, cacheTimeout: -1 });
      const transportTimeoutMs = provider._getConnection().timeout;
      const formattedReceipts = [];
      const getActualReceipt = provider.getTransactionReceipt.bind(provider);
      // Observe the real formatter's result; return it unchanged to the controller.
      provider.getTransactionReceipt = async (...args) => {
        const receipt = await getActualReceipt(...args);
        if (receipt) formattedReceipts.push({
          className: receipt.constructor.name, status: receipt.status, statusType: typeof receipt.status,
          blockNumber: receipt.blockNumber, blockNumberType: typeof receipt.blockNumber,
          gasUsed: String(receipt.gasUsed), gasUsedType: typeof receipt.gasUsed
        });
        return receipt;
      };
      const extra = variant === 'candidate'
        ? (commonVersion === 'current' ? [undefined, undefined, { timeoutMs: ACTIVITY_BUDGET_MS }] : [undefined, { timeoutMs: ACTIVITY_BUDGET_MS }])
        : [];
      let fixture;
      const scenario = {
        label,
        bundleSha256,
        providerClass: provider.constructor.name,
        transportTimeoutMs,
        providerOptionsForSmoke: { batchMaxCount: 1, cacheTimeout: -1 },
        candidateOptions: variant === 'candidate' ? { timeoutMs: ACTIVITY_BUDGET_MS } : null
      };
      report.scenarios.push(scenario);
      try {
        fixture = await createActivityFixture({ ActivityController: upstream.ActivityController, provider, commonVersion, controllerExtraArgs: extra });
        await fixture.addOperation();
        fixture.resetObservations();
        lane.start = performance.now();
        const started = performance.now();
        await fixture.update();
        scenario.firstRefresh = {
          elapsedMs: Number((performance.now() - started).toFixed(3)),
          operation: fixture.summarize()[0],
          errors: structuredClone(fixture.observations.errors),
          metrics: fixture.metrics()
        };
        if (variant === 'baseline') {
          assert(scenario.firstRefresh.elapsedMs >= RPC_DELAY_MS - 50, 'baseline must wait for delayed real HTTP receipt');
          assert.equal(scenario.firstRefresh.operation.status, 'success');
          assert.equal(scenario.firstRefresh.errors.length, 0);
        } else {
          assert(scenario.firstRefresh.elapsedMs >= ACTIVITY_BUDGET_MS - 10, 'candidate must enforce its elapsed budget');
          assert(scenario.firstRefresh.elapsedMs < RPC_DELAY_MS - 100, 'candidate must settle before delayed HTTP response');
          assert.equal(scenario.firstRefresh.operation.status, 'broadcasted-but-not-confirmed');
          assert.equal(scenario.firstRefresh.errors.length, 1);
          assert.equal(scenario.firstRefresh.errors[0].errorName, 'ActivityLookupTimeoutError');
          await waitFor(() => lane.receiptResponses === 1);
          await delay(25); // Let actual provider format and cache its completed response.
          scenario.afterLateResponseBeforeExplicitRefresh = fixture.summarize()[0];
          assert.equal(scenario.afterLateResponseBeforeExplicitRefresh.status, 'broadcasted-but-not-confirmed', 'late HTTP response must not mutate wallet state');
          const beforeRecoveryRequests = lane.requests.length;
          const recoveryStarted = performance.now();
          await fixture.update();
          scenario.recoveryRefresh = {
            elapsedMs: Number((performance.now() - recoveryStarted).toFixed(3)),
            operation: fixture.summarize()[0],
            additionalRpcRequests: lane.requests.length - beforeRecoveryRequests
          };
          assert.equal(scenario.recoveryRefresh.operation.status, 'success');
          assert.equal(scenario.recoveryRefresh.operation.blockNumber, 100);
          assert.equal(scenario.recoveryRefresh.additionalRpcRequests, 0, 'status reconciliation must reuse the fresh late receipt; later balance backfill is recorded separately');
        }
        // Real upstream filtering schedules balance-change receipt backfill.
        // Let that HTTP request finish before reading totals or destroying provider.
        await delay(25);
        await waitFor(() => lane.receiptResponses === lane.requests.filter(item => item.method === 'eth_getTransactionReceipt').length);
        await delay(25);
        scenario.backgroundReceiptLookupNote = 'With balanceChanges initially undefined, upstream activity filtering additionally fetches the receipt for balance-change backfill; this path is retained and counted.';
        const finalOperation = fixture.read()[0];
        scenario.formattedOperation = { status: finalOperation.status, blockNumber: finalOperation.blockNumber, blockHash: finalOperation.blockHash, gasUsed: finalOperation.gasUsed };
        assert.equal(finalOperation.blockNumber, 100);
        assert.equal(finalOperation.blockHash, BLOCK_HASH);
        assert.equal(finalOperation.gasUsed, '0x5208');
        scenario.formattedReceipts = structuredClone(formattedReceipts);
        assert.equal(formattedReceipts.length, 2);
        assert(formattedReceipts.every(receipt => receipt.className === 'TransactionReceipt' && receipt.statusType === 'number' && receipt.blockNumberType === 'number' && receipt.gasUsedType === 'bigint'), 'real provider must format hex receipt fields into its TransactionReceipt object');
        scenario.httpRequests = lane.httpRequests;
        scenario.rpcMethods = countMethods(lane.requests);
        scenario.networkRequests = structuredClone(lane.requests);
        scenario.receiptResponses = lane.receiptResponses;
        scenario.unexpectedMethods = structuredClone(lane.unexpectedMethods);
        scenario.serverErrors = structuredClone(lane.serverErrors);
        assert.equal(scenario.rpcMethods.eth_getTransactionReceipt, 2, 'one status receipt and one existing balance-change backfill receipt');
        assert.equal(scenario.receiptResponses, 2, 'complete all actual HTTP receipt responses before cleanup');
        assert.equal(scenario.unexpectedMethods.length, 0);
        assert.equal(scenario.serverErrors.length, 0);
        scenario.passed = true;
      } catch (error) {
        scenario.passed = false;
        scenario.error = String(error?.stack ?? error);
        scenario.rpcMethods = countMethods(lane.requests);
        scenario.networkRequests = structuredClone(lane.requests);
        throw error;
      } finally {
        fixture?.dispose();
        provider.destroy();
      }
    }
  }
  report.success = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const timer of responseTimers) clearTimeout(timer);
  responseTimers.clear();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  report.resourceCleanup = { serverListening: server.listening, pendingFixtureResponseTimers: responseTimers.size, providerDestroyCalledPerScenario: true };
  await fs.writeFile(path.join(here, 'http-results.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({success: report.success, scenarios:report.scenarios.map(({label,passed,firstRefresh,recoveryRefresh,rpcMethods,transportTimeoutMs}) => ({label,passed,firstRefreshMs:firstRefresh?.elapsedMs,firstStatus:firstRefresh?.operation?.status,recoveryMs:recoveryRefresh?.elapsedMs,rpcMethods,transportTimeoutMs})),error:report.error}) + '\n');
}
