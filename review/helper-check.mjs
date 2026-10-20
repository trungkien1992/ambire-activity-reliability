import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createActivityFixture, makeReceipt } from '../harness/controller-fixture.mjs';

// Exercise the real, freshly built candidate exports without editing source.
const labels = ['pr35', 'current'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const observe = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error })
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const spin = (ms) => {
  const start = performance.now();
  while (performance.now() - start < ms) { /* controlled event-loop delay */ }
};

function trackedTimers() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const active = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = originalSet(() => { active.delete(timer); fn(...args); }, ms);
    active.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    active.delete(timer);
    return originalClear(timer);
  };
  return {
    active,
    sleep: (ms) => new Promise((resolve) => originalSet(resolve, ms)),
    restore() { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
  };
}

const results = [];
const unhandled = [];
const recordUnhandled = (error) => unhandled.push(error);
process.on('unhandledRejection', recordUnhandled);

for (const label of labels) {
  const { ActivityLookups, ActivityLookupTimeoutError, ActivityController } = await import(`../harness/bundles/${label}-candidate.mjs`);
  const timeout = (result) => {
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ActivityLookupTimeoutError);
  };
  const providerFor = (receiptRequest, transactionRequest = async () => null) => ({
    getTransactionReceipt: receiptRequest,
    getTransaction: transactionRequest
  });
  async function test(name, fn) {
    const start = performance.now();
    try {
      await fn();
      results.push({ candidate: label, name, passed: true, durationMs: Math.round(performance.now() - start) });
    } catch (error) {
      results.push({ candidate: label, name, passed: false, error: error.stack ?? String(error) });
    }
  }

  await test('default preserves direct promise and synchronous error behavior', async () => {
    const request = deferred();
    const helper = new ActivityLookups();
    const provider = providerFor(() => request.promise);
    assert.equal(helper.getReceipt(provider, '0xAA'), request.promise);
    request.resolve(null);
    await request.promise;
    const error = new Error('synchronous provider error');
    assert.throws(() => helper.getReceipt(providerFor(() => { throw error; }), '0xAA'), (value) => value === error);
    helper.dispose();
  });

  await test('constructor validates both caller budgets', async () => {
    for (const value of [0, -1, 1.1, NaN, Infinity, 2_147_483_648]) {
      assert.throws(() => new ActivityLookups({ timeoutMs: value }), RangeError);
      assert.throws(() => new ActivityLookups({ maxResultAgeMs: value }), RangeError);
    }
    new ActivityLookups({ timeoutMs: 1, maxResultAgeMs: 1 }).dispose();
    new ActivityLookups({ timeoutMs: 2_147_483_647, maxResultAgeMs: 2_147_483_647 }).dispose();
  });

  await test('pending receipt deduplicates case variants and late answer is consumed once', async () => {
    let calls = 0;
    const request = deferred();
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 100 });
    const provider = providerFor(() => { calls++; return request.promise; });
    const first = observe(helper.getReceipt(provider, '0xABC'));
    const second = observe(helper.getReceipt(provider, '0xabc'));
    timeout(await first); timeout(await second);
    assert.equal(calls, 1);
    const value = { hash: '0xabc', status: 1 };
    request.resolve(value);
    await tick();
    assert.equal(await helper.getReceipt(provider, '0xabc'), value);
    assert.equal(calls, 1);
    assert.equal(await helper.getReceipt(provider, '0xabc'), value);
    assert.equal(calls, 2);
    helper.dispose();
  });

  await test('receipt and transaction requests use independent caches', async () => {
    const receipt = deferred(), transaction = deferred();
    let receiptCalls = 0, transactionCalls = 0;
    const helper = new ActivityLookups({ timeoutMs: 50 });
    const provider = providerFor(() => { receiptCalls++; return receipt.promise; }, () => { transactionCalls++; return transaction.promise; });
    const first = helper.getReceipt(provider, '0xabc');
    const second = helper.getTransaction(provider, '0xabc');
    receipt.resolve({ type: 'receipt' }); transaction.resolve({ type: 'transaction' });
    assert.equal((await first).type, 'receipt');
    assert.equal((await second).type, 'transaction');
    assert.equal(receiptCalls, 1); assert.equal(transactionCalls, 1);
    helper.dispose();
  });

  await test('replacement provider with same hash has independent lookup', async () => {
    const old = deferred();
    let oldCalls = 0, newCalls = 0;
    const helper = new ActivityLookups({ timeoutMs: 8 });
    const oldProvider = providerFor(() => { oldCalls++; return old.promise; });
    const newProvider = providerFor(async () => { newCalls++; return { source: 'new' }; });
    timeout(await observe(helper.getReceipt(oldProvider, '0xabc')));
    assert.equal((await helper.getReceipt(newProvider, '0xabc')).source, 'new');
    old.resolve({ source: 'old' });
    await tick();
    assert.equal((await helper.getReceipt(oldProvider, '0xabc')).source, 'old');
    assert.equal(oldCalls, 1); assert.equal(newCalls, 1);
    helper.dispose();
  });

  await test('event-loop delayed success remains available to the next explicit refresh', async () => {
    let calls = 0;
    const request = deferred();
    const helper = new ActivityLookups({ timeoutMs: 15, maxResultAgeMs: 100 });
    const provider = providerFor(() => { calls++; return request.promise; });
    const first = observe(helper.getReceipt(provider, '0xabc'));
    await Promise.resolve();
    request.resolve({ status: 1 });
    spin(25);
    timeout(await first);
    assert.equal((await helper.getReceipt(provider, '0xabc')).status, 1);
    assert.equal(calls, 1);
    helper.dispose();
  });

  await test('event-loop delayed rejection preserves timeout then original error', async () => {
    let calls = 0;
    const error = new Error('late provider error');
    const request = deferred();
    const helper = new ActivityLookups({ timeoutMs: 15, maxResultAgeMs: 100 });
    const provider = providerFor(() => { calls++; return request.promise; });
    const first = observe(helper.getReceipt(provider, '0xabc'));
    await Promise.resolve();
    request.reject(error);
    spin(25);
    timeout(await first);
    assert.equal((await observe(helper.getReceipt(provider, '0xabc'))).error, error);
    assert.equal(calls, 1);
    helper.dispose();
  });

  await test('mixed-age waiters deliver to eligible waiter without retaining consumed answer', async () => {
    let calls = 0;
    const request = deferred();
    const helper = new ActivityLookups({ timeoutMs: 60, maxResultAgeMs: 100 });
    const provider = providerFor(() => { calls++; return request.promise; });
    const older = observe(helper.getReceipt(provider, '0xabc'));
    await sleep(40);
    const newer = observe(helper.getReceipt(provider, '0xabc'));
    request.resolve({ status: 1 });
    spin(30);
    timeout(await older);
    assert.equal((await newer).value.status, 1);
    assert.equal(calls, 1);
    await helper.getReceipt(provider, '0xabc');
    assert.equal(calls, 2);
    helper.dispose();
  });

  await test('normal errors and synchronous opt-in errors preserve error identity and retry', async () => {
    const error = new Error('provider failure');
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 50 });
    const provider = providerFor(() => { calls++; if (calls === 1) throw error; return Promise.resolve(null); });
    assert.equal((await observe(helper.getReceipt(provider, '0xabc'))).error, error);
    assert.equal(await helper.getReceipt(provider, '0xabc'), null);
    assert.equal(calls, 2);
    helper.dispose();
  });

  await test('late rejection is handled and available to the next explicit refresh', async () => {
    let calls = 0;
    const request = deferred();
    const error = new Error('late rejection');
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 100 });
    const provider = providerFor(() => { calls++; return request.promise; });
    timeout(await observe(helper.getReceipt(provider, '0xabc')));
    request.reject(error);
    await tick();
    assert.equal((await observe(helper.getReceipt(provider, '0xabc'))).error, error);
    assert.equal(calls, 1);
    helper.dispose();
  });

  await test('completed answer expires autonomously and later refresh retries', async () => {
    const timers = trackedTimers();
    const request = deferred();
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 20 });
    const provider = providerFor(() => { calls++; return calls === 1 ? request.promise : Promise.resolve({ version: 2 }); });
    try {
      timeout(await observe(helper.getReceipt(provider, '0xabc')));
      assert.equal(timers.active.size, 0);
      request.resolve({ version: 1 });
      await tick();
      assert.equal(timers.active.size, 1, 'one completed-answer expiry timer');
      await timers.sleep(30);
      assert.equal(timers.active.size, 0, 'completed-answer timer expires without another refresh');
      assert.equal((await helper.getReceipt(provider, '0xabc')).version, 2);
      assert.equal(calls, 2);
      assert.equal(timers.active.size, 0);
    } finally { helper.dispose(); timers.restore(); }
  });

  await test('fresh completed answer consumption clears its expiry timer', async () => {
    const timers = trackedTimers();
    const request = deferred();
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 100 });
    const provider = providerFor(() => request.promise);
    try {
      timeout(await observe(helper.getReceipt(provider, '0xabc')));
      request.resolve(null);
      await tick();
      assert.equal(timers.active.size, 1);
      assert.equal(await helper.getReceipt(provider, '0xabc'), null);
      assert.equal(timers.active.size, 0);
    } finally { helper.dispose(); timers.restore(); }
  });

  await test('expired completed answer is rejected even before its cleanup timer can run', async () => {
    const request = deferred();
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 15 });
    const provider = providerFor(() => { calls++; return calls === 1 ? request.promise : Promise.resolve({ version: 2 }); });
    try {
      timeout(await observe(helper.getReceipt(provider, '0xabc')));
      request.resolve({ version: 1 });
      await tick();
      spin(25);
      assert.equal((await helper.getReceipt(provider, '0xabc')).version, 2);
      assert.equal(calls, 2);
    } finally { helper.dispose(); }
  });

  await test('BUG: same-job disposal prevents a provider request that has not started yet', async () => {
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 50 });
    const provider = providerFor(async () => { calls++; return null; });
    const first = observe(helper.getReceipt(provider, '0xabc'));
    helper.dispose();
    timeout(await first);
    await tick();
    assert.equal(calls, 0, 'disposal should prevent a queued transport request from starting');
  });

  await test('disposal rejects active waiters, clears timers, blocks new opt-in requests and tolerates late settlement', async () => {
    const timers = trackedTimers();
    const request = deferred();
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 1_000 });
    const provider = providerFor(() => { calls++; return request.promise; });
    try {
      const first = observe(helper.getReceipt(provider, '0xabc'));
      const second = observe(helper.getReceipt(provider, '0xabc'));
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(timers.active.size, 2);
      helper.dispose(); helper.dispose();
      timeout(await first); timeout(await second);
      assert.equal(timers.active.size, 0);
      timeout(await observe(helper.getReceipt(provider, '0xabc')));
      assert.equal(calls, 1);
      request.resolve({ status: 1 });
      await tick();
      assert.equal(timers.active.size, 0, 'disposed entry cannot create a completed-answer timer');
    } finally { helper.dispose(); timers.restore(); }
  });

  await test('disposal clears completed-answer metadata timer and late rejection handler remains safe', async () => {
    const timers = trackedTimers();
    const completed = deferred(), pending = deferred();
    const helper = new ActivityLookups({ timeoutMs: 8, maxResultAgeMs: 100 });
    const provider = providerFor((hash) => hash === '0xaaa' ? completed.promise : pending.promise);
    try {
      timeout(await observe(helper.getReceipt(provider, '0xaaa')));
      timeout(await observe(helper.getReceipt(provider, '0xbbb')));
      completed.resolve(null);
      await tick();
      assert.equal(timers.active.size, 1);
      helper.dispose();
      assert.equal(timers.active.size, 0);
      pending.reject(new Error('rejection after disposal'));
      await tick();
      assert.equal(timers.active.size, 0);
    } finally { helper.dispose(); timers.restore(); }
  });

  await test('repeated timed-out refreshes attach a fixed number of underlying promise reactions', async () => {
    const request = deferred();
    let calls = 0;
    const helper = new ActivityLookups({ timeoutMs: 2 });
    const provider = providerFor(() => { calls++; return request.promise; });
    const originalThen = Promise.prototype.then;
    const counts = new Map();
    Promise.prototype.then = function (...args) {
      counts.set(this, (counts.get(this) ?? 0) + 1);
      return originalThen.apply(this, args);
    };
    try {
      for (let i = 0; i < 25; i++) timeout(await observe(helper.getReceipt(provider, '0xabc')));
      assert.equal(calls, 1);
      assert.ok(Math.max(...counts.values()) <= 2, `handler attachment count ${Math.max(...counts.values())}`);
    } finally {
      Promise.prototype.then = originalThen;
      helper.dispose(); request.resolve(null); await tick();
    }
  });

  await test('controller keeps aged operation pending after budget expiry and classifies only next explicit refresh', async () => {
    const request = deferred();
    let calls = 0;
    const provider = providerFor(() => { calls++; return request.promise; });
    const extra = label === 'current' ? [undefined, undefined, { timeoutMs: 8, maxResultAgeMs: 100 }] : [undefined, { timeoutMs: 8, maxResultAgeMs: 100 }];
    const fixture = await createActivityFixture({ ActivityController, provider, commonVersion: label, controllerExtraArgs: extra });
    try {
      // Suppress existing history backfill so the request count measures only
      // the status lookup under review; balance-change work has its own path.
      await fixture.addOperation({ timestamp: Date.now() - 31 * 60 * 1000, balanceChanges: [] });
      await fixture.update();
      assert.equal(fixture.summarize()[0].status, 'broadcasted-but-not-confirmed');
      request.resolve(makeReceipt());
      await tick();
      assert.equal(fixture.summarize()[0].status, 'broadcasted-but-not-confirmed');
      await fixture.update();
      assert.equal(fixture.summarize()[0].status, 'success');
      assert.equal(calls, 1);
    } finally { fixture.dispose(); }
  });

  await test('controller replacement provider classifies independently and old late success cannot overwrite it', async () => {
    const old = deferred();
    let oldCalls = 0, newCalls = 0;
    const provider = providerFor(() => { oldCalls++; return old.promise; });
    const extra = label === 'current' ? [undefined, undefined, { timeoutMs: 8, maxResultAgeMs: 100 }] : [undefined, { timeoutMs: 8, maxResultAgeMs: 100 }];
    const fixture = await createActivityFixture({ ActivityController, provider, commonVersion: label, controllerExtraArgs: extra });
    try {
      await fixture.addOperation({ balanceChanges: [] });
      await fixture.update();
      fixture.providers.providers['1'] = providerFor(async () => { newCalls++; return makeReceipt({ status: 0 }); });
      await fixture.update();
      assert.equal(fixture.summarize()[0].status, 'failure');
      old.resolve(makeReceipt());
      await tick();
      assert.equal(fixture.summarize()[0].status, 'failure');
      assert.equal(oldCalls, 1); assert.equal(newCalls, 1);
    } finally { fixture.dispose(); }
  });
}

await tick();
process.off('unhandledRejection', recordUnhandled);
if (unhandled.length) results.push({ name: 'no unhandled promise rejections', passed: false, errors: unhandled.map(String) });
else results.push({ name: 'no unhandled promise rejections', passed: true });
const summary = { passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results };
await fs.writeFile(new URL('./helper-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;
