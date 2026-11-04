// Execute checked-in scripts with delayed API promises; no app, ports or user data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { writable } from 'svelte/store';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

async function execute(relative, imports, globals = {}) {
  let source = await readFile(new URL(relative, import.meta.url), 'utf8');
  if (relative.endsWith('.svelte')) source = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, console: { error() {} }, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    }
  });
  return exports;
}

const settings = host => ({ host, port: 16660, duration: 2000, controlMode: 'Abs', vehicleCommandParsingEnabled: true });
async function settingsHarness() {
  const calls = [];
  const car = {};
  const cache = new Map();
  const { autonomousDrivingSettingsStore: store } = await execute('../src/lib/stores/autonomousDrivingSettingsStore.ts', {
    'svelte/store': { writable },
    '$lib/backend': { requestJson(path, init) {
      assert.equal(path, '/api/settings/autonomous-driving');
      const response = deferred();
      calls.push({ init, ...response });
      return response.promise;
    } },
    '$lib/stores/carmakerStore.svelte': { carmakerStore: car }
  }, { window: {}, localStorage: { getItem: () => null, setItem: (key, value) => cache.set(key, value) } });
  const observed = [];
  store.subscribe(value => observed.push(value));
  return { store, calls, car, cache, observed };
}

function assertApplied(harness, expected) {
  assert.equal(harness.store.getCurrentState().host, expected.host);
  assert.equal(harness.car.host, expected.host);
  assert.equal(harness.car.port, String(expected.port));
  assert.equal(harness.observed.at(-1).host, expected.host);
  assert.equal(JSON.parse([...harness.cache.values()][0]).host, expected.host);
}

test('an initial GET arriving after a successful save cannot restore old settings', async () => {
  const h = await settingsHarness();
  const loading = h.store.loadSettings();
  const saving = h.store.saveSettings(settings('saved'));
  assert.equal(h.calls[1].init.method, 'PUT');
  h.calls[1].resolve(settings('saved'));
  await saving;
  h.calls[0].resolve(settings('old'));
  const loaded = await loading;
  assertApplied(h, settings('saved'));
  assert.equal(loaded.host, 'saved', 'callers must also receive the retained settings');
});

test('a GET started during a pending save cannot roll back the confirmed save', async () => {
  const h = await settingsHarness();
  const saving = h.store.saveSettings(settings('saved'));
  const loading = h.store.loadSettings();
  h.calls[0].resolve(settings('saved'));
  await saving;
  h.calls[1].resolve(settings('old'));
  await loading;
  assertApplied(h, settings('saved'));
});

test('overlapping GETs retain the most recently requested settings', async () => {
  const h = await settingsHarness();
  const first = h.store.loadSettings();
  const second = h.store.loadSettings();
  h.calls[1].resolve(settings('new'));
  await second;
  h.calls[0].resolve(settings('old'));
  await first;
  assertApplied(h, settings('new'));
});

test('load and save failures propagate, preserve confirmed state, and allow retry', async () => {
  const h = await settingsHarness();
  const initial = h.store.loadSettings();
  h.calls[0].resolve(settings('confirmed'));
  await initial;
  const stale = h.store.loadSettings();
  const failedSave = h.store.saveSettings(settings('failed'));
  h.calls[2].reject(Error('fake PUT failure'));
  await assert.rejects(failedSave, /fake PUT failure/);
  h.calls[1].resolve(settings('old'));
  await stale;
  assertApplied(h, settings('confirmed'));
  const failedLoad = h.store.loadSettings();
  h.calls[3].reject(Error('fake GET failure'));
  await assert.rejects(failedLoad, /fake GET failure/);
  assertApplied(h, settings('confirmed'));
  const retry = h.store.saveSettings(settings('retried'));
  h.calls[4].resolve(settings('retried'));
  await retry;
  assertApplied(h, settings('retried'));
});

async function layoutHarness() {
  const pending = deferred();
  const listeners = new Map();
  let mount;
  const register = name => callback => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  };
  await execute('../src/routes/+layout.svelte', {
    '../app.css': {},
    ...Object.fromEntries(['TitleBar', 'Sidebar', 'AIChatWidget', 'Dialog', 'ToastContainer'].map(name => [`$lib/components/${name}.svelte`, {}])),
    '$lib/actions/disableAutocomplete': {},
    '$lib/stores/uiStore': { uiStore: {} },
    '$lib/stores/settingsStore': { settingsStore: { loadSettings: async () => {} } },
    '$lib/stores/autonomousDrivingSettingsStore': { autonomousDrivingSettingsStore: { loadSettings: () => pending.promise } },
    '$lib/stores/dialogStore.svelte': { dialogStore: {} },
    '$lib/backend': { requestJson: () => { throw Error('Unexpected API call'); } },
    svelte: { onMount: callback => { mount = callback; } }
  }, {
    $props: () => ({}), $state: value => value, $derived: value => value, $effect() {},
    $uiStore: {}, $settingsStore: { minimizeToTray: false },
    window: {
      addEventListener: (name, callback) => register(name)(callback),
      removeEventListener: name => listeners.delete(name),
      desktop: { window: { onCloseRequested: register('close'), onEvent: register('tray') } }
    }
  });
  // Svelte accepts a synchronous cleanup function; promises are not destroy hooks.
  const cleanup = mount();
  return { pending, listeners, cleanup, destroy: () => { if (typeof cleanup === 'function') cleanup(); } };
}

test('layout supplies synchronous cleanup for key, close and tray listeners on every mount', async () => {
  for (let mount = 0; mount < 2; mount++) {
    const h = await layoutHarness();
    h.pending.resolve(settings('loaded'));
    await flush();
    assert.equal(h.listeners.size, 3);
    h.destroy();
    assert.equal(h.listeners.size, 0, 'destroy must release all three listeners');
    assert.equal(typeof h.cleanup, 'function');
  }
});

test('destroy before delayed settings finish cannot register orphan shell listeners', async () => {
  const h = await layoutHarness();
  h.destroy();
  h.pending.resolve(settings('late'));
  await flush();
  assert.equal(h.listeners.size, 0);
});

test('failed settings hydration still allows shell listeners to be cleaned up', async () => {
  const h = await layoutHarness();
  h.pending.reject(Error('fake GET failure'));
  await flush();
  assert.equal(h.listeners.size, 3);
  h.destroy();
  assert.equal(h.listeners.size, 0);
});
