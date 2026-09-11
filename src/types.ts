import type {
  ChatResponseFormatType,
  ChatRole,
  ServiceTier,
} from './constants.js';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: CompletionToolCall[];
  tool_call_id?: string;
}

export interface JsonSchemaResponseFormat {
  type: ChatResponseFormatType.JsonSchema;
  json_schema: {
    name: string;
    description?: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

export interface JsonObjectResponseFormat {
  type: ChatResponseFormatType.JsonObject;
}

export type ChatResponseFormat =
  | JsonSchemaResponseFormat
  | JsonObjectResponseFormat;

export interface ChatFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface CompletionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  n?: number;
  tools?: ChatFunctionTool[];
  tool_choice?: 'auto' | 'none';
  functions?: unknown;
  max_tokens?: number;
  response_format?: ChatResponseFormat;
  serviceTier?: ServiceTier;
  logprobs?: unknown;
  [key: string]: unknown;
}

export interface ProxyConfig {
  host: string;
  port: number;
  token: string;
  tokenGenerated: boolean;
  codexBin: string;
  bodyLimit: number;
  timeoutMs: number;
  maxConcurrency: number;
  startupTimeoutMs: number;
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  toolCalls?: CompletionToolCall[];
}

export interface CompletionHandlers {
  onDelta?: (delta: string) => void;
  signal: AbortSignal;
}

export interface AppServerLike {
  initialize(): Promise<void>;
  ready(): boolean;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  complete(
    request: ChatCompletionRequest,
    handlers: CompletionHandlers,
  ): Promise<CompletionResult>;
  close(): Promise<void>;
}

export interface AppServerOptions {
  startupTimeoutMs?: number;
  codexBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configOverrides?: string[];
  transport?: JsonRpcTransport;
  logger?: Logger;
}

export interface JsonRpcTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  respondResult(id: string | number, result: unknown): void;
  onNotification(handler: (message: JsonRpcMessage) => void): () => void;
  onServerRequest(handler: (message: JsonRpcMessage) => void): () => void;
  close(): Promise<void>;
  alive(): boolean;
}

export interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  [key: string]: unknown;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
