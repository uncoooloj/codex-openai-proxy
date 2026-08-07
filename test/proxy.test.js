import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import OpenAI from 'openai';
import { CodexAppServer } from '../dist/app-server.js';
import {
  ChatRole,
  CodexNotification,
  CodexRpcMethod,
  CodexTurnStatus,
} from '../dist/constants.js';
import { parseConfig } from '../dist/config.js';
import { createProxyServer } from '../dist/server.js';

const TEST_MODEL = 'codex-test';
const TEST_TOKEN = 'test-token-that-is-long-enough-123456';
const JSON_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN}`,
  'content-type': 'application/json',
};

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

class FakeBackend {
  active = 0;
  maxActive = 0;
  aborted = 0;

  ready() {
    return true;
  }

  async listModels() {
    return [{ id: TEST_MODEL, ownedBy: 'codex-local' }];
  }

  async complete(request, { onDelta, signal }) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      if (request.messages[0]?.content === 'hold') {
        await this.waitUntilAbortedOrReleased(signal);
      }

      onDelta?.('hello');
      onDelta?.(' world');
      return { text: 'hello world', model: request.model };
    } finally {
      this.active -= 1;
    }
  }

  async close() {}

  waitUntilAbortedOrReleased(signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.aborted += 1;
        reject(signal.reason);
      }, { once: true });
    });
  }
}

class FakeTransport {
  notificationHandlers = [];
  serverRequestHandlers = [];
  calls = [];

  request(method, params) {
    this.calls.push({ method, params });

    switch (method) {
      case CodexRpcMethod.Initialize:
        return Promise.resolve({ userAgent: 'fake' });
      case CodexRpcMethod.ListModels:
        return Promise.resolve({
          data: [{ id: 'model-id', model: TEST_MODEL }],
        });
      case CodexRpcMethod.StartThread:
        return Promise.resolve({
          thread: { id: 'thread-1' },
          model: TEST_MODEL,
        });
      case CodexRpcMethod.StartTurn:
        return Promise.resolve({ turn: { id: 'turn-1' } });
      case CodexRpcMethod.InterruptTurn:
        queueMicrotask(() => this.emit({
          method: CodexNotification.TurnCompleted,
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              status: CodexTurnStatus.Interrupted,
            },
          },
        }));
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(method, params) {
    this.calls.push({ method, params });
  }

  respondError(id, code, message) {
    this.calls.push({
      method: 'respondError',
      params: { id, code, message },
    });
  }

  onNotification(handler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers
        .filter((candidate) => candidate !== handler);
    };
  }

  onServerRequest(handler) {
    this.serverRequestHandlers.push(handler);
    return () => {};
  }

  emit(message) {
    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  alive() {
    return true;
  }

  async close() {}
}

async function createFixture(overrides = {}) {
  const backend = new FakeBackend();
  const server = createProxyServer(backend, {
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    bodyLimit: 1024,
    timeoutMs: 1_000,
    maxConcurrency: 1,
    logger: silentLogger,
    ...overrides,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  return {
    backend,
    server,
    baseURL,
    client: new OpenAI({ apiKey: TEST_TOKEN, baseURL }),
  };
}

function chatBody(content, extraFields = {}) {
  return {
    model: TEST_MODEL,
    messages: [{ role: ChatRole.User, content }],
    ...extraFields,
  };
}

function postChat(baseURL, content, extraFields = {}) {
  return fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(chatBody(content, extraFields)),
  });
}

function transportCalled(transport, method) {
  return transport.calls.some((call) => call.method === method);
}

test('official OpenAI client lists models and completes a chat', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.server.close());

  const models = await fixture.client.models.list();
  assert.equal(models.data[0].id, TEST_MODEL);

  const result = await fixture.client.chat.completions.create(
    chatBody('hi'),
  );
  assert.equal(result.choices[0].message.content, 'hello world');
  assert.equal(result.usage, undefined);
});

test('rejects unauthorized and unsupported requests', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.server.close());

  const unauthorized = await fetch(`${fixture.baseURL}/models`);
  assert.equal(unauthorized.status, 401);

  await assert.rejects(
    () => fixture.client.chat.completions.create(chatBody('hi', {
      temperature: 0.2,
    })),
    /temperature is not supported/,
  );

  const audio = await postChat(fixture.baseURL, 'hi', {
    modalities: ['audio'],
  });
  assert.equal(audio.status, 400);
});

test('releases the concurrency slot after body parsing fails', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.server.close());

  const malformed = await fetch(`${fixture.baseURL}/chat/completions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{',
  });
  assert.equal(malformed.status, 400);

  const result = await fixture.client.chat.completions.create(chatBody('hi'));
  assert.equal(result.choices[0].message.content, 'hello world');
});

test('reserves concurrency while a request body is still arriving', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.server.close());

  const slowRequest = httpRequest(`${fixture.baseURL}/chat/completions`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
  slowRequest.on('error', () => {});
  slowRequest.write(`{"model":"${TEST_MODEL}"`);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const secondRequest = await postChat(fixture.baseURL, 'hi');
  assert.equal(secondRequest.status, 429);
  slowRequest.destroy();
});

test('official client consumes SSE streaming chunks', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.server.close());

  const stream = await fixture.client.chat.completions.create(
    chatBody('hi', { stream: true }),
  );
  let text = '';
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content ?? '';
  }

  assert.equal(text, 'hello world');
});

test('times out, aborts backend work, and enforces concurrency', async (t) => {
  const fixture = await createFixture({ timeoutMs: 30 });
  t.after(() => fixture.server.close());

  const firstRequest = postChat(fixture.baseURL, 'hold');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondRequest = await postChat(fixture.baseURL, 'hi');

  assert.equal(secondRequest.status, 429);
  assert.equal((await firstRequest).status, 504);
  assert.equal(fixture.backend.aborted, 1);
  assert.equal(fixture.backend.maxActive, 1);
});

test('client cancellation translates to turn/interrupt', async () => {
  const transport = new FakeTransport();
  const backend = new CodexAppServer({ transport, logger: silentLogger });
  await backend.initialize();

  const controller = new AbortController();
  const pending = backend.complete(chatBody('hold'), {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error('cancel'));

  await assert.rejects(pending, /interrupted/);
  assert.ok(transportCalled(transport, CodexRpcMethod.InterruptTurn));
  await backend.close();
});

test('server-initiated tool requests fail closed', async () => {
  const transport = new FakeTransport();
  const backend = new CodexAppServer({ transport, logger: silentLogger });
  await backend.initialize();

  const pending = backend.complete(chatBody('do not use tools'), {
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  transport.serverRequestHandlers[0]({
    id: 77,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  });

  await assert.rejects(pending, /disabled tool or approval request/);
  assert.ok(transportCalled(transport, 'respondError'));
  assert.ok(transportCalled(transport, CodexRpcMethod.InterruptTurn));
  await backend.close();
});

test('configuration refuses non-loopback hosts and short tokens', () => {
  assert.throws(
    () => parseConfig({ args: [], env: { CODEX_PROXY_HOST: '0.0.0.0' } }),
    /non-loopback/,
  );
  assert.throws(
    () => parseConfig({ args: [], env: { CODEX_PROXY_TOKEN: 'short' } }),
    /at least 24/,
  );
});
