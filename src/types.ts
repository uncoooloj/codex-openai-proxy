export type ChatRole = 'system' | 'developer' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  n?: number;
  tools?: unknown;
  tool_choice?: unknown;
  functions?: unknown;
  response_format?: unknown;
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
}

export interface AppServerLike {
  initialize(): Promise<void>;
  ready(): boolean;
  listModels(signal?: AbortSignal): Promise<Array<{ id: string; ownedBy?: string }>>;
  complete(
    request: ChatCompletionRequest,
    handlers: { onDelta?: (delta: string) => void; signal: AbortSignal },
  ): Promise<{ text: string; model: string }>;
  close(): Promise<void>;
}

export interface AppServerOptions {
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
