import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createActivityFixture, makeReceipt, FIXTURE_ACCOUNT, FIXTURE_TRANSACTION, FIXTURE_FAST_TRANSACTION } from './controller-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const budget = 120;
const delay = 600;
const repeatCount = 3;
const pending = 'broadcasted-but-not-confirmed';
const success = 'success';
const failure = 'failure';
const stuck = 'broadcasted-but-stuck';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const statuses = (ops) => ops.map(op => ({id:op.id,status:op.status,blockNumber:op.blockNumber ?? null})).sort((a,b)=>a.id.localeCompare(b.id));
const persistedStatuses = (f) => statuses(f.readPersisted()[FIXTURE_ACCOUNT]?.['1'] ?? []);

function providerFixture({receiptDelay=10, receiptStatus=1, receiptNull=false, receiptError=false, transactionDelay=10, mixed=false}={}) {
  const inflight = new Set();
  const calls = [];
  const provider = {batchMaxCount:1,isWorking:true};
  function request(kind, hash) {
    const fast = mixed && hash === FIXTURE_FAST_TRANSACTION;
    const duration = kind === 'receipt' ? (fast ? 10 : receiptDelay) : transactionDelay;
    const call = {kind,hash,at:performance.now(),delayMs:duration};
    calls.push(call);
    const promise = new Promise((resolve,reject) => setTimeout(() => {
      call.settledAt = performance.now();
      if (kind === 'receipt' && receiptError && !fast) reject(new Error('Controlled provider transport error'));
      else resolve(kind === 'receipt' ? (receiptNull && !fast ? null : makeReceipt({hash,status:fast ? 1 : receiptStatus})) : null);
    },duration));
    inflight.add(promise);
    promise.then(()=>inflight.delete(promise),()=>inflight.delete(promise));
    return promise;
  }
  provider.getTransactionReceipt = hash => request('receipt',hash);
  provider.getTransaction = hash => request('transaction',hash);
  return {provider,calls,async drain(){while(inflight.size) await Promise.allSettled([...inflight]);await sleep(5);}, counts(){return {receipt:calls.filter(c=>c.kind==='receipt').length,transaction:calls.filter(c=>c.kind==='transaction').length};}};
}

const scenarios = [
  {id:'A01',name:'timely successful receipt',setup:{},terminal:success},
  {id:'A02',name:'timely reverted receipt',setup:{receiptStatus:0},terminal:failure},
  {id:'A03',name:'receipt unavailable, transaction unavailable',setup:{receiptNull:true},terminal:pending},
  {id:'A04',name:'timely provider error stays unresolved',setup:{receiptError:true},terminal:pending,error:true},
  {id:'A05',name:'slow success and explicit recovery',setup:{receiptDelay:delay},terminal:success,slow:true,recover:true},
  {id:'A06',name:'slow revert and explicit recovery',setup:{receiptDelay:delay,receiptStatus:0},terminal:failure,slow:true,recover:true},
  {id:'A07',name:'slow provider error and explicit error delivery',setup:{receiptDelay:delay,receiptError:true},terminal:pending,slow:true,recover:true,error:true},
  {id:'A08',name:'slow transaction lookup after null receipt',setup:{receiptNull:true,transactionDelay:delay},terminal:pending,slow:true,recover:true,transaction:true},
  {id:'A09',name:'fast operation remains visible alongside slow operation',setup:{receiptDelay:delay,mixed:true},terminal:success,slow:true,recover:true,mixed:true},
  {id:'A10',name:'repeated refreshes reuse one outstanding receipt lookup',setup:{receiptDelay:delay,receiptNull:true},terminal:pending,slow:true,repeated:true},
  {id:'A11',name:'concurrent refreshes share existing controller work',setup:{receiptDelay:delay},terminal:success,slow:true,recover:true,concurrent:true},
  {id:'A12',name:'30-minute operation remains eligible after activity deadline',setup:{receiptDelay:delay},terminal:success,slow:true,recover:true,aged:true},
  {id:'A13',name:'options omitted preserve upstream behavior',setup:{receiptDelay:delay},terminal:success,slow:true,optOut:true},
];

async function measure(label, scenario, repetition) {
  const candidate = label.endsWith('candidate');
  const useBudget = candidate && !scenario.optOut;
  const rpc = providerFixture(scenario.setup);
  const module = await import(`./bundles/${label}.mjs`);
  const current = label.startsWith('current');
  const extra = useBudget ? (current ? [undefined,undefined,{timeoutMs:budget}] : [undefined,{timeoutMs:budget}]) : [];
  const f = await createActivityFixture({ActivityController:module.ActivityController,provider:rpc.provider,commonVersion:current?'current':'pr35',controllerExtraArgs:extra,now:()=>Date.now()});
  // Precomputed empty balance changes isolates receipt-status tracking from the
  // existing history backfill path. The separate HTTP runner includes backfill.
  await f.addOperation({balanceChanges:[],...(scenario.aged?{timestamp:Date.now()-31*60_000}:{})});
  if(scenario.mixed) await f.addFastOperation({balanceChanges:[]});
  f.resetObservations();
  const start = performance.now();
  let firstElapsedMs;
  let first;
  let firstPersisted;
  let firstFiltered;
  let firstCounts;
  let firstMetrics;
  let afterLate;
  let recoveryElapsedMs = null;
  let second = null;
  try {
    await (scenario.concurrent ? Promise.all([f.update(),f.update(),f.update()]) : f.update());
    firstElapsedMs = performance.now()-start;
    first=statuses(f.read()); firstPersisted=persistedStatuses(f);firstFiltered=statuses(f.readFiltered());
    firstCounts=rpc.counts();firstMetrics=f.metrics();
    const slowFirst=first.find(op=>op.id==='controlled-slow-operation');
    assert.equal(slowFirst.status,useBudget&&scenario.slow ? pending : scenario.terminal);
    assert.deepEqual(firstPersisted,first,'persisted status must match the completed refresh');
    assert.deepEqual(firstFiltered,first,'filtered activity must match the completed refresh');
    assert(firstMetrics.updates>0,'completed refresh must emit activity');
    if(scenario.error) assert(firstMetrics.errors>0,'unavailability must remain observable');
    if(scenario.slow){
      if(useBudget) assert(firstElapsedMs<budget+160,`activity refresh exceeded local scheduling allowance: ${firstElapsedMs}`);
      else assert(firstElapsedMs>=delay-25,`baseline did not experience controlled delay: ${firstElapsedMs}`);
    }
    if(scenario.mixed) assert.equal(first.find(op=>op.id==='controlled-fast-operation').status,success);
    if(scenario.repeated){
      // Two more explicit refreshes before a budgeted 600ms request settles.
      await f.update(); await f.update();
      if(useBudget) assert.equal(rpc.counts().receipt,1,'outstanding receipt was multiplied');
      else assert.equal(rpc.counts().receipt,3,'reference fixture should make a request per completed refresh');
    }
    await rpc.drain();
    afterLate=statuses(f.read());
    if(useBudget&&scenario.slow){
      assert.deepEqual(afterLate,first,'late provider answer changed controller state without a refresh');
      assert.deepEqual(persistedStatuses(f),first,'late answer changed persisted status');
      assert.deepEqual(statuses(f.readFiltered()),first,'late answer changed activity list status');
    }
    if(scenario.recover && useBudget){
      const recoveryStart=performance.now();
      await f.update();
      recoveryElapsedMs=performance.now()-recoveryStart;
      second=statuses(f.read());
      assert.equal(second.find(op=>op.id==='controlled-slow-operation').status,scenario.terminal);
      assert.deepEqual(persistedStatuses(f),second,'recovery status must be persisted');
      assert.deepEqual(statuses(f.readFiltered()),second,'recovery status must be visible');
      if(!scenario.transaction) assert.equal(rpc.counts().receipt,scenario.mixed?2:1,'completed slow answer was refetched instead of consumed');
      await rpc.drain();
    }
    if(scenario.aged && useBudget) assert.equal(first[0].status,pending);
    const allStates=[first,afterLate,second].filter(Boolean);
    const incorrectTerminalLabels=allStates.flat().filter(op=>op.status===failure&&(!scenario.mixed&&scenario.terminal!==failure)).length;
    assert.equal(incorrectTerminalLabels,0,'temporary unavailability must not be labeled confirmed failure');
    return {label,scenarioId:scenario.id,name:scenario.name,repetition,verdict:'PASS',candidateContractVerdict:(!candidate&&scenario.slow&&!scenario.optOut)?'XFAIL':'PASS',firstElapsedMs,recoveryElapsedMs,first,firstPersisted,firstFiltered,afterLate,second,firstCounts,finalCounts:rpc.counts(),firstMetrics,finalMetrics:f.metrics(),incorrectTerminalLabels};
  } finally {await rpc.drain();f.dispose();}
}

const rows=[];
for(const label of ['pr35-baseline','pr35-candidate','current-baseline','current-candidate']) {
  for(const scenario of scenarios) {
    for(let repetition=1;repetition<=repeatCount;repetition++) {
      try { rows.push(await measure(label,scenario,repetition)); }
      catch(error) { rows.push({label,scenarioId:scenario.id,name:scenario.name,repetition,verdict:'FAIL',error:error.stack});console.error(`${label} ${scenario.id}: ${error.message}`); }
    }
  }
  console.log(`${label}: ${rows.filter(r=>r.label===label&&r.verdict==='PASS').length}/${scenarios.length*repeatCount} passed`);
}
const bundleSha256={};
for(const label of ['pr35-baseline','pr35-candidate','current-baseline','current-candidate']) bundleSha256[label]=createHash('sha256').update(await fs.readFile(path.join(here,'bundles',`${label}.mjs`))).digest('hex');
const report={generatedAt:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,activityBudgetMs:budget,controlledSlowDelayMs:delay,repeatCount,scenarioCount:scenarios.length,runCount:rows.length,passing:rows.filter(r=>r.verdict==='PASS').length,failing:rows.filter(r=>r.verdict==='FAIL').length,bundleSha256,scope:'Actual upstream ActivityController and classification/filter/persistence behavior. Controlled provider, account, storage, network and portfolio collaborators; no browser, private transport or live chain.',rows};
await fs.writeFile(path.join(here,'controller-results.json'),JSON.stringify(report,null,2)+'\n');
if(report.failing) process.exitCode=1;
