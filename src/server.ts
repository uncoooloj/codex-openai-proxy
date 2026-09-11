import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ChatRole,
  ChatResponseFormatType,
  HttpMethod,
  HttpRoute,
  JsonSchemaType,
  OpenAiErrorCode,
  OpenAiErrorType,
  OpenAiFinishReason,
  OpenAiObjectType,
  ServiceTier,
} from './constants.js';
import type {
  AppServerLike,
  ChatFunctionTool,
  ChatCompletionRequest,
  ChatMessage,
  ChatResponseFormat,
  CompletionResult,
  Logger,
} from './types.js';

const API_PREFIX = '/v1/';
const BEARER_PREFIX = 'Bearer ';
const CHAT_COMPLETION_ID_PREFIX = 'chatcmpl-';
const SSE_DONE = 'data: [DONE]\n\n';
const JSON_SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const SUPPORTED_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'n',
  'user',
  'response_format',
  'serviceTier',
  'max_tokens',
  'tool_choice',
  'tools',
]);

const SUPPORTED_RESPONSE_FORMAT_FIELDS = new Set([
  'type',
  'json_schema',
]);

const SUPPORTED_JSON_SCHEMA_FIELDS = new Set([
  'name',
  'description',
  'strict',
  'schema',
]);

const DIAGNOSTIC_REQUEST_FIELDS = new Set([
  ...SUPPORTED_REQUEST_FIELDS,
  'max_tokens',
  'tool_choice',
  'tools',
]);

const JSON_SCHEMA_TYPES = new Set<string>(Object.values(JsonSchemaType));

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
    if (error instanceof HttpError && (error.status === 408 || error.status === 413)) {
      // Do not keep a partial or oversized upload alive after releasing its slot.
      response.setHeader('connection', 'close');
      response.once('finish', () => request.destroy());
    }
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
  const rawBody = await readJsonBody(request, options.bodyLimit, options.timeoutMs);
  logRequestShape(options.logger, rawBody);
  const body = validateChatCompletionRequest(rawBody);
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
  if (request.aborted || response.destroyed) disconnect();

  try {
    controller.signal.throwIfAborted();
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

  if (!result.toolCalls && body.response_format?.type === ChatResponseFormatType.JsonObject) {
    assertJsonObject(result.text);
  }

  const toolCalls = result.toolCalls;

  sendJson(response, 200, {
    id: createCompletionId(),
    object: OpenAiObjectType.ChatCompletion,
    created,
    model: result.model,
    choices: [{
      index: 0,
      message: {
        role: ChatRole.Assistant,
        content: toolCalls ? null : result.text,
        refusal: null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls
        ? OpenAiFinishReason.ToolCalls
        : OpenAiFinishReason.Stop,
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
      if (!content || !streamWritable || controller.signal.aborted) return;

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
  if (!assistantRoleSent && result.text) {
    writeSse(response, {
      id,
      object: OpenAiObjectType.ChatCompletionChunk,
      created,
      model: result.model,
      choices: [{
        index: 0,
        delta: { role: ChatRole.Assistant, content: result.text },
        finish_reason: null,
      }],
    });
  }
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
  if (body.serviceTier !== undefined && body.serviceTier !== ServiceTier.Flex) {
    throw invalidRequest('Only serviceTier="flex" is supported.');
  }
  if (
    body.max_tokens !== undefined
    && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)
  ) {
    throw invalidRequest('max_tokens must be a positive integer.');
  }

  body.messages = body.messages.map(validateChatMessage);

  if (body.response_format !== undefined) {
    body.response_format = validateResponseFormat(body.response_format);
    if (
      body.stream
      && body.response_format.type === ChatResponseFormatType.JsonObject
    ) {
      throw invalidRequest('Streaming JSON object mode is not supported.');
    }
  }
  if (body.tools !== undefined) {
    body.tools = validateTools(body.tools);
    if (body.stream) {
      throw invalidRequest('Streaming tool calls are not supported.');
    }
  }
  if (body.tool_choice !== undefined) {
    if (!['auto', 'none'].includes(String(body.tool_choice))) {
      throw invalidRequest('tool_choice must be "auto" or "none".');
    }
    if (body.tools === undefined) {
      throw invalidRequest('tool_choice requires tools.');
    }
  }

  return body;
}

function validateChatMessage(message: unknown, index: number): ChatMessage {
  if (!isPlainObject(message) || !SUPPORTED_CHAT_ROLES.has(String(message.role))) {
    throw invalidRequest(`messages[${index}].role is not supported.`);
  }

  const role = message.role as ChatMessage['role'];
  if (role === ChatRole.Tool) {
    rejectUnsupportedFields(
      message,
      new Set(['role', 'content', 'tool_call_id']),
      `messages[${index}]`,
    );
    if (typeof message.content !== 'string') {
      throw invalidRequest(`messages[${index}].content must be a string.`);
    }
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
      throw invalidRequest(`messages[${index}].tool_call_id is required.`);
    }
    return message as unknown as ChatMessage;
  }

  if (role === ChatRole.Assistant) {
    rejectUnsupportedFields(
      message,
      new Set(['role', 'content', 'tool_calls']),
      `messages[${index}]`,
    );
    if (message.content !== null && typeof message.content !== 'string') {
      throw invalidRequest(`messages[${index}].content must be a string or null.`);
    }
    if (message.tool_calls !== undefined) {
      validateAssistantToolCalls(message.tool_calls, index);
    }
    if (message.content === null && message.tool_calls === undefined) {
      throw invalidRequest(`messages[${index}] must contain content or tool_calls.`);
    }
    return message as unknown as ChatMessage;
  }

  rejectUnsupportedFields(
    message,
    new Set(['role', 'content']),
    `messages[${index}]`,
  );
  if (typeof message.content !== 'string') {
    throw invalidRequest(`messages[${index}].content must be a string.`);
  }
  return message as unknown as ChatMessage;
}

function validateAssistantToolCalls(raw: unknown, messageIndex: number): void {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidRequest(`messages[${messageIndex}].tool_calls must be non-empty.`);
  }
  raw.forEach((call, callIndex) => {
    const path = `messages[${messageIndex}].tool_calls[${callIndex}]`;
    if (!isPlainObject(call) || call.type !== 'function') {
      throw invalidRequest(`${path} must be a function call.`);
    }
    rejectUnsupportedFields(call, new Set(['id', 'type', 'function']), path);
    if (typeof call.id !== 'string' || !call.id) {
      throw invalidRequest(`${path}.id is required.`);
    }
    if (!isPlainObject(call.function)) {
      throw invalidRequest(`${path}.function must be an object.`);
    }
    rejectUnsupportedFields(call.function, new Set(['name', 'arguments']), `${path}.function`);
    if (
      typeof call.function.name !== 'string'
      || !JSON_SCHEMA_NAME.test(call.function.name)
    ) {
      throw invalidRequest(`${path}.function.name is invalid.`);
    }
    if (typeof call.function.arguments !== 'string') {
      throw invalidRequest(`${path}.function.arguments must be a string.`);
    }
  });
}

function validateResponseFormat(raw: unknown): ChatResponseFormat {
  if (!isPlainObject(raw)) {
    throw invalidRequest('response_format must be an object.');
  }

  rejectUnsupportedFields(raw, SUPPORTED_RESPONSE_FORMAT_FIELDS, 'response_format');
  if (raw.type === ChatResponseFormatType.JsonObject) {
    if ('json_schema' in raw) {
      throw invalidRequest('response_format.json_schema is not valid for json_object.');
    }
    return raw as unknown as ChatResponseFormat;
  }
  if (raw.type !== ChatResponseFormatType.JsonSchema) {
    throw invalidRequest(
      'Only response_format.type="json_schema" is supported.',
    );
  }
  if (!isPlainObject(raw.json_schema)) {
    throw invalidRequest('response_format.json_schema must be an object.');
  }

  const jsonSchema = raw.json_schema;
  rejectUnsupportedFields(
    jsonSchema,
    SUPPORTED_JSON_SCHEMA_FIELDS,
    'response_format.json_schema',
  );

  if (
    typeof jsonSchema.name !== 'string'
    || !JSON_SCHEMA_NAME.test(jsonSchema.name)
  ) {
    throw invalidRequest(
      'response_format.json_schema.name must be 1-64 letters, numbers, underscores, or dashes.',
    );
  }
  if (
    jsonSchema.description !== undefined
    && typeof jsonSchema.description !== 'string'
  ) {
    throw invalidRequest('response_format.json_schema.description must be a string.');
  }
  if (jsonSchema.strict !== true) {
    throw invalidRequest('response_format.json_schema.strict must be true.');
  }
  if (!isPlainObject(jsonSchema.schema)) {
    throw invalidRequest('response_format.json_schema.schema must be an object.');
  }

  return raw as unknown as ChatResponseFormat;
}

function validateTools(raw: unknown): ChatFunctionTool[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidRequest('tools must be a non-empty array.');
  }

  const names = new Set<string>();
  return raw.map((tool, index) => {
    if (!isPlainObject(tool) || tool.type !== 'function') {
      throw invalidRequest(`tools[${index}] must be a function tool.`);
    }
    rejectUnsupportedFields(tool, new Set(['type', 'function']), `tools[${index}]`);
    if (!isPlainObject(tool.function)) {
      throw invalidRequest(`tools[${index}].function must be an object.`);
    }
    rejectUnsupportedFields(
      tool.function,
      new Set(['name', 'description', 'parameters', 'strict']),
      `tools[${index}].function`,
    );

    const name = tool.function.name;
    if (typeof name !== 'string' || !JSON_SCHEMA_NAME.test(name)) {
      throw invalidRequest(`tools[${index}].function.name is invalid.`);
    }
    if (names.has(name)) {
      throw invalidRequest(`tools contains duplicate function name ${name}.`);
    }
    names.add(name);

    if (
      tool.function.description !== undefined
      && typeof tool.function.description !== 'string'
    ) {
      throw invalidRequest(`tools[${index}].function.description must be a string.`);
    }
    if (!isPlainObject(tool.function.parameters)) {
      throw invalidRequest(`tools[${index}].function.parameters must be an object.`);
    }
    if (
      tool.function.strict !== undefined
      && typeof tool.function.strict !== 'boolean'
    ) {
      throw invalidRequest(`tools[${index}].function.strict must be a boolean.`);
    }

    return tool as unknown as ChatFunctionTool;
  });
}

function assertJsonObject(text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(
      'Codex did not return a valid JSON object.',
      502,
      OpenAiErrorCode.CodexError,
      OpenAiErrorType.Server,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(
      'Codex did not return a JSON object.',
      502,
      OpenAiErrorCode.CodexError,
      OpenAiErrorType.Server,
    );
  }
}

function rejectUnsupportedFields(
  value: Record<string, unknown>,
  supportedFields: ReadonlySet<string>,
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (!supportedFields.has(field)) {
      throw invalidRequest(`${path}.${field} is not supported.`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logRequestShape(
  logger: Logger,
  raw: unknown,
): void {
  if (!isPlainObject(raw)) return;

  const allRequestFields = Object.keys(raw);
  const hasUnsupportedField = allRequestFields.some(
    (field) => !SUPPORTED_REQUEST_FIELDS.has(field),
  );
  if (
    !('response_format' in raw)
    && !('tools' in raw)
    && !hasUnsupportedField
  ) return;

  const responseFormat = isPlainObject(raw.response_format)
    ? raw.response_format
    : undefined;
  const jsonSchema = responseFormat && isPlainObject(responseFormat.json_schema)
    ? responseFormat.json_schema
    : undefined;
  const schema = jsonSchema && isPlainObject(jsonSchema.schema)
    ? jsonSchema.schema
    : undefined;
  const properties = schema && isPlainObject(schema.properties)
    ? Object.keys(schema.properties).length
    : 0;
  const required = schema && Array.isArray(schema.required)
    ? schema.required.length
    : 0;

  logger.info('chat_completion_request_shape', {
    requestFields: recognizedFields(raw, DIAGNOSTIC_REQUEST_FIELDS),
    unsupportedRequestFieldCount: countUnsupportedFields(
      raw,
      DIAGNOSTIC_REQUEST_FIELDS,
    ),
    responseFormatFields: recognizedFields(
      responseFormat,
      SUPPORTED_RESPONSE_FORMAT_FIELDS,
    ),
    unsupportedResponseFormatFieldCount: countUnsupportedFields(
      responseFormat,
      SUPPORTED_RESPONSE_FORMAT_FIELDS,
    ),
    jsonSchemaFields: recognizedFields(
      jsonSchema,
      SUPPORTED_JSON_SCHEMA_FIELDS,
    ),
    unsupportedJsonSchemaFieldCount: countUnsupportedFields(
      jsonSchema,
      SUPPORTED_JSON_SCHEMA_FIELDS,
    ),
    responseFormatType: responseFormat?.type === ChatResponseFormatType.JsonSchema
      ? ChatResponseFormatType.JsonSchema
      : responseFormat?.type === ChatResponseFormatType.JsonObject
        ? ChatResponseFormatType.JsonObject
        : 'other',
    ...('serviceTier' in raw
      ? { serviceTier: normalizedServiceTier(raw.serviceTier) }
      : {}),
    ...('tools' in raw ? toolShape(raw.tools, raw.tool_choice) : {}),
    strict: jsonSchema?.strict === true,
    schemaType: normalizedSchemaType(schema?.type),
    schemaPropertyCount: properties,
    schemaRequiredCount: required,
  });
}

function recognizedFields(
  value: Record<string, unknown> | undefined,
  recognized: ReadonlySet<string>,
): string[] {
  if (!value) return [];
  return Object.keys(value).filter((field) => recognized.has(field)).sort();
}

function countUnsupportedFields(
  value: Record<string, unknown> | undefined,
  recognized: ReadonlySet<string>,
): number {
  if (!value) return 0;
  return Object.keys(value).filter((field) => !recognized.has(field)).length;
}

function normalizedSchemaType(value: unknown): string {
  return typeof value === 'string' && JSON_SCHEMA_TYPES.has(value)
    ? value
    : value === undefined
      ? 'unspecified'
      : 'other';
}

function toolShape(
  tools: unknown,
  toolChoice: unknown,
): Record<string, unknown> {
  const toolList = Array.isArray(tools) ? tools : [];
  const functionOnly = toolList.length > 0 && toolList.every((tool) => (
    isPlainObject(tool) && tool.type === 'function'
  ));

  return {
    toolCount: toolList.length,
    toolTypeCategory: functionOnly ? 'function_only' : 'other',
    toolChoiceCategory: normalizedToolChoice(toolChoice),
  };
}

function normalizedToolChoice(value: unknown): string {
  if (value === 'auto' || value === 'none' || value === 'required') {
    return value;
  }
  if (isPlainObject(value) && value.type === 'function') {
    return 'specific_function';
  }
  return typeof value;
}

function normalizedServiceTier(value: unknown): string {
  if (value === null) return 'null';
  if (
    value === 'auto'
    || value === 'default'
    || value === 'flex'
    || value === 'priority'
  ) {
    return value;
  }
  return typeof value;
}

async function readJsonBody(
  request: IncomingMessage,
  bodyLimit: number,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const timer = setTimeout(() => fail(new HttpError(
      'Request body timed out.', 408, OpenAiErrorCode.Timeout,
    )), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', fail);
      request.off('aborted', onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onAbort = () => fail(new HttpError(
      'Client disconnected.', 499, OpenAiErrorCode.ClientClosedRequest,
    ));
    const onData = (part: Buffer) => {
      totalBytes += part.length;
      if (totalBytes > bodyLimit) {
        fail(new HttpError(
          'Request body too large.', 413, OpenAiErrorCode.RequestTooLarge,
        ));
        return;
      }
      chunks.push(part);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(invalidRequest('Body must be valid JSON.'));
      }
    };

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', fail);
    request.once('aborted', onAbort);
  });
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
