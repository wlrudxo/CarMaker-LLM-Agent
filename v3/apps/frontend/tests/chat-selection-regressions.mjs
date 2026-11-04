// Run the real ChatView script, conversation helper, bus and UI store with fake API promises.
// Svelte runes/mount and timers are stubs: no renderer, app, network or user data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { get, writable } from 'svelte/store';

const flush = () => new Promise(resolve => setImmediate(resolve));
const defaults = (id = 10, model = 'sonnet') => ({ defaultPromptTemplateId: id, defaultClaudeModel: model });

async function execute(relative, imports, globals = {}, inspect = '') {
  let source = await readFile(new URL(relative, import.meta.url), 'utf8');
  if (relative.endsWith('.svelte')) {
    const script = parse(source).instance.content;
    source = source.slice(script.start, script.end);
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled + inspect, {
    exports, console: { error() {}, warn() {} }, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    }
  });
  return exports;
}

async function harness(storedId = null) {
  const calls = [];
  const timers = [];
  const cache = new Map(storedId === null ? [] : [['agi_voice_conversation_id', String(storedId)]]);
  const ui = await execute('../src/lib/stores/uiStore.ts', { 'svelte/store': { writable } }, {
    window: {}, localStorage: {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: key => cache.delete(key)
    }
  });
  const { chatBus } = await execute('../src/lib/stores/chatBus.ts', { 'svelte/store': { writable } });
  const backend = { requestJson(path) {
    assert.match(path, /^\/api\/(settings\/chat|conversations\/\d+(\/messages\?limit=50)?)$/);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ path, resolve, reject });
    return promise;
  } };
  const parser = { parseWithSegments: content => [{ type: 'text', content }] };
  const conversation = await execute('../src/lib/chat/chatConversation.ts', {
    '$lib/backend': backend, '$lib/actions/parser': parser
  });
  let mount;
  const view = await execute('../src/lib/components/ChatView.svelte', {
    svelte: { onMount: callback => { mount = callback; } },
    '$lib/backend': backend,
    '$lib/stores/uiStore': ui,
    '$lib/stores/chatBus': { chatBus },
    '$lib/stores/dbWatcher.svelte': {},
    '$lib/stores/autonomousDrivingSettingsStore': {},
    '$lib/actions/parser': parser,
    '$lib/chat/chatConversation': conversation,
    '$lib/chat/chatResponseOrchestrator': {},
    '$lib/components/ChatMessageList.svelte': {}
  }, {
    $state: value => value, $uiStore: get(ui.uiStore),
    setTimeout: callback => { timers.push(callback); }
  }, '\nexports.snapshot = () => ({ conversationId, messages, promptTemplateId, claudeModel, settingsLoaded });');
  const destroy = mount();
  const snapshot = () => structuredClone({ ...view.snapshot(), ui: get(ui.uiStore), cache: [...cache] });
  return {
    calls, timers, destroy, snapshot, bus: chatBus,
    select(id) { chatBus.selectConversation(id); return calls.at(-1); },
    async finish(call, id, title = `conversation ${id}`) {
      call.resolve({ promptTemplateId: id * 100, title });
      await flush();
      const messages = calls.at(-1);
      assert.equal(messages.path, `/api/conversations/${id}/messages?limit=50`);
      messages.resolve([{ role: 'user', content: `message ${id}`, createdAt: '2026-01-02T03:04:05Z' }]);
      await flush();
    }
  };
}

function assertConversation(h, id) {
  const state = h.snapshot();
  assert.equal(state.conversationId, id);
  assert.equal(state.promptTemplateId, id * 100);
  assert.equal(state.ui.currentConversationId, id);
  assert.equal(state.ui.currentConversationTitle, `conversation ${id}`);
  assert.deepEqual(state.messages.map(message => message.content), [`message ${id}`]);
  assert.ok(state.cache.some(([key, value]) => key === 'agi_voice_conversation_id' && value === String(id)));
}

test('A then B with reversed responses retains B, including title, prompt and persisted ID', async () => {
  const h = await harness();
  const a = h.select(1);
  const b = h.select(2);
  await h.finish(b, 2);
  const before = h.snapshot();
  const timers = h.timers.length;
  await h.finish(a, 1);
  assertConversation(h, 2);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.timers.length, timers, 'stale results must not schedule scroll');
});

test('a message-stage response from A cannot overwrite a later B', async () => {
  const h = await harness();
  h.select(1).resolve({ promptTemplateId: 100, title: 'conversation 1' });
  await flush();
  const messagesA = h.calls.at(-1);
  const b = h.select(2);
  await h.finish(b, 2);
  messagesA.resolve([{ role: 'user', content: 'late A', createdAt: '2026-01-02T03:04:05Z' }]);
  await flush();
  assertConversation(h, 2);
});

test('selecting the same ID again still invalidates its earlier request', async () => {
  const h = await harness();
  const first = h.select(1);
  const second = h.select(1);
  await h.finish(second, 1);
  await h.finish(first, 1, 'stale title');
  assertConversation(h, 1);
});

test('A then new conversation cannot restore A after default settings finish', async () => {
  const h = await harness();
  const a = h.select(1);
  const settings = h.select(null);
  settings.resolve(defaults(20));
  await flush();
  const before = h.snapshot();
  await h.finish(a, 1);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(before.conversationId, null);
  assert.equal(before.ui.currentConversationTitle, null);
  assert.equal(before.promptTemplateId, 20);
  assert.deepEqual(before.messages, []);
});

for (const target of [2, null]) {
  for (const error of ['fake GET failure', 'conversation not found']) {
    test(`stale A ${error} cannot mutate selection ${target}`, async () => {
      const h = await harness();
      const a = h.select(1);
      const next = h.select(target);
      if (target === null) { next.resolve(defaults()); await flush(); }
      else await h.finish(next, target);
      const before = h.snapshot();
      a.reject(Error(error));
      await flush();
      assert.deepEqual(h.snapshot(), before);
    });
  }
}

for (const outcome of ['success', 'fake GET failure', 'conversation not found']) {
  test(`unmount ignores pending conversation ${outcome} and releases bus subscriptions`, async () => {
    const h = await harness(1);
    const a = h.calls[1];
    h.destroy();
    const before = h.snapshot();
    const timers = h.timers.length;
    if (outcome === 'success') await h.finish(a, 1);
    else { a.reject(Error(outcome)); await flush(); }
    h.bus.selectConversation(2);
    h.bus.notifyChatSettingsUpdated();
    h.bus.pushTriggerEvent({ type: 'error', triggerName: 'fake', content: 'unsubscribed' });
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.timers.length, timers);
    assert.ok(!h.calls.some(call => call.path === '/api/conversations/2'));
    assert.equal(h.calls.filter(call => call.path === '/api/settings/chat').length, 1);
  });
}

test('current conversation errors remain visible and a failed selection can be retried', async () => {
  const h = await harness();
  h.select(1).reject(Error('fake GET failure'));
  await flush();
  assert.equal(h.snapshot().messages.at(-1).content, '대화를 불러오는데 실패했습니다.');
  await h.finish(h.select(1), 1);
  assertConversation(h, 1);
});

test('a current not-found still clears the persisted conversation ID and title', async () => {
  const h = await harness(1);
  const a = h.calls.find(call => call.path === '/api/conversations/1');
  a.reject(Error('conversation not found'));
  await flush();
  const state = h.snapshot();
  assert.equal(state.ui.currentConversationId, null);
  assert.equal(state.ui.currentConversationTitle, null);
  assert.ok(!state.cache.some(([key]) => key === 'agi_voice_conversation_id'));
});

for (const settingsFirst of [true, false]) {
  test(`mount settings and stored conversation preserve its prompt (settings first: ${settingsFirst})`, async () => {
    const h = await harness(1);
    const settings = h.calls[0];
    const a = h.calls[1];
    if (settingsFirst) { settings.resolve(defaults(10, 'opus')); await flush(); }
    await h.finish(a, 1);
    if (!settingsFirst) { settings.resolve(defaults(10, 'opus')); await flush(); }
    assertConversation(h, 1);
    assert.equal(h.snapshot().claudeModel, 'opus');
    assert.equal(h.snapshot().settingsLoaded, true);
  });
}

test('settings refresh while a selection is pending cannot replace its conversation prompt', async () => {
  const h = await harness();
  const a = h.select(1);
  h.bus.notifyChatSettingsUpdated();
  const settings = h.calls.at(-1);
  await h.finish(a, 1);
  settings.resolve(defaults(30, 'opus'));
  await flush();
  assertConversation(h, 1);
  assert.equal(h.snapshot().claudeModel, 'opus');
});

test('new conversation ignores older settings success and uses the latest defaults', async () => {
  const h = await harness();
  const old = h.calls[0];
  const current = h.select(null);
  current.resolve(defaults(20, 'opus'));
  await flush();
  const before = h.snapshot();
  old.resolve(defaults(10, 'sonnet'));
  await flush();
  assert.deepEqual(h.snapshot(), before);
  assert.equal(before.promptTemplateId, 20);
  assert.equal(before.claudeModel, 'opus');
});

test('a superseded settings failure cannot add an error after current defaults succeed', async () => {
  const h = await harness();
  const old = h.calls[0];
  h.select(null).resolve(defaults(20, 'opus'));
  await flush();
  const before = h.snapshot();
  old.reject(Error('stale settings failure'));
  await flush();
  assert.deepEqual(h.snapshot(), before);
});

test('default settings arriving during conversation loading cannot supply its prompt or error rows', async () => {
  const h = await harness(1);
  h.calls[0].resolve(defaults(null, 'opus'));
  await flush();
  const state = h.snapshot();
  assert.equal(state.promptTemplateId, null);
  assert.deepEqual(state.messages, []);
  assert.equal(state.claudeModel, 'opus');
  assert.equal(state.settingsLoaded, true);
  await h.finish(h.calls[1], 1);
  assertConversation(h, 1);
});

for (const outcome of ['missing prompt', 'failure']) {
  test(`stale settings ${outcome} cannot add errors to a selected conversation`, async () => {
    const h = await harness();
    await h.finish(h.select(1), 1);
    const settings = h.calls[0];
    if (outcome === 'failure') settings.reject(Error('fake settings failure'));
    else settings.resolve(defaults(null));
    await flush();
    assertConversation(h, 1);
  });
}

for (const outcome of ['success', 'failure']) {
  test(`unmount ignores pending settings ${outcome}`, async () => {
    const h = await harness();
    h.destroy();
    const before = h.snapshot();
    if (outcome === 'success') h.calls[0].resolve(defaults());
    else h.calls[0].reject(Error('fake settings failure'));
    await flush();
    assert.deepEqual(h.snapshot(), before);
  });
}

test('new-chat default configuration and settings failure messages remain available', async () => {
  const h = await harness();
  h.calls[0].resolve(defaults(null));
  await flush();
  assert.equal(h.snapshot().messages.at(-1).role, 'error');
  assert.match(h.snapshot().messages.at(-1).content, /채팅 설정이 되어있지 않습니다/);
  h.bus.notifyChatSettingsUpdated();
  h.calls.at(-1).reject(Error('fake settings failure'));
  await flush();
  assert.equal(h.snapshot().messages.at(-1).content, '설정을 불러오는데 실패했습니다.');
  h.bus.notifyChatSettingsUpdated();
  h.calls.at(-1).resolve(defaults(30, 'opus'));
  await flush();
  assert.equal(h.snapshot().settingsLoaded, true);
  assert.equal(h.snapshot().promptTemplateId, 30);
  assert.equal(h.snapshot().claudeModel, 'opus');
});
