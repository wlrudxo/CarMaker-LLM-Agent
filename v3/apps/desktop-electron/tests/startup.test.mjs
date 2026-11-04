import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = new URL('../src/main.js', import.meta.url);
const electron = 'export const {app,BrowserWindow,Menu,Tray,dialog,globalShortcut,ipcMain,screen} = globalThis.__shell;';
let moduleId = 0;

async function harness() {
  const events = {};
  const calls = [];
  let destroyed = false;
  const window = {
    on(name, handler) { events[name] = handler; },
    setMenuBarVisibility() {},
    isDestroyed: () => destroyed,
    show() { calls.push('show'); },
    async loadFile(file, options) { calls.push(['file', file, options]); },
    async loadURL(url) { calls.push(['url', url]); }
  };
  globalThis.__shell = {
    app: { whenReady: () => new Promise(() => {}), on() {}, quit() { calls.push('quit'); } },
    BrowserWindow: function () { return window; }, Menu:{}, Tray:class {}, dialog:{},
    globalShortcut:{}, ipcMain:{handle(){}}, screen:{}
  };
  let source = await readFile(entry, 'utf8');
  source = source.replace("from 'electron'", `from 'data:text/javascript;base64,${Buffer.from(electron + '// instance ' + moduleId).toString('base64')}'`)
    .replace('const __filename = fileURLToPath(import.meta.url);', `const __filename = ${JSON.stringify(fileURLToPath(entry))};`)
    .replace('const FRONTEND_MAX_WAIT_MS = 30000;', 'const FRONTEND_MAX_WAIT_MS = 5;')
    .replace('const FRONTEND_RETRY_INTERVAL_MS = 1500;', 'const FRONTEND_RETRY_INTERVAL_MS = 2;');
  source += `\n// test module ${moduleId++}\nexport {createWindow,loadInitialContent,startFrontendRetry,stopFrontendRetry};
    export const hasRetry = () => frontendRetryTimer !== null;
    export const clearWindow = () => { mainWindow = null; };`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  mod.createWindow();
  return {mod, window, events, calls, destroy() { destroyed = true; mod.clearWindow(); }};
}

test('startup timeout shows fallback and retries, with a usable close action', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:false});
  const h = await harness();
  try {
    await h.mod.loadInitialContent();
    assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'file' && call[1].endsWith('fallback.html')));
    assert.ok(h.calls.includes('show'));
    assert.equal(h.calls.find(call => Array.isArray(call) && call[0] === 'file')[2].query.backendUrl,
      process.env.V3_BACKEND_URL || 'http://127.0.0.1:8000');
    assert.ok(h.mod.hasRetry());
    let prevented = false;
    h.events.close({preventDefault(){ prevented = true; }});
    assert.equal(prevented, false);
  } finally { h.mod.stopFrontendRetry(); globalThis.fetch = originalFetch; }
});

test('loadURL failure falls back and a later retry replaces fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true});
  const h = await harness();
  let attempts = 0;
  try {
    h.window.loadURL = async url => {
      h.calls.push(['url', url]);
      if (++attempts === 1) throw Error('fake navigation failure');
    };
    await h.mod.loadInitialContent();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'file'));
    assert.equal(attempts, 2);
    assert.equal(h.mod.hasRetry(), false);
    assert.equal(h.calls.filter(call => call === 'show').length, 2);
  } finally { h.mod.stopFrontendRetry(); globalThis.fetch = originalFetch; }
});

test('successful startup loads frontend directly and starts no retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true});
  const h = await harness();
  try {
    await h.mod.loadInitialContent();
    assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'file'));
    assert.equal(h.mod.hasRetry(), false);
  } finally { h.mod.stopFrontendRetry(); globalThis.fetch = originalFetch; }
});

test('closing while readiness probe is in flight cannot navigate or show a window', async () => {
  const originalFetch = globalThis.fetch;
  const h = await harness();
  globalThis.fetch = async () => { h.destroy(); return {ok:true}; };
  try {
    await h.mod.loadInitialContent();
    assert.deepEqual(h.calls, []);
  } finally { h.mod.stopFrontendRetry(); globalThis.fetch = originalFetch; }
});

test('retry probes do not overlap and a closed window is never navigated', async () => {
  const originalFetch = globalThis.fetch;
  const h = await harness();
  let probes = 0;
  let resolveProbe;
  globalThis.fetch = () => { probes += 1; return new Promise(resolve => { resolveProbe = resolve; }); };
  try {
    h.mod.startFrontendRetry();
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(probes, 1);
    h.destroy();
    resolveProbe({ok:true});
    await new Promise(resolve => setTimeout(resolve, 6));
    assert.deepEqual(h.calls, []);
  } finally {
    h.mod.stopFrontendRetry();
    if (resolveProbe) resolveProbe({ok:false});
    globalThis.fetch = originalFetch;
  }
});
