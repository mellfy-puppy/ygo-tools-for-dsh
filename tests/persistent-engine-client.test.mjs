import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createPersistentEngineClient } from '../skill/backend/persistent-engine-client.mjs';
import { ENGINE_HOST_PROTOCOL } from '../skill/backend/persistent-engine-server.mjs';

const healthy = { ok: true, protocol: ENGINE_HOST_PROTOCOL };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function send(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function serve(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return {
    server,
    requests,
    client: (options = {}) => createPersistentEngineClient({ hostname: '127.0.0.1', port: server.address().port, ...options }),
  };
}

function interceptSpawn(t, implementation = () => { throw new Error('Unexpected host spawn'); }) {
  const spawn = t.mock.method(childProcess, 'spawn', implementation);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  return spawn;
}

test('uses an existing healthy host and forwards the caller session', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  let received;
  const fixture = await serve(t, (request, response) => {
    if (request.url === '/health') return send(response, healthy);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { received = JSON.parse(body); send(response, { ok: true, value: 42 }); });
  });
  const controller = new AbortController();
  const call = { name: 'ygo_test', arguments: { card: 123 } };
  assert.deepEqual(await fixture.client().execute(call, { sessionId: 'caller-17', signal: controller.signal, timeoutMs: 1000 }), { ok: true, value: 42 });
  assert.deepEqual(received, { call, sessionId: 'caller-17' });
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-aborted execution neither probes HTTP nor spawns a detached host', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  const fixture = await serve(t, (_request, response) => send(response, healthy));
  const controller = new AbortController();
  const reason = new Error('cancelled before start');
  controller.abort(reason);
  await assert.rejects(fixture.client().execute({}, { signal: controller.signal }), (error) => error === reason);
  assert.equal(fixture.requests.length, 0);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling an in-flight health probe cannot trigger autostart', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  const probing = deferred();
  const fixture = await serve(t, () => probing.resolve());
  const controller = new AbortController();
  const execution = fixture.client().execute({}, { signal: controller.signal });
  const rejected = assert.rejects(execution, { name: 'AbortError' });
  await probing.promise;
  controller.abort();
  await rejected;
  assert.deepEqual(fixture.requests, ['/health']);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling a streamed execution response closes that request and preserves the shared host', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  const streaming = deferred();
  const closed = deferred();
  let executions = 0;
  const fixture = await serve(t, (request, response) => {
    if (request.url === '/health') return send(response, healthy);
    if (++executions > 1) return send(response, { ok: true, otherSession: true });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    response.once('close', () => closed.resolve());
    streaming.resolve();
  });
  const controller = new AbortController();
  const client = fixture.client();
  const rejected = assert.rejects(client.execute({}, { signal: controller.signal, sessionId: 'cancelled' }), { name: 'AbortError' });
  await streaming.promise;
  controller.abort();
  await rejected;
  await closed.promise;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(await client.execute({}, { sessionId: 'other-session' }), { ok: true, otherSession: true });
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(fixture.requests, ['/health', '/execute', '/health', '/execute']);
  assert.equal(fixture.server.listening, true);
});

test('caller timeout bounds slow execution and releases its abort listener', { timeout: 5000 }, async (t) => {
  interceptSpawn(t);
  const fixture = await serve(t, (request, response) => {
    if (request.url === '/health') send(response, healthy);
  });
  const controller = new AbortController();
  const started = performance.now();
  await assert.rejects(fixture.client().execute({}, { timeoutMs: 100, signal: controller.signal }), { name: 'TimeoutError' });
  assert.ok(performance.now() - started < 1500, 'caller timeout must replace the 120-second default');
  assert.deepEqual(fixture.requests, ['/health', '/execute']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('caller timeout also bounds the health probe without spawning', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  const fixture = await serve(t, () => {});
  await assert.rejects(fixture.client().execute({}, { timeoutMs: 60 }), { name: 'TimeoutError' });
  assert.deepEqual(fixture.requests, ['/health']);
  assert.equal(spawn.mock.callCount(), 0);
});

test('protocol mismatch fails without spawning or posting execution', { timeout: 5000 }, async (t) => {
  const spawn = interceptSpawn(t);
  const fixture = await serve(t, (_request, response) => send(response, { ok: true, protocol: 'unrelated-service' }));
  await assert.rejects(fixture.client().execute({}), /incompatible service/);
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(fixture.requests, ['/health']);
});

test('cancellation while waiting for spawn leaves the detached child alone', { timeout: 5000 }, async (t) => {
  const spawned = deferred();
  const child = new EventEmitter();
  child.unref = t.mock.fn();
  child.kill = t.mock.fn();
  interceptSpawn(t, (_executable, _args, options) => {
    assert.equal(options.detached, true);
    spawned.resolve();
    return child;
  });
  const fixture = await serve(t, (_request, response) => send(response, { ...healthy, ok: false, error: 'starting' }));
  const controller = new AbortController();
  const rejected = assert.rejects(fixture.client().execute({}, { signal: controller.signal }), { name: 'AbortError' });
  await spawned.promise;
  controller.abort();
  await rejected;
  child.emit('spawn');
  assert.equal(child.kill.mock.callCount(), 0);
  assert.equal(child.unref.mock.callCount(), 1);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.deepEqual(fixture.requests, ['/health']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation interrupts the readiness polling delay and cleans up listeners', { timeout: 5000 }, async (t) => {
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = t.mock.fn();
  const spawn = interceptSpawn(t, () => { queueMicrotask(() => child.emit('spawn')); return child; });
  const polling = deferred();
  let probes = 0;
  const fixture = await serve(t, (_request, response) => {
    send(response, { ...healthy, ok: false, error: 'not ready yet' });
    if (++probes === 2) polling.resolve();
  });
  const controller = new AbortController();
  const rejected = assert.rejects(fixture.client().execute({}, { signal: controller.signal }), { name: 'AbortError' });
  await polling.promise;
  await sleep(10);
  controller.abort();
  await rejected;
  const probesAtAbort = probes;
  await sleep(100);
  assert.equal(probes, probesAtAbort, 'no background readiness polling after cancellation');
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.ok(fixture.requests.every((path) => path === '/health'));
});

test('caller timeout includes readiness waiting and keeps the detached child running', { timeout: 5000 }, async (t) => {
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = t.mock.fn();
  const spawn = interceptSpawn(t, () => { queueMicrotask(() => child.emit('spawn')); return child; });
  const fixture = await serve(t, (_request, response) => send(response, { ...healthy, ok: false, error: 'still starting' }));
  const controller = new AbortController();
  await assert.rejects(fixture.client({ startupTimeoutMs: 15000 }).execute({}, {
    timeoutMs: 100,
    signal: controller.signal,
  }), { name: 'TimeoutError' });
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 0);
  assert.ok(fixture.requests.every((path) => path === '/health'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('readiness rejects a later protocol mismatch without another spawn', { timeout: 5000 }, async (t) => {
  const child = new EventEmitter();
  child.unref = () => {};
  const spawn = interceptSpawn(t, () => { queueMicrotask(() => child.emit('spawn')); return child; });
  let probes = 0;
  const fixture = await serve(t, (_request, response) => {
    send(response, ++probes === 1 ? { ...healthy, ok: false } : { ok: true, protocol: 'wrong-host' });
  });
  await assert.rejects(fixture.client().execute({}), /incompatible service/);
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(fixture.requests, ['/health', '/health']);
});
