/** Controlled collaborators around the real upstream ActivityController. */
export const FIXTURE_ACCOUNT = '0x1111111111111111111111111111111111111111';
export const FIXTURE_RECIPIENT = '0x2222222222222222222222222222222222222222';
export const FIXTURE_TRANSACTION = `0x${'aa'.repeat(32)}`;
export const FIXTURE_FAST_TRANSACTION = `0x${'bb'.repeat(32)}`;
const clone = (value) => structuredClone(value);

export function makeSubmittedOperation({
  id = 'controlled-slow-operation',
  hash = FIXTURE_TRANSACTION,
  accountAddr = FIXTURE_ACCOUNT,
  chainId = 1n,
  timestamp = Date.now(),
  eoaNonce = 0,
  ...overrides
} = {}) {
  return {
    id,
    accountAddr,
    signingKeyAddr: accountAddr,
    gasLimit: null,
    gasFeePayment: null,
    chainId,
    nonce: BigInt(eoaNonce),
    eoaNonce,
    signature: '0x',
    calls: [{ id: `${id}-call`, to: FIXTURE_RECIPIENT, value: 0n, data: '0x' }],
    txnId: hash,
    status: 'broadcasted-but-not-confirmed',
    identifiedBy: { type: 'Transaction', identifier: hash },
    timestamp,
    ...overrides
  };
}

export function makeReceipt({ hash = FIXTURE_TRANSACTION, status = 1, ...overrides } = {}) {
  return {
    hash,
    status,
    from: FIXTURE_ACCOUNT,
    to: FIXTURE_RECIPIENT,
    blockNumber: 100,
    blockHash: `0x${'cc'.repeat(32)}`,
    gasUsed: 21_000n,
    gasPrice: 1n,
    fee: 21_000n,
    logs: [],
    ...overrides
  };
}

/**
 * collaborator mocks isolate network, persistence and portfolio work. All status
 * classification, activity filtering, event emission and reconciliation remain
 * in the real ActivityController and its real upstream helper implementations.
 */
export async function createActivityFixture({
  ActivityController,
  provider,
  accountAddr = FIXTURE_ACCOUNT,
  chainId = 1n,
  additionalProviders = {},
  sessionId = 'controlled-reliability-benchmark',
  commonVersion = 'pr35',
  controllerExtraArgs = [],
  now = () => Date.now(),
  initialRecords = {}
}) {
  if (typeof ActivityController !== 'function') throw new TypeError('real ActivityController class is required');
  if (!provider || typeof provider.getTransactionReceipt !== 'function') {
    throw new TypeError('provider boundary must implement getTransactionReceipt');
  }
  const records = new Map(Object.entries(clone(initialRecords)));
  const writes = [];
  const updates = [];
  const errors = [];
  const portfolioCalls = [];
  let concurrentWrites = 0;
  let peakConcurrentWrites = 0;
  let controller;
  let disposed = false;
  let observationStart = now();

  const storage = {
    async get(key, fallback) {
      return clone(records.has(key) ? records.get(key) : fallback);
    },
    async set(key, value) {
      concurrentWrites += 1;
      peakConcurrentWrites = Math.max(peakConcurrentWrites, concurrentWrites);
      try {
        records.set(key, clone(value));
        writes.push({ atMs: now() - observationStart, key, value: clone(value) });
        // A real async boundary surfaces unintended parallel storage operations.
        await Promise.resolve();
      } finally {
        concurrentWrites -= 1;
      }
    },
    async remove(key) { records.delete(key); }
  };
  const accounts = {
    initialLoadPromise: Promise.resolve(),
    accounts: [{ addr: accountAddr, associatedKeys: [accountAddr], initialPrivileges: [] }]
  };
  const selectedAccount = {
    initialLoadPromise: Promise.resolve(),
    account: accounts.accounts[0]
  };
  const providersByChain = { [String(chainId)]: provider, ...additionalProviders };
  const providers = { providers: providersByChain };
  const networks = {
    networks: Object.keys(providersByChain).map((id) => ({ chainId: BigInt(id), rpcUrls: ['https://fixture.invalid'], selectedRpcUrl: 'https://fixture.invalid' })),
    isInitialized: true
  };
  const portfolio = {
    addTokensToBeLearned(tokens, forChainId) {
      portfolioCalls.push({ type: 'addTokensToBeLearned', tokens: clone(tokens), chainId: String(forChainId) });
    },
    addErc721sToBeLearned(tokens, forChainId) {
      portfolioCalls.push({ type: 'addErc721sToBeLearned', tokens: clone(tokens), chainId: String(forChainId) });
    },
    async getTokenBalancesOnBlock(...args) {
      portfolioCalls.push({ type: 'getTokenBalancesOnBlock', args: clone(args) });
      const forChainId = args[1];
      const addresses = args[2] ?? [];
      return addresses.map((address) => ['0x', {
        address, chainId: forChainId, symbol: 'FIXTURE', name: 'Controlled token',
        decimals: 18, amount: 0n, priceIn: [], marketDataIn: [], flags: {}, meta: {}
      }]);
    }
  };
  const noExternal = async () => { throw new Error('unexpected external call in local Transaction fixture'); };
  const callback = async () => {};
  const constructorArgs = [storage, noExternal, noExternal, accounts, selectedAccount, providers, networks, portfolio, {}];
  // Current common added FeatureFlagsController before deployment callback.
  if (commonVersion === 'current') constructorArgs.push({ isFeatureEnabled: () => undefined });
  constructorArgs.push(callback, ...controllerExtraArgs);
  controller = new ActivityController(...constructorArgs);

  const read = () => clone(controller.getAccountOpsForAccount({ accountAddr }));
  const summarize = () => read().map((op) => ({ id: op.id, txnId: op.txnId, status: op.status, blockNumber: op.blockNumber }));
  const unsubscribeUpdate = controller.onUpdate(() => {
    updates.push({ atMs: now() - observationStart, operations: summarize() });
  });
  const unsubscribeError = controller.onError((event) => {
    errors.push({ atMs: now() - observationStart, level: event.level, message: event.message, errorName: event.error?.name, errorMessage: event.error?.message });
  });
  await controller.filterAccountsOps(sessionId, { account: accountAddr }, { fromPage: 0, itemsPerPage: 100 });

  return {
    controller,
    storage,
    accounts,
    selectedAccount,
    providers,
    networks,
    portfolio,
    read,
    readFiltered() { return clone(controller.accountsOps[sessionId]?.result.items ?? []); },
    readPersisted() { return clone(records.get('accountsOps') ?? {}); },
    summarize,
    async addOperation(overrides = {}) {
      const operation = makeSubmittedOperation({ accountAddr, chainId, timestamp: now(), ...overrides });
      await controller.addAccountOp(operation);
      return operation;
    },
    async addFastOperation(overrides = {}) {
      const operation = makeSubmittedOperation({ id: 'controlled-fast-operation', hash: FIXTURE_FAST_TRANSACTION, accountAddr, chainId, timestamp: now(), eoaNonce: 1, ...overrides });
      await controller.addAccountOp(operation);
      return operation;
    },
    update(accountAddresses = [accountAddr]) { return controller.updateAccountsOpsStatuses(accountAddresses); },
    observations: { writes, updates, errors, portfolioCalls },
    metrics() { return { writes: writes.length, updates: updates.length, errors: errors.length, portfolioCalls: portfolioCalls.length, peakConcurrentWrites }; },
    resetObservations() {
      writes.length = 0;
      updates.length = 0;
      errors.length = 0;
      portfolioCalls.length = 0;
      peakConcurrentWrites = 0;
      observationStart = now();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeUpdate();
      unsubscribeError();
      controller.destroy?.();
      // Caller owns provider fixtures/timers and must settle outstanding provider
      // requests before disposing. This function does not claim RPC cancellation.
    }
  };
}
