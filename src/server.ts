import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppServerLike, ChatCompletionRequest, ChatMessage, Logger } from './types.js';

export interface ServerOptions { host: string; port: number; token: string; bodyLimit: number; timeoutMs: number; maxConcurrency: number; logger: Logger }
class HttpError extends Error { constructor(message: string, readonly status: number, readonly code: string, readonly type = 'invalid_request_error') { super(message); } }

export function createProxyServer(backend: AppServerLike, options: ServerOptions): Server {
  let active = 0;
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', `http://${options.host}:${options.port}`).pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && path === '/readyz') return send(res, backend.ready() ? 200 : 503, { status: backend.ready() ? 'ready' : 'not_ready' });
      if (!path.startsWith('/v1/')) throw new HttpError('Route not found.', 404, 'not_found');
      if (!authorized(req.headers.authorization, options.token)) throw new HttpError('Missing or invalid bearer token.', 401, 'invalid_api_key', 'authentication_error');
      if (req.method === 'GET' && path === '/v1/models') {
        if (active >= options.maxConcurrency) throw new HttpError('Concurrency limit reached.', 429, 'rate_limit_exceeded', 'rate_limit_error');
        active += 1;
        try {
          const signal = AbortSignal.timeout(options.timeoutMs);
          const models = await backend.listModels(signal).catch((error) => {
            if (signal.aborted) throw new HttpError('Codex model listing timed out.', 504, 'timeout', 'server_error');
            throw error;
          });
          return send(res, 200, { object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.ownedBy ?? 'codex-local' })) });
        } finally { active -= 1; }
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') throw new HttpError('Route not found.', 404, 'not_found');
      if (active >= options.maxConcurrency) throw new HttpError('Concurrency limit reached.', 429, 'rate_limit_exceeded', 'rate_limit_error');
      active += 1;
      let body: ChatCompletionRequest;
      try { body = validate(await readBody(req, options.bodyLimit)); }
      catch (error) { active -= 1; throw error; }
      const controller = new AbortController();
      let finished = false;
      const timer = setTimeout(() => controller.abort(new HttpError('Codex turn timed out.', 504, 'timeout', 'server_error')), options.timeoutMs);
      const disconnect = () => { if (!finished) controller.abort(new HttpError('Client disconnected.', 499, 'client_closed_request')); };
      req.once('aborted', disconnect); res.once('close', disconnect);
      try {
        const created = Math.floor(Date.now() / 1000);
        if (body.stream) {
          const id = `chatcmpl-${randomUUID()}`;
          let roleSent = false;
          let streamWritable = true;
          let streamStarted = false;
          const startStream = () => {
            if (streamStarted) return;
            streamStarted = true;
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          };
          const result = await backend.complete(body, { signal: controller.signal, onDelta: (content) => {
            if (!streamWritable) return;
            startStream();
            streamWritable = res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { ...(roleSent ? {} : { role: 'assistant' }), content }, finish_reason: null }] })}\n\n`);
            roleSent = true;
            if (!streamWritable) controller.abort(new HttpError('Streaming client is too slow.', 499, 'client_closed_request'));
          } });
          startStream();
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          finished = true; res.end('data: [DONE]\n\n');
        } else {
          const result = await backend.complete(body, { signal: controller.signal });
          finished = true;
          send(res, 200, { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created, model: result.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text, refusal: null }, finish_reason: 'stop' }] });
        }
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        finished = true; clearTimeout(timer); req.off('aborted', disconnect); res.off('close', disconnect); active -= 1;
      }
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError('Codex adapter request failed.', 502, 'codex_error', 'server_error');
      options.logger.warn('request_failed', { status: known.status, code: known.code });
      if (!res.headersSent) send(res, known.status, { error: { message: known.message, type: known.type, code: known.code, param: null } });
      else res.destroy();
    }
  });
}

function validate(raw: unknown): ChatCompletionRequest {
  if (!raw || typeof raw !== 'object') throw new HttpError('Body must be a JSON object.', 400, 'invalid_request_error');
  const body = raw as ChatCompletionRequest;
  if (!body.model || typeof body.model !== 'string') throw new HttpError('model is required.', 400, 'invalid_request_error');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError('messages must be a non-empty array.', 400, 'invalid_request_error');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError('stream must be a boolean.', 400, 'invalid_request_error');
  const supported = new Set(['model', 'messages', 'stream', 'n', 'user']);
  for (const field of Object.keys(body)) if (!supported.has(field)) throw new HttpError(`${field} is not supported.`, 400, 'invalid_request_error');
  if (body.n !== undefined && body.n !== 1) throw new HttpError('Only n=1 is supported.', 400, 'invalid_request_error');
  for (const message of body.messages as ChatMessage[]) if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || typeof message?.content !== 'string') throw new HttpError('Only text chat messages are supported.', 400, 'invalid_request_error');
  return body;
}

async function readBody(req: IncomingMessage, limit: number) { const parts: Buffer[] = []; let size = 0; for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > limit) throw new HttpError('Request body too large.', 413, 'request_too_large'); parts.push(chunk); } try { return JSON.parse(Buffer.concat(parts).toString()); } catch { throw new HttpError('Body must be valid JSON.', 400, 'invalid_request_error'); } }
function authorized(header: string | undefined, token: string) { if (!header?.startsWith('Bearer ')) return false; return timingSafeEqual(createHash('sha256').update(header.slice(7)).digest(), createHash('sha256').update(token).digest()); }
function send(res: ServerResponse, status: number, body: unknown) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) }); res.end(data); }
