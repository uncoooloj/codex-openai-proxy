import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { CodexAppServer } from '../dist/app-server.js';
import { CodexNotification, CodexRpcMethod } from '../dist/constants.js';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'dist', 'cli.js');
const PRIVATE_TOKEN = 'configured-token-that-must-not-appear-in-output';

test('CLI bounds startup failures and timeouts without exposing backend errors', async (t) => {
  const fixture = await createFixture(t);

  const failed = startProxy(fixture, 'startup-error', await unusedPort(), 300);
  const failedResult = await processResult(failed);
  assert.equal(failedResult.code, 1);
  assert.match(failedResult.stderr, /proxy_failed/);
  assert.doesNotMatch(failedResult.stderr, /mock startup failure/);

  const timedOut = startProxy(fixture, 'startup-timeout', await unusedPort(), 150);
  const started = Date.now();
  const timedOutResult = await processResult(timedOut);
  assert.equal(timedOutResult.code, 1);
  assert.ok(Date.now() - started < 2_000);

  const stubbornVersion = startProxy(fixture, 'version-stubborn', await unusedPort(), 10_000);
  await waitFor(() => existsSync(fixture.versionMarker), 1_000);
  const shutdownStarted = Date.now();
  stubbornVersion.kill('SIGTERM');
  const shutdown = await processResult(stubbornVersion);
  assert.equal(shutdown.code, 0);
  assert.ok(Date.now() - shutdownStarted < 3_000);
});

test('CLI drains on SIGTERM, does not print configured tokens, and exits on backend death', async (t) => {
  const fixture = await createFixture(t);
  const port = await unusedPort();
  const proxy = startProxy(fixture, 'hold-turn', port, 1_000);
  const output = await waitForOutput(proxy, /ready at/);
  assert.doesNotMatch(output, new RegExp(PRIVATE_TOKEN));

  const request = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${PRIVATE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hold' }],
    }),
  });
  void request.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  proxy.kill('SIGTERM');
  const stopped = await processResult(proxy);
  assert.equal(stopped.code, 0);
  await assert.rejects(request);

  const dying = startProxy(fixture, 'backend-death', await unusedPort(), 1_000);
  const diedResult = processResult(dying);
  await waitForOutput(dying, /ready at/);
  await writeFile(fixture.backendDeathMarker, 'stop');
  const died = await diedResult;
  assert.equal(died.code, 1);
});

test('unacknowledged turn interruption closes the backend after a bounded deadline', async () => {
  const transport = new UnacknowledgedInterruptTransport();
  await assertInterruptedBackendCloses(transport);
});

test('acknowledged interruption without a terminal turn also closes the backend', async () => {
  const transport = new UnacknowledgedInterruptTransport(true);
  await assertInterruptedBackendCloses(transport);
});

test('terminal turn completion clears an acknowledged interruption', async (t) => {
  const transport = new UnacknowledgedInterruptTransport(true, true);
  const backend = new CodexAppServer({ transport });
  t.after(() => backend.close());
  await backend.initialize();

  const controller = new AbortController();
  const completion = backend.complete({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'cancel me' }],
  }, { signal: controller.signal });
  await waitFor(() => transport.turnStarted);
  controller.abort();
  await assert.rejects(completion, /interrupted/);
  await waitFor(() => backend.ready());
  assert.equal(transport.closeCalls, 0);
});

async function assertInterruptedBackendCloses(transport) {
  const backend = new CodexAppServer({ transport });
  let failures = 0;
  backend.onFailure(() => { failures += 1; });
  await backend.initialize();

  const controller = new AbortController();
  const completion = backend.complete({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'cancel me' }],
  }, { signal: controller.signal });
  await waitFor(() => transport.turnStarted);
  controller.abort();

  await assert.rejects(completion, /interrupted/);
  assert.equal(transport.interruptCalls, 1);
  assert.equal(backend.ready(), false);
  await waitFor(() => transport.closeCalls === 1, 3_000);
  assert.equal(transport.closeCalls, 1);
  assert.equal(backend.ready(), false);
  assert.equal(failures, 1);
}

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-proxy-lifecycle-'));
  const home = join(directory, 'home');
  const bin = join(directory, 'mock-codex.mjs');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'auth.json'), '{}');
  await writeFile(bin, MOCK_CODEX);
  await chmod(bin, 0o755);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return {
    home,
    bin,
    versionMarker: join(directory, 'version-check-started'),
    backendDeathMarker: join(directory, 'backend-death'),
  };
}

function startProxy(fixture, mode, port, startupTimeoutMs) {
  return spawn(process.execPath, [CLI, '--port', String(port), '--startup-timeout', String(startupTimeoutMs)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_HOME: fixture.home,
      CODEX_PROXY_CODEX_BIN: fixture.bin,
      CODEX_PROXY_TOKEN: PRIVATE_TOKEN,
      MOCK_MODE: mode,
      MOCK_VERSION_MARKER: fixture.versionMarker,
      MOCK_BACKEND_DEATH_MARKER: fixture.backendDeathMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error('process output deadline exceeded'));
    }, 10_000);
    let output = '';
    const read = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    const close = () => {
      cleanup();
      reject(new Error(`process ended before matching ${pattern}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', read);
      child.stderr.off('data', read);
      child.off('close', close);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('close', close);
  });
}

function processResult(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

async function waitFor(condition, timeoutMs = 500) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started >= timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class UnacknowledgedInterruptTransport {
  turnStarted = false;
  interruptCalls = 0;
  closeCalls = 0;
  notificationHandlers = new Set();

  constructor(acknowledgeInterrupt = false, completeTurn = false) {
    this.acknowledgeInterrupt = acknowledgeInterrupt;
    this.completeTurn = completeTurn;
  }

  request(method) {
    switch (method) {
      case CodexRpcMethod.Initialize:
        return Promise.resolve({});
      case CodexRpcMethod.ListModels:
        return Promise.resolve({ data: [{ id: 'mock-model' }] });
      case CodexRpcMethod.StartThread:
        return Promise.resolve({ thread: { id: 'thread-1' } });
      case CodexRpcMethod.StartTurn:
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: 'turn-1' } });
      case CodexRpcMethod.InterruptTurn:
        this.interruptCalls += 1;
        if (this.completeTurn) queueMicrotask(() => this.emit({
          method: CodexNotification.TurnCompleted,
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        }));
        return this.acknowledgeInterrupt ? Promise.resolve({}) : new Promise(() => {});
      default:
        return Promise.resolve({});
    }
  }

  notify() {}
  respondError() {}
  respondResult() {}
  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => { this.notificationHandlers.delete(handler); };
  }
  onServerRequest() { return () => {}; }
  async close() { this.closeCalls += 1; }
  alive() { return this.closeCalls === 0; }
  emit(message) {
    for (const handler of this.notificationHandlers) handler(message);
  }
}

const MOCK_CODEX = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') {
  if (process.env.MOCK_MODE === 'version-stubborn') {
    process.on('SIGTERM', () => {});
    writeFileSync(process.env.MOCK_VERSION_MARKER, 'started');
    setInterval(() => {}, 1_000);
  } else {
    console.log('codex-cli 0.146.0');
    process.exit(0);
  }
}
const mode = process.env.MOCK_MODE;
if (mode === 'startup-timeout') setInterval(() => {}, 1_000);
const readline = createInterface({ input: process.stdin });
readline.on('line', (line) => {
  if (mode === 'startup-timeout') return;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (mode === 'startup-error') {
      console.log(JSON.stringify({ id: request.id, error: { message: 'mock startup failure secret' } }));
      return;
    }
    console.log(JSON.stringify({ id: request.id, result: {} }));
    return;
  }
  if (request.method === 'model/list') {
    console.log(JSON.stringify({ id: request.id, result: { data: [{ id: 'mock-model' }] } }));
    if (mode === 'backend-death') setInterval(() => {
      if (existsSync(process.env.MOCK_BACKEND_DEATH_MARKER)) process.exit(7);
    }, 10);
    return;
  }
  if (request.method === 'thread/start') {
    console.log(JSON.stringify({ id: request.id, result: { thread: { id: 'mock-thread' }, model: 'mock-model' } }));
    return;
  }
  if (request.method === 'turn/start') {
    console.log(JSON.stringify({ id: request.id, result: { turn: { id: 'mock-turn' } } }));
    return;
  }
  console.log(JSON.stringify({ id: request.id, result: {} }));
});
`;
