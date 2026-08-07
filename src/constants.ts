export const ChatRole = {
  System: 'system',
  Developer: 'developer',
  User: 'user',
  Assistant: 'assistant',
} as const;

export type ChatRole = typeof ChatRole[keyof typeof ChatRole];

export enum CliCommand {
  Serve = 'serve',
  Status = 'status',
}

export enum CliFlag {
  Help = 'help',
  Host = 'host',
  Port = 'port',
  Token = 'token',
  CodexBin = 'codex-bin',
  BodyLimit = 'body-limit',
  Timeout = 'timeout',
  MaxConcurrency = 'max-concurrency',
}

export enum EnvironmentVariable {
  ProxyToken = 'CODEX_PROXY_TOKEN',
  LegacyProxyToken = 'CODEX_OPENAI_PROXY_TOKEN',
  ProxyHost = 'CODEX_PROXY_HOST',
  LegacyProxyHost = 'CODEX_OPENAI_PROXY_HOST',
  ProxyPort = 'CODEX_PROXY_PORT',
  LegacyProxyPort = 'CODEX_OPENAI_PROXY_PORT',
  CodexBin = 'CODEX_BIN',
  ProxyCodexBin = 'CODEX_PROXY_CODEX_BIN',
  ProxyBodyLimit = 'CODEX_PROXY_BODY_LIMIT',
  LegacyProxyBodyLimit = 'CODEX_OPENAI_PROXY_BODY_LIMIT',
  ProxyTimeout = 'CODEX_PROXY_TIMEOUT_MS',
  LegacyProxyTimeout = 'CODEX_OPENAI_PROXY_TIMEOUT_MS',
  ProxyMaxConcurrency = 'CODEX_PROXY_MAX_CONCURRENCY',
  LegacyProxyMaxConcurrency = 'CODEX_OPENAI_PROXY_MAX_CONCURRENCY',
}

export enum LogLevel {
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

export enum HttpMethod {
  Get = 'GET',
  Post = 'POST',
}

export enum HttpRoute {
  Health = '/healthz',
  Readiness = '/readyz',
  Models = '/v1/models',
  ChatCompletions = '/v1/chat/completions',
}

export enum CodexRpcMethod {
  Initialize = 'initialize',
  Initialized = 'initialized',
  ListModels = 'model/list',
  StartThread = 'thread/start',
  StartTurn = 'turn/start',
  InterruptTurn = 'turn/interrupt',
}

export enum CodexNotification {
  TransportError = 'transport/error',
  AgentMessageDelta = 'item/agentMessage/delta',
  ItemCompleted = 'item/completed',
  TurnCompleted = 'turn/completed',
  Error = 'error',
}

export enum CodexItemType {
  AgentMessage = 'agentMessage',
  CommandExecution = 'commandExecution',
  FileChange = 'fileChange',
  McpToolCall = 'mcpToolCall',
  DynamicToolCall = 'dynamicToolCall',
  CollaborationAgentToolCall = 'collabAgentToolCall',
  SubAgentActivity = 'subAgentActivity',
  WebSearch = 'webSearch',
  ImageView = 'imageView',
  ImageGeneration = 'imageGeneration',
}

export enum CodexTurnStatus {
  Completed = 'completed',
  Interrupted = 'interrupted',
}

export enum OpenAiObjectType {
  List = 'list',
  Model = 'model',
  ChatCompletion = 'chat.completion',
  ChatCompletionChunk = 'chat.completion.chunk',
}

export enum OpenAiFinishReason {
  Stop = 'stop',
}

export enum ChatResponseFormatType {
  JsonObject = 'json_object',
  JsonSchema = 'json_schema',
}

export enum ServiceTier {
  Flex = 'flex',
}

export enum JsonSchemaType {
  Array = 'array',
  Boolean = 'boolean',
  Integer = 'integer',
  Null = 'null',
  Number = 'number',
  Object = 'object',
  String = 'string',
}

export enum OpenAiErrorType {
  InvalidRequest = 'invalid_request_error',
  Authentication = 'authentication_error',
  RateLimit = 'rate_limit_error',
  Server = 'server_error',
}

export enum OpenAiErrorCode {
  InvalidRequest = 'invalid_request_error',
  NotFound = 'not_found',
  InvalidApiKey = 'invalid_api_key',
  RateLimitExceeded = 'rate_limit_exceeded',
  Timeout = 'timeout',
  ClientClosedRequest = 'client_closed_request',
  RequestTooLarge = 'request_too_large',
  CodexError = 'codex_error',
}
