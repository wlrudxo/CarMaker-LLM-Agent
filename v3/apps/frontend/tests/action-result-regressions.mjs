// Execute the real parser, executor and orchestrator with synthetic API/vehicle boundaries.
// No HTTP, DB, LLM, CarMaker, renderer or user data is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function execute(relative, imports = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, console: { error() {}, log() {} },
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    }
  });
  return exports;
}

const tags = {
  create: '<map|name:synthetic>',
  update: '<update_map|id:7|name:synthetic>',
  delete: '<delete_map|id:7>'
};
const method = { create: 'POST', update: 'PUT', delete: 'DELETE' };

async function harness({ followup = '', api = async () => ({ id: 7 }), executorOverride, changed = false } = {}) {
  const calls = [], messages = [], vehicles = [], events = [];
  const hasDbChange = { value: changed };
  let scrolls = 0;
  const backend = { async requestJson(path, init) {
    calls.push({ path, init });
    events.push(init?.method ?? 'GET');
    if (path === '/api/chat') return { responses: [followup] };
    assert.match(path, /^\/api\/maps(?:\/\d+)?$/);
    if (!init?.method) return [{ id: 7, name: 'synthetic' }];
    return api(path, init);
  } };
  const parser = await execute('../src/lib/actions/parser.ts');
  const executor = await execute('../src/lib/actions/executor.ts', { '$lib/backend': backend });
  const vehicleParser = await execute('../src/lib/actions/vehicleCommandParser.ts');
  const { processChatResponse } = await execute('../src/lib/chat/chatResponseOrchestrator.ts', {
    '$lib/backend': backend,
    '$lib/actions/parser': parser,
    '$lib/actions/executor': executorOverride ?? executor,
    '$lib/actions/vehicleCommandParser': vehicleParser,
    '$lib/actions/vehicleCommandExecutor': { async executeCommandSequence(sequence) {
      events.push('vehicle');
      vehicles.push(structuredClone(sequence));
    } }
  });
  return {
    calls, messages, vehicles, events, hasDbChange, executor,
    get scrolls() { return scrolls; },
    errors: () => messages.filter(message => message.role === 'error'),
    run: (rawResponse, vehicleCommandParsingEnabled = false) => processChatResponse({
      rawResponse, userMessage: 'synthetic request', conversationId: 3, claudeModel: 'synthetic',
      vehicleCommandParsingEnabled, hasDbChange,
      appendMessage(message) { messages.push(message); }, scrollToBottom() { scrolls += 1; }
    })
  };
}

for (const branch of ['direct', 'followup']) {
  const run = (h, text) => h.run(branch === 'direct' ? text : '<read_map>');
  for (const operation of Object.keys(tags)) {
    test(`${branch} ${operation} resolved failure is visible without a DB refresh`, async () => {
      const failure = `synthetic ${operation} failure`;
      const h = await harness({ followup: tags[operation], api: async () => { throw Error(failure); } });
      await run(h, tags[operation]);
      assert.equal(h.errors().length, 1);
      assert.match(h.errors()[0].content, /액션 실행 실패/);
      assert.ok(h.errors()[0].content.includes(failure));
      assert.ok(h.errors()[0].content.includes(operation), 'identify the failed action in a partial batch');
      assert.equal(h.hasDbChange.value, false);
      assert.equal(h.calls.filter(call => call.path !== '/api/chat' && call.init?.method === method[operation]).length, 1, 'no retry');
    });
  }

  test(`${branch} partial success keeps refresh and reports every failure in execution order`, async () => {
    const text = `${tags.create}${tags.update}${tags.delete}`;
    const h = await harness({ followup: text, api: async (path, init) => {
      if (init.method !== 'PUT') throw Error(`synthetic ${init.method} failure`);
      return { id: 7, name: 'synthetic' };
    } });
    await run(h, text);
    assert.equal(h.hasDbChange.value, true);
    assert.deepEqual(h.errors().map(message => message.content.includes('POST') ? 'POST' : 'DELETE'), ['POST', 'DELETE']);
    assert.deepEqual(h.calls.filter(call => call.init?.method && call.path !== '/api/chat').map(call => call.init.method),
      ['POST', 'PUT', 'DELETE'], 'existing continue-after-failure order is preserved');
    assert.equal(h.messages.filter(message => message.role === 'action').length, branch === 'direct' ? 3 : 4);
  });

  test(`${branch} successful CUD keeps labels and refresh without error rows`, async () => {
    const text = `${tags.create}${tags.update}${tags.delete}`;
    const h = await harness({ followup: text });
    await run(h, text);
    assert.equal(h.hasDbChange.value, true);
    assert.deepEqual(h.errors(), []);
    assert.equal(h.messages.filter(message => message.role === 'action').length, branch === 'direct' ? 3 : 4);
  });

  test(`${branch} delete no-op success still refreshes under the existing ok-only API contract`, async () => {
    const h = await harness({ followup: tags.delete, api: async () => ({ ok: true }) });
    await run(h, tags.delete);
    assert.equal(h.hasDbChange.value, true, 'API does not expose affected rows');
    assert.deepEqual(h.errors(), []);
  });

  test(`${branch} successful empty result is determined by success, not result truthiness`, async () => {
    const h = await harness({ followup: tags.delete, api: async () => undefined });
    await run(h, tags.delete);
    assert.equal(h.hasDbChange.value, true);
    assert.deepEqual(h.errors(), []);
  });
}

for (const successfulBranch of ['direct', 'followup', 'neither']) {
  test(`combined batches aggregate refresh when ${successfulBranch} succeeds`, async () => {
    const h = await harness({ followup: tags.create, api: async (path, init) => {
      if ((successfulBranch === 'followup' && init.method === 'POST') ||
          (successfulBranch === 'direct' && init.method === 'PUT')) return { id: 7 };
      throw Error(`synthetic ${init.method} failure`);
    } });
    await h.run(`<read_map>${tags.update}`);
    assert.equal(h.hasDbChange.value, successfulBranch !== 'neither');
    assert.equal(h.errors().length, successfulBranch === 'neither' ? 2 : 1);
    assert.deepEqual(h.events, ['GET', 'POST', 'POST', 'PUT'], 'read, followup chat, followup CUD, direct CUD');
    const chat = h.calls.find(call => call.path === '/api/chat');
    assert.equal(chat.init.body.conversationId, 3);
    assert.match(chat.init.body.systemContext, /전체 맵: 1개/);
  });
}

test('failures do not clear an earlier refresh signal', async () => {
  const h = await harness({ changed: true, api: async () => { throw Error('synthetic failure'); } });
  await h.run(tags.create);
  assert.equal(h.hasDbChange.value, true);
  assert.equal(h.errors().length, 1);
});

test('executor resolves individual failures, keeps later actions and preserves result shape', async () => {
  const h = await harness({ api: async (path, init) => {
    if (init.method === 'POST') throw Error('synthetic create failure');
    return { ok: true };
  } });
  const actions = [
    { operation: 'create', type: 'map', data: { name: 'synthetic' } },
    { operation: 'delete', type: 'map', data: { id: 7 } }
  ];
  const results = await h.executor.executeActions(actions);
  assert.equal(results[0].success, false);
  assert.equal(results[0].error, 'synthetic create failure');
  assert.equal(results[0].action, actions[0]);
  assert.equal(results[1].success, true);
  assert.equal(results[1].result.ok, true);
  assert.equal(results[1].action, actions[1]);
  assert.deepEqual(h.events, ['POST', 'DELETE']);
});

test('pending failed CUD is reported before the existing vehicle continuation boundary', async () => {
  let reject;
  const pending = new Promise((yes, no) => { reject = no; });
  const h = await harness({ api: () => pending });
  const processing = h.run(`${tags.create}\nDM.Gas = 0.1 | 1000`, true);
  assert.equal(h.vehicles.length, 0);
  assert.equal(h.hasDbChange.value, false);
  reject(Error('synthetic deferred failure'));
  await processing;
  assert.equal(h.errors().length, 1);
  assert.equal(h.hasDbChange.value, false);
  assert.deepEqual(h.events, ['POST', 'vehicle'], 'no new stop/continue policy is introduced');
  assert.equal(h.vehicles[0].items[0].variable, 'DM.Gas');
  assert.equal(h.vehicles[0].items[0].value, 0.1);
  assert.equal(h.messages.at(-1).label, '🚗 차량 제어 명령 실행');
});

test('unexpected executor rejection still uses the existing error path', async () => {
  const h = await harness({ executorOverride: { async executeActions() { throw Error('synthetic rejection'); } } });
  await h.run(tags.create);
  assert.match(h.errors()[0].content, /액션 실행 실패: synthetic rejection/);
  assert.equal(h.hasDbChange.value, false);
});

test('text and read-only followup responses do not request a DB refresh', async () => {
  const h = await harness({ followup: 'synthetic read answer' });
  await h.run('synthetic text');
  assert.equal(h.calls.length, 0);
  await h.run('<read_map>');
  assert.equal(h.hasDbChange.value, false);
  assert.deepEqual(h.errors(), []);
  assert.equal(h.messages.at(-1).content, 'synthetic read answer');
  assert.ok(h.scrolls > 0);
});
