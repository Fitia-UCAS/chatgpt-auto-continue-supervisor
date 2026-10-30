const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const listeners = {};
const uiCalls = [];
const sessionStore = {};
let failNextEnable = false;
let failNextSessionSet = false;
const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
const storageArea = (store) => ({
  async get(keyOrDefaults = {}) {
    if (typeof keyOrDefaults === 'string') return { [keyOrDefaults]: store[keyOrDefaults] };
    return { ...keyOrDefaults, ...store };
  },
  async set(values) { Object.assign(store, values); },
  async remove(key) { delete store[key]; }
});
const chrome = {
  downloads: {
    setUiOptions(options, callback) {
      uiCalls.push({ enabled: options.enabled, at: Date.now() });
      queueMicrotask(() => {
        if (options.enabled && failNextEnable) {
          failNextEnable = false;
          chrome.runtime.lastError = { message: 'transient restore failure' };
          callback?.();
          chrome.runtime.lastError = undefined;
          return;
        }
        callback?.();
      });
    },
    onCreated: event('downloadCreated'),
    search: async () => []
  },
  storage: {
    local: storageArea({}),
    session: {
      ...storageArea(sessionStore),
      async set(values) {
        if (failNextSessionSet) {
          failNextSessionSet = false;
          throw new Error('transient session storage failure');
        }
        Object.assign(sessionStore, values);
      }
    },
    onChanged: event('storageChanged')
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
  tabs: {
    get: async () => null,
    sendMessage: async () => {},
    onRemoved: event('tabRemoved'),
    onUpdated: event('tabUpdated')
  },
  scripting: { executeScript: async () => {} },
  runtime: {
    lastError: undefined,
    onStartup: event('startup'),
    onInstalled: event('installed'),
    onSuspend: event('suspend'),
    onMessage: event('message')
  }
};

const context = vm.createContext({
  chrome,
  console,
  URL,
  Date,
  Promise,
  Map,
  Set,
  setTimeout,
  clearTimeout,
  queueMicrotask
});
const source = `${fs.readFileSync('background.js', 'utf8')}\n;globalThis.__downloadUiTest = { beginDownloadUiBatch, endDownloadUiBatch, hasDownloadUiBatchLease };`;
vm.runInContext(source, context, { filename: 'background.js' });

(async () => {
  const api = context.__downloadUiTest;
  const ignoredEnd = await api.endDownloadUiBatch(7, 'missing-batch');
  assert.equal(ignoredEnd.released, false);
  assert.equal(uiCalls.filter((call) => call.enabled === false).length, 0, 'an unacknowledged END must not suppress global download UI');

  const begin = await api.beginDownloadUiBatch(7, 11, 'batch-1');
  assert.equal(begin.ok, true);
  assert.equal(api.hasDownloadUiBatchLease(), true);
  assert.equal(uiCalls.at(-1).enabled, false);
  assert.equal(sessionStore.continueDownloadUiSuppression.owned, true, 'suppression ownership should survive a service-worker restart');

  listeners.downloadCreated({ id: 1, filename: 'test.md', url: 'https://example.test/file' });
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.ok(uiCalls.filter((call) => call.enabled === false).length >= 4, 'download creation should re-hide immediately, at 120ms, and at 400ms');

  const end = await api.endDownloadUiBatch(7, 'batch-1');
  assert.equal(end.ok, true);
  assert.equal(end.released, true);
  assert.equal(api.hasDownloadUiBatchLease(), false);

  await new Promise((resolve) => setTimeout(resolve, 1350));
  assert.equal(uiCalls.at(-1).enabled, true, 'normal download UI should be restored after the settling grace period');

  const trueCallsBeforeRetryTest = uiCalls.filter((call) => call.enabled === true).length;
  await api.beginDownloadUiBatch(7, 11, 'batch-2');
  failNextEnable = true;
  await api.endDownloadUiBatch(7, 'batch-2');
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.ok(uiCalls.filter((call) => call.enabled === true).length >= trueCallsBeforeRetryTest + 2, 'a transient restore failure should be retried');
  assert.equal(sessionStore.continueDownloadUiSuppression, undefined, 'confirmed restore should clear the recovery marker');

  failNextSessionSet = true;
  const beginWithPersistenceWarning = await api.beginDownloadUiBatch(7, 11, 'batch-3');
  assert.equal(beginWithPersistenceWarning.token, 'batch-3', 'BEGIN must acknowledge its token even when durable persistence temporarily fails');
  assert.ok(beginWithPersistenceWarning.warning);
  const endAfterPersistenceWarning = await api.endDownloadUiBatch(7, 'batch-3');
  assert.equal(endAfterPersistenceWarning.released, true, 'the acknowledged batch must still be releasable');
  await new Promise((resolve) => setTimeout(resolve, 1350));
  console.log('background download UI lease test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
