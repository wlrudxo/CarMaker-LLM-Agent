// Execute the checked-in TypeScript with stub API/store imports; no browser or app process.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function load(relative, imports) {
  let source = ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  for (const [name, body] of Object.entries(imports)) {
    const url = `data:text/javascript;base64,${Buffer.from(body).toString('base64')}`;
    source = source.replaceAll(`from '${name}'`, `from '${url}'`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

globalThis.$state = value => value;
globalThis.window = { setInterval, clearInterval };
const requests = [];
let request = async () => {};
globalThis.__api = (...args) => { requests.push(args); return request(...args); };
const backend = 'export const requestJson = (...args) => globalThis.__api(...args);';
const { carmakerStore } = await load('../src/lib/stores/carmakerStore.svelte.ts', {
  '$lib/backend': backend, './toastStore.svelte': 'export const toastStore = {error(){},success(){}};'
});
globalThis.__car = carmakerStore;
const { executeCommandSequence } = await load('../src/lib/actions/vehicleCommandExecutor.ts', {
  '$lib/stores/carmakerStore.svelte': 'export const carmakerStore = globalThis.__car;'
});
const command = { variable: 'DM.Gas', value: 1, duration: 1000, mode: 'Abs' };
const sequence = (...items) => ({ items });

test('first DVA failure stops simulation and prevents later control', async () => {
  requests.length = 0;
  request = async (path, init) => {
    if (init?.body?.command?.startsWith('DVAWrite')) throw Error('fake DVA error');
    return 'O';
  };
  await assert.rejects(executeCommandSequence(sequence(command, command)), /fake DVA error/);
  assert.equal(requests.filter(([, init]) => init?.body?.command?.startsWith('DVAWrite')).length, 1);
  assert.ok(requests.some(([path]) => path === '/api/carmaker/reset-control'));
});

test('wait timeout prevents following DVA', async () => {
  requests.length = 0;
  carmakerStore.monitorData = {};
  request = async () => ({ rawData: { 'Car.v': 5 } });
  await assert.rejects(executeCommandSequence(sequence(
    {type:'wait_until', condition:'Car.v < 1', timeout:1}, command)), /Timeout/);
  assert.ok(!requests.some(([, init]) => init?.body?.command?.startsWith('DVAWrite')));
});

test('failed fresh read cannot use an old successful telemetry cache', async () => {
  requests.length = 0;
  carmakerStore.monitorData = {'Car.v': 0};
  request = async () => { throw Error('telemetry offline'); };
  await assert.rejects(executeCommandSequence(sequence(
    {type:'wait_until', condition:'Car.v < 1', timeout:20}, command)), /telemetry offline/);
  assert.deepEqual(carmakerStore.monitorData, {});
});

test('a fresh response arriving after wait deadline cannot satisfy the condition', async () => {
  requests.length = 0;
  request = async path => {
    if (path.endsWith('/reset-control')) return {connected:true,commandsSucceeded:5};
    await new Promise(resolve => setTimeout(resolve, 10));
    return {rawData:{'Car.v':0}};
  };
  await assert.rejects(executeCommandSequence(sequence(
    {type:'wait_until', condition:'Car.v < 1', timeout:1}, command)), /Timeout/);
  assert.ok(!requests.some(([, init]) => init?.body?.command?.startsWith('DVAWrite')));
});

test('nonfinite wait data fails closed and reset failure is visible', async () => {
  request = async path => {
    if (path.endsWith('/reset-control')) throw Error('stop unconfirmed');
    return {rawData: {'Car.v': Infinity}};
  };
  await assert.rejects(executeCommandSequence(sequence(
    {type:'wait_until', condition:'Car.v > 1', timeout:1}, command)), /stop unconfirmed/);
});

test('conversation restore preserves camelCase timestamp', async () => {
  const { fetchConversation } = await load('../src/lib/chat/chatConversation.ts', {
    '$lib/backend': backend,
    '$lib/actions/parser': 'export const parseWithSegments = text => [{type:"text",content:text}];'
  });
  request = async path => path.includes('/messages')
    ? [{role:'assistant', content:'fake', createdAt:'2026-01-02T03:04:05Z'}]
    : {promptTemplateId:1, title:'offline'};
  const result = await fetchConversation(3);
  assert.equal(result.messages[0].timestamp.toISOString(), '2026-01-02T03:04:05.000Z');
});

test('vehicle execution error reaches the existing chat error row', async () => {
  globalThis.__execute = executeCommandSequence;
  const { processChatResponse } = await load('../src/lib/chat/chatResponseOrchestrator.ts', {
    '$lib/backend': backend,
    '$lib/actions/parser': 'export const parseActions = () => []; export const parseWithSegments = () => [];',
    '$lib/actions/executor': 'export const executeActions = async () => [];',
    '$lib/actions/vehicleCommandParser': `export const parseVehicleCommands = () => (${JSON.stringify(sequence(command, command))});`,
    '$lib/actions/vehicleCommandExecutor': 'export const executeCommandSequence = (...args) => globalThis.__execute(...args);'
  });
  request = async (path, init) => {
    if (init?.body?.command?.startsWith('DVAWrite')) throw Error('visible DVA failure');
    return {connected:true,commandsSucceeded:5};
  };
  const messages = [];
  await processChatResponse({rawResponse:'fake', userMessage:'test', conversationId:1,
    claudeModel:'fake', vehicleCommandParsingEnabled:true, appendMessage:message=>messages.push(message),
    scrollToBottom(){}, hasDbChange:{value:false}});
  assert.match(messages.find(message => message.role === 'error').content, /visible DVA failure/);
});

test('polling survives long execution, drains stop events, and then stops', async () => {
  const events = [];
  globalThis.__events = events;
  let runtime = {monitoringActive:true, isExecuting:true};
  let queuedEvents = [];
  request = async (path, init) => {
    if (path.endsWith('/runtime-status')) return runtime;
    if (path === '/api/triggers') return [];
    if (path.endsWith('/logs')) return [];
    if (path.includes('/events')) return queuedEvents;
    if (path === '/api/carmaker/monitoring') return false;
    if (path === '/api/triggers/monitoring') return init.body.active;
    throw Error(`Unexpected fake request: ${path}`);
  };
  const { triggerMonitor } = await load('../src/lib/stores/triggerMonitor.svelte.ts', {
    '$lib/backend': backend,
    '$lib/stores/carmakerStore.svelte': 'export const carmakerStore = globalThis.__car;',
    '$lib/stores/chatBus': 'export const chatBus = {pushTriggerEvent:event=>globalThis.__events.push(event)};'
  });
  try {
    await triggerMonitor.startMonitoring();
    queuedEvents = [{id:1,type:'system',triggerName:'fake',content:'waiting'}];
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(triggerMonitor.isMonitoring, true);
    assert.ok(triggerMonitor.pollInterval !== null);
    assert.equal(events.length, 1);
    runtime = {monitoringActive:false, isExecuting:true};
    await triggerMonitor.stopMonitoring();
    await triggerMonitor.pollRuntimeState();
    assert.ok(triggerMonitor.pollInterval !== null);
    runtime = {monitoringActive:false, isExecuting:false};
    queuedEvents = [{id:2,type:'error',triggerName:'fake',content:'cancelled; StopSim confirmed'}];
    await triggerMonitor.pollRuntimeState();
    assert.equal(triggerMonitor.pollInterval, null);
    assert.match(events.at(-1).content, /cancelled/);
  } finally {
    triggerMonitor.stopPolling();
  }
});

test('telemetry response in flight cannot repopulate cache after stop', async () => {
  carmakerStore.isMonitoring = false;
  let resolveRead;
  request = () => new Promise(resolve => { resolveRead = resolve; });
  const reading = carmakerStore.readFreshTelemetry();
  carmakerStore.syncMonitoringStateFromBackend(false);
  resolveRead({rawData:{'Car.v':0}});
  await assert.rejects(reading, /invalidated/);
  assert.deepEqual(carmakerStore.monitorData, {});
});

test('pause waits for backend monitoring stop before sending control', async () => {
  requests.length = 0;
  carmakerStore.isMonitoring = true;
  let confirmStop;
  request = async path => path.endsWith('/monitoring')
    ? new Promise(resolve => { confirmStop = resolve; }) : 'O';
  const pausing = carmakerStore.pauseSimulation();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, 'control was sent before monitoring stop completed');
  } finally {
    confirmStop(false);
    await pausing;
  }
  assert.equal(requests[1][1].body.command, 'DVAWrite SC.TAccel 0.0001 30000 Abs');
});

test('failed monitoring stop prevents pause control and can be retried', async () => {
  requests.length = 0;
  carmakerStore.isMonitoring = true;
  request = async path => {
    if (path.endsWith('/monitoring')) throw Error('monitoring stop offline');
    return 'O';
  };
  await assert.rejects(carmakerStore.pauseSimulation(), /monitoring stop offline/);
  assert.equal(requests.length, 1);
  assert.equal(carmakerStore.isMonitoring, true);
  assert.deepEqual(carmakerStore.monitorData, {});
  assert.ok(carmakerStore.logMessages.some(line => line.includes('Failed to stop monitoring')));
  request = async () => false;
  await carmakerStore.stopMonitoring();
  assert.equal(requests.at(-1)[1].body.active, false);
});

test('lost trigger start response is reconciled and retry does not skip pending events', async () => {
  const events = [];
  globalThis.__retryEvents = events;
  let runtime = {monitoringActive:false, isExecuting:false};
  let queuedEvents = [{id:10,type:'error',triggerName:'previous',content:'before page load'}];
  let loseResponse = true;
  request = async (path, init) => {
    if (path.endsWith('/runtime-status')) return runtime;
    if (path === '/api/triggers' || path.endsWith('/logs')) return [];
    if (path.includes('/events')) {
      const cursor = Number(path.split('since_id=')[1]);
      return queuedEvents.filter(event => event.id > cursor);
    }
    if (path === '/api/carmaker/monitoring') return false;
    if (path === '/api/triggers/monitoring') {
      runtime = {monitoringActive:init.body.active, isExecuting:false};
      if (loseResponse) throw Error('start response lost');
      return runtime.monitoringActive;
    }
    throw Error(`Unexpected request: ${path}`);
  };
  const { triggerMonitor } = await load('../src/lib/stores/triggerMonitor.svelte.ts', {
    '$lib/backend': backend,
    '$lib/stores/carmakerStore.svelte': 'export const carmakerStore = globalThis.__car;',
    '$lib/stores/chatBus': 'export const chatBus = {pushTriggerEvent:event=>globalThis.__retryEvents.push(event)};'
  });
  try {
    await triggerMonitor.startMonitoring();
    assert.notEqual(triggerMonitor.pollInterval, null, 'lost response left active backend without polling');
    await triggerMonitor.pollRuntimeState();
    assert.equal(triggerMonitor.isMonitoring, true);
    assert.equal(events.length, 0, 'historical events should remain live-only');
    runtime = {monitoringActive:false, isExecuting:false};
    await triggerMonitor.pollRuntimeState();
    queuedEvents.push({id:11,type:'error',triggerName:'current',content:'pending cancellation'});
    loseResponse = false;
    await triggerMonitor.startMonitoring();
    await triggerMonitor.pollRuntimeState();
    assert.deepEqual(events.map(event => event.content), ['pending cancellation']);
  } finally {
    triggerMonitor.stopPolling();
  }
});
