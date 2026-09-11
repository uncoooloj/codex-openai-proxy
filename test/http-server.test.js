import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import OpenAI from 'openai';
import { createProxyServer } from '../dist/server.js';

const token = 'http-regression-token-with-enough-entropy';
const model = 'fixture-model';

async function fixture(t, complete, options = {}) {
  const backend = {
    ready: () => true,
    listModels: async () => [{ id: model }],
    complete,
  };
  const server = createProxyServer(backend, {
    host: '127.0.0.1', port: 0, token, bodyLimit: 4096,
    timeoutMs: 1000, maxConcurrency: 1,
    logger: { info() {}, warn() {}, error() {} }, ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const client = new OpenAI({ apiKey: token, baseURL, maxRetries: 0 });
  return { baseURL, client };
}

test('partial upload reaches a deadline and releases its concurrency slot', async (t) => {
  const { baseURL, client } = await fixture(t, async () => ({ text: 'ok', model }), { timeoutMs: 50 });
  const upload = request(`${baseURL}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  t.after(() => upload.destroy());
  upload.on('error', () => {});
  const received = once(upload, 'response');
  upload.write('{');
  const [response] = await received;
  assert.equal(response.statusCode, 408);
  response.resume();
  await once(response, 'end');
  const result = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.choices[0].message.content, 'ok');
});

test('oversized upload returns an actionable 413', async (t) => {
  const { baseURL } = await fixture(t, async () => { throw new Error('must not run'); }, { bodyLimit: 8 });
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: 'large' }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'request_too_large');
});

test('SSE includes the final text if Codex emits no delta events', async (t) => {
  const { client } = await fixture(t, async () => ({ text: 'final-only answer', model }));
  const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'hello' }] });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join(''), 'final-only answer');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('an empty delta does not suppress final-only SSE text', async (t) => {
  const { client } = await fixture(t, async (_body, handlers) => {
    handlers.onDelta('');
    return { text: 'final answer', model };
  });
  const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'hello' }] });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0].delta.content ?? '';
  assert.equal(text, 'final answer');
});

test('JSON object mode permits an intermediate function call with null content', async (t) => {
  const { client } = await fixture(t, async () => ({
    model, text: '', toolCalls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  }));
  const result = await client.chat.completions.create({
    model, messages: [{ role: 'user', content: 'look it up' }],
    response_format: { type: 'json_object' },
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
  });
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.content, null);
});
