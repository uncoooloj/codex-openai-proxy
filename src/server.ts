import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ChatRole,
  HttpMethod,
  HttpRoute,
  OpenAiErrorCode,
  OpenAiErrorType,
  OpenAiFinishReason,
  OpenAiObjectType,
} from './constants.js';
import type {
  AppServerLike,
  ChatCompletionRequest,
  ChatMessage,
  CompletionResult,
  Logger,
} from './types.js';

const API_PREFIX = '/v1/';
const BEARER_PREFIX = 'Bearer ';
const CHAT_COMPLETION_ID_PREFIX = 'chatcmpl-';
const SSE_DONE = 'data: [DONE]\n\n';

const SUPPORTED_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'n',
  'user',
]);

const SUPPORTED_CHAT_ROLES = new Set<string>(Object.values(ChatRole));

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  bodyLimit: number;
  timeoutMs: number;
  maxConcurrency: number;
  logger: Logger;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: OpenAiErrorCode,
    readonly type: OpenAiErrorType = OpenAiErrorType.InvalidRequest,
  ) {
    super(message);
  }
}

class ConcurrencyGate {
  private activeRequests = 0;

  constructor(private readonly maximumRequests: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= this.maximumRequests) {
      throw new HttpError(
        'Concurrency limit reached.',
        429,
        OpenAiErrorCode.RateLimitExceeded,
        OpenAiErrorType.RateLimit,
      );
    }

    this.activeRequests += 1;
    try {
      return await operation();
    } finally {
      this.activeRequests -= 1;
    }
  }
}

export function createProxyServer(
  backend: AppServerLike,
  options: ServerOptions,
): Server {
  const concurrency = new ConcurrencyGate(options.maxConcurrency);

  return createServer((request, response) => {
    void handleRequest(request, response, backend, options, concurrency);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  backend: AppServerLike,
  options: ServerOptions,
  concurrency: ConcurrencyGate,
): Promise<void> {
  try {
    const path = requestPath(request, options);

    if (request.method === HttpMethod.Get && path === HttpRoute.Health) {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === HttpMethod.Get && path === HttpRoute.Readiness) {
      const ready = backend.ready();
      sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
      });
      return;
    }

    if (!path.startsWith(API_PREFIX)) {
      throw routeNotFound();
    }

    if (!hasValidBearerToken(request.headers.authorization, options.token)) {
      throw new HttpError(
        'Missing or invalid bearer token.',
        401,
        OpenAiErrorCode.InvalidApiKey,
        OpenAiErrorType.Authentication,
      );
    }

    if (request.method === HttpMethod.Get && path === HttpRoute.Models) {
      await concurrency.run(() => handleListModels(response, backend, options));
      return;
    }

    if (
      request.method === HttpMethod.Post
      && path === HttpRoute.ChatCompletions
    ) {
      // Reserve the slot before reading the body so slow clients cannot bypass
      // the concurrency limit by holding multiple partial requests open.
      await concurrency.run(() => handleChatCompletion(
        request,
        response,
        backend,
        options,
      ));
      return;
    }

    throw routeNotFound();
  } catch (error) {
    handleRequestError(error, response, options.logger);
  }
}

async function handleListModels(
  response: ServerResponse,
  backend: AppServerLike,
  options: ServerOptions,
): Promise<void> {
  const signal = AbortSignal.timeout(options.timeoutMs);

  const models = await backend.listModels(signal).catch((error: unknown) => {
    if (signal.aborted) {
      throw new HttpError(
        'Codex model listing timed out.',
        504,
        OpenAiErrorCode.Timeout,
        OpenAiErrorType.Server,
      );
    }
    throw error;
  });

  sendJson(response, 200, {
    object: OpenAiObjectType.List,
    data: models.map((model) => ({
      id: model.id,
      object: OpenAiObjectType.Model,
      created: 0,
      owned_by: model.ownedBy ?? 'codex-local',
    })),
  });
}

async function handleChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  backend: AppServerLike,
  options: ServerOptions,
): Promise<void> {
  const body = validateChatCompletionRequest(
    await readJsonBody(request, options.bodyLimit),
  );
  const controller = new AbortController();
  let requestFinished = false;

  const timeout = setTimeout(() => {
    controller.abort(new HttpError(
      'Codex turn timed out.',
      504,
      OpenAiErrorCode.Timeout,
      OpenAiErrorType.Server,
    ));
  }, options.timeoutMs);

  const disconnect = () => {
    if (!requestFinished) {
      controller.abort(new HttpError(
        'Client disconnected.',
        499,
        OpenAiErrorCode.ClientClosedRequest,
      ));
    }
  };

  request.once('aborted', disconnect);
  response.once('close', disconnect);

  try {
    if (body.stream) {
      await streamCompletion(response, backend, body, controller);
    } else {
      await sendCompletion(response, backend, body, controller.signal);
    }
    requestFinished = true;
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    requestFinished = true;
    clearTimeout(timeout);
    request.off('aborted', disconnect);
    response.off('close', disconnect);
  }
}

async function sendCompletion(
  response: ServerResponse,
  backend: AppServerLike,
  body: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<void> {
  const result = await backend.complete(body, { signal });
  const created = currentUnixTime();

  sendJson(response, 200, {
    id: createCompletionId(),
    object: OpenAiObjectType.ChatCompletion,
    created,
    model: result.model,
    choices: [{
      index: 0,
      message: {
        role: ChatRole.Assistant,
        content: result.text,
        refusal: null,
      },
      finish_reason: OpenAiFinishReason.Stop,
    }],
  });
}

async function streamCompletion(
  response: ServerResponse,
  backend: AppServerLike,
  body: ChatCompletionRequest,
  controller: AbortController,
): Promise<void> {
  const id = createCompletionId();
  const created = currentUnixTime();
  let assistantRoleSent = false;
  let streamStarted = false;
  let streamWritable = true;

  const startStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  };

  const result = await backend.complete(body, {
    signal: controller.signal,
    onDelta: (content) => {
      if (!streamWritable || controller.signal.aborted) return;

      startStream();
      streamWritable = writeSse(response, {
        id,
        object: OpenAiObjectType.ChatCompletionChunk,
        created,
        model: body.model,
        choices: [{
          index: 0,
          delta: {
            ...(!assistantRoleSent ? { role: ChatRole.Assistant } : {}),
            content,
          },
          finish_reason: null,
        }],
      });
      assistantRoleSent = true;

      if (!streamWritable) {
        controller.abort(new HttpError(
          'Streaming client is too slow.',
          499,
          OpenAiErrorCode.ClientClosedRequest,
        ));
      }
    },
  });

  startStream();
  writeFinalStreamChunk(response, id, created, result);
  response.end(SSE_DONE);
}

function writeFinalStreamChunk(
  response: ServerResponse,
  id: string,
  created: number,
  result: CompletionResult,
): void {
  writeSse(response, {
    id,
    object: OpenAiObjectType.ChatCompletionChunk,
    created,
    model: result.model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: OpenAiFinishReason.Stop,
    }],
  });
}

function writeSse(response: ServerResponse, body: unknown): boolean {
  return response.write(`data: ${JSON.stringify(body)}\n\n`);
}

function validateChatCompletionRequest(raw: unknown): ChatCompletionRequest {
  if (!raw || typeof raw !== 'object') {
    throw invalidRequest('Body must be a JSON object.');
  }

  const body = raw as ChatCompletionRequest;
  if (!body.model || typeof body.model !== 'string') {
    throw invalidRequest('model is required.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest('messages must be a non-empty array.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw invalidRequest('stream must be a boolean.');
  }

  for (const field of Object.keys(body)) {
    if (!SUPPORTED_REQUEST_FIELDS.has(field)) {
      throw invalidRequest(`${field} is not supported.`);
    }
  }

  if (body.n !== undefined && body.n !== 1) {
    throw invalidRequest('Only n=1 is supported.');
  }

  for (const message of body.messages as ChatMessage[]) {
    if (
      !SUPPORTED_CHAT_ROLES.has(message?.role)
      || typeof message?.content !== 'string'
    ) {
      throw invalidRequest('Only text chat messages are supported.');
    }
  }

  return body;
}

async function readJsonBody(
  request: IncomingMessage,
  bodyLimit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const part of request) {
    const chunk = Buffer.from(part);
    totalBytes += chunk.length;

    if (totalBytes > bodyLimit) {
      throw new HttpError(
        'Request body too large.',
        413,
        OpenAiErrorCode.RequestTooLarge,
      );
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw invalidRequest('Body must be valid JSON.');
  }
}

function hasValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith(BEARER_PREFIX)) return false;

  const suppliedToken = authorization.slice(BEARER_PREFIX.length);
  const suppliedDigest = createHash('sha256').update(suppliedToken).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function handleRequestError(
  error: unknown,
  response: ServerResponse,
  logger: Logger,
): void {
  const knownError = error instanceof HttpError
    ? error
    : new HttpError(
      'Codex adapter request failed.',
      502,
      OpenAiErrorCode.CodexError,
      OpenAiErrorType.Server,
    );

  logger.warn('request_failed', {
    status: knownError.status,
    code: knownError.code,
  });

  if (response.headersSent) {
    response.destroy();
    return;
  }

  sendJson(response, knownError.status, {
    error: {
      message: knownError.message,
      type: knownError.type,
      code: knownError.code,
      param: null,
    },
  });
}

function requestPath(
  request: IncomingMessage,
  options: ServerOptions,
): string {
  return new URL(
    request.url ?? '/',
    `http://${options.host}:${options.port}`,
  ).pathname;
}

function routeNotFound(): HttpError {
  return new HttpError(
    'Route not found.',
    404,
    OpenAiErrorCode.NotFound,
  );
}

function invalidRequest(message: string): HttpError {
  return new HttpError(
    message,
    400,
    OpenAiErrorCode.InvalidRequest,
  );
}

function createCompletionId(): string {
  return `${CHAT_COMPLETION_ID_PREFIX}${randomUUID()}`;
}

function currentUnixTime(): number {
  return Math.floor(Date.now() / 1000);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  response.end(data);
}
