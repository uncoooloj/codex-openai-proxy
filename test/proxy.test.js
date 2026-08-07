import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import OpenAI from 'openai';
import { CodexAppServer } from '../dist/app-server.js';
import { parseConfig } from '../dist/config.js';
import { createProxyServer } from '../dist/server.js';

const silent = { info() {}, warn() {}, error() {} };
const token = 'test-token-that-is-long-enough-123456';

class FakeBackend {
  active = 0;
  maxActive = 0;
  aborted = 0;
  ready() { return true; }
  async listModels() { return [{ id: 'codex-test', ownedBy: 'codex-local' }]; }
  async complete(request, { onDelta, signal }) {
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (request.messages[0]?.content === 'hold') await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        signal.addEventListener('abort', () => { clearTimeout(timer); this.aborted += 1; reject(signal.reason); }, { once: true });
      });
      onDelta?.('hello'); onDelta?.(' world');
      return { text: 'hello world', model: request.model };
    } finally { this.active -= 1; }
  }
  async close() {}
}

async function fixture(overrides = {}) {
  const backend = new FakeBackend();
  const server = createProxyServer(backend, { host: '127.0.0.1', port: 0, token, bodyLimit: 1024, timeoutMs: 1000, maxConcurrency: 1, logger: silent, ...overrides });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  return { backend, server, baseURL, client: new OpenAI({ apiKey: token, baseURL }) };
}

test('official OpenAI client lists models and completes a chat', async (t) => {
  const fx = await fixture(); t.after(() => fx.server.close());
  const models = await fx.client.models.list();
  assert.equal(models.data[0].id, 'codex-test');
  const result = await fx.client.chat.completions.create({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.choices[0].message.content, 'hello world');
  assert.equal(result.usage, undefined);
});

test('rejects unauthorized and unsupported requests', async (t) => {
  const fx = await fixture(); t.after(() => fx.server.close());
  const unauthorized = await fetch(`${fx.baseURL}/models`);
  assert.equal(unauthorized.status, 401);
  await assert.rejects(() => fx.client.chat.completions.create({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }), /temperature is not supported/);
  const audio = await fetch(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }], modalities: ['audio'] }) });
  assert.equal(audio.status, 400);
});

test('releases the concurrency slot after body parsing fails', async (t) => {
  const fx = await fixture(); t.after(() => fx.server.close());
  const malformed = await fetch(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const result = await fx.client.chat.completions.create({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.choices[0].message.content, 'hello world');
});

test('reserves concurrency while a request body is still arriving', async (t) => {
  const fx = await fixture(); t.after(() => fx.server.close());
  const slow = httpRequest(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  slow.on('error', () => {});
  slow.write('{"model":"codex-test"');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await fetch(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(second.status, 429);
  slow.destroy();
});

test('official client consumes SSE streaming chunks', async (t) => {
  const fx = await fixture(); t.after(() => fx.server.close());
  const stream = await fx.client.chat.completions.create({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }], stream: true });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
  assert.equal(text, 'hello world');
});

test('times out, aborts backend work, and enforces concurrency without cross-talk', async (t) => {
  const fx = await fixture({ timeoutMs: 30 }); t.after(() => fx.server.close());
  const first = fetch(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex-test', messages: [{ role: 'user', content: 'hold' }] }) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await fetch(`${fx.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex-test', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(second.status, 429);
  assert.equal((await first).status, 504);
  assert.equal(fx.backend.aborted, 1);
  assert.equal(fx.backend.maxActive, 1);
});

class FakeTransport {
  handlers = [];
  serverHandlers = [];
  calls = [];
  request(method, params) {
    this.calls.push({ method, params });
    if (method === 'initialize') return Promise.resolve({ userAgent: 'fake' });
    if (method === 'model/list') return Promise.resolve({ data: [{ id: 'm', model: 'codex-test' }] });
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' }, model: 'codex-test' });
    if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } });
    if (method === 'turn/interrupt') { queueMicrotask(() => this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } })); return Promise.resolve({}); }
    return Promise.resolve({});
  }
  notify(method, params) { this.calls.push({ method, params }); }
  respondError(id, code, message) { this.calls.push({ method: 'respondError', params: { id, code, message } }); }
  onNotification(handler) { this.handlers.push(handler); return () => { this.handlers = this.handlers.filter((item) => item !== handler); }; }
  onServerRequest(handler) { this.serverHandlers.push(handler); return () => {}; }
  emit(message) { for (const handler of this.handlers) handler(message); }
  alive() { return true; }
  async close() {}
}

test('client cancellation translates to turn/interrupt', async () => {
  const transport = new FakeTransport();
  const backend = new CodexAppServer({ transport, logger: silent });
  await backend.initialize();
  const controller = new AbortController();
  const pending = backend.complete({ model: 'codex-test', messages: [{ role: 'user', content: 'hold' }] }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error('cancel'));
  await assert.rejects(pending, /interrupted/);
  assert.ok(transport.calls.some((call) => call.method === 'turn/interrupt'));
  await backend.close();
});

test('server-initiated tool requests fail closed and interrupt the turn', async () => {
  const transport = new FakeTransport();
  const backend = new CodexAppServer({ transport, logger: silent });
  await backend.initialize();
  const pending = backend.complete({ model: 'codex-test', messages: [{ role: 'user', content: 'do not use tools' }] }, { signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  transport.serverHandlers[0]({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  await assert.rejects(pending, /disabled tool or approval request/);
  assert.ok(transport.calls.some((call) => call.method === 'respondError'));
  assert.ok(transport.calls.some((call) => call.method === 'turn/interrupt'));
  await backend.close();
});

test('configuration refuses non-loopback hosts and short supplied tokens', () => {
  assert.throws(() => parseConfig({ args: [], env: { CODEX_PROXY_HOST: '0.0.0.0' } }), /non-loopback/);
  assert.throws(() => parseConfig({ args: [], env: { CODEX_PROXY_TOKEN: 'short' } }), /at least 24/);
});
