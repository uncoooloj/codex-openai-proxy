import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { access, chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ChatRole,
  ChatResponseFormatType,
  CodexItemType,
  CodexNotification,
  CodexRpcMethod,
  CodexTurnStatus,
} from './constants.js';
import type {
  AppServerLike,
  AppServerOptions,
  ChatCompletionRequest,
  ChatFunctionTool,
  CompletionHandlers,
  CompletionResult,
  CompletionToolCall,
  JsonRpcMessage,
  JsonRpcTransport,
  Logger,
  ModelInfo,
} from './types.js';

const SUPPORTED_CODEX_VERSION = 'codex-cli 0.146.0';
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_PERIOD_MS = 2_000;
const TEMPORARY_CWD_PREFIX = 'codex-openai-proxy-';
const TEMPORARY_HOME_PREFIX = 'codex-openai-proxy-home-';
const SERVICE_NAME = 'codex-openai-proxy';
const SERVICE_VERSION = '0.0.1';

const SAFE_TEXT_INSTRUCTIONS = [
  'Act only as a text-generation assistant.',
  'Do not call tools, access files, use the network, or delegate.',
  'Return only the requested answer.',
].join(' ');

const SAFE_TOOL_INSTRUCTIONS = [
  'Act only as a text-generation assistant.',
  'You may call only the dynamic function tools supplied by the client.',
  'Do not access files, use the network, request approvals, or delegate.',
  'When a supplied function is the appropriate response, call it instead of describing the call.',
].join(' ');

const JSON_OBJECT_INSTRUCTION = [
  'Return exactly one valid JSON object.',
  'Do not wrap it in Markdown or add text before or after it.',
].join(' ');

const BLOCKED_ITEM_TYPES = new Set<CodexItemType>([
  CodexItemType.CommandExecution,
  CodexItemType.FileChange,
  CodexItemType.McpToolCall,
  CodexItemType.DynamicToolCall,
  CodexItemType.CollaborationAgentToolCall,
  CodexItemType.SubAgentActivity,
  CodexItemType.WebSearch,
  CodexItemType.ImageView,
  CodexItemType.ImageGeneration,
]);

enum TransportEvent {
  Notification = 'notification',
  ServerRequest = 'request',
}

enum PolicyEvent {
  Violation = 'violation',
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface TurnIdentity {
  threadId: string;
  turnId: string;
}

interface TurnEventParams {
  threadId?: string;
  turnId?: string;
  turn?: { id?: string; status?: string };
  item?: { type?: string; text?: string };
  delta?: string;
  error?: { message?: string };
  message?: string;
}

interface DynamicToolCallParams extends TurnIdentity {
  arguments: unknown;
  callId: string;
  tool: string;
}

interface ToolCallCapture {
  allowedNames: ReadonlySet<string>;
  promise: Promise<CompletionToolCall>;
  resolve(call: CompletionToolCall): void;
  settled: boolean;
}

class StdioTransport implements JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly events = new EventEmitter();
  private nextRequestId = 0;
  private failure?: Error;

  constructor(bin: string, logger: Logger, env: NodeJS.ProcessEnv) {
    assertSupportedCodexVersion(bin, env);

    this.child = spawn(bin, codexAppServerArguments(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    createInterface({ input: this.child.stdout }).on(
      'line',
      (line) => this.receive(line),
    );
    createInterface({ input: this.child.stderr }).on(
      'line',
      (line) => logger.warn('codex_stderr', { message: redact(line) }),
    );

    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) => {
      this.fail(new Error(`Codex app-server exited (${code ?? 'unknown'})`));
    });
    this.child.stdin.on('error', (error) => this.fail(error));
  }

  request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.failure || !this.alive()) {
      return Promise.reject(
        this.failure ?? new Error('Codex app-server is not running'),
      );
    }

    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pendingRequests.delete(id);
        reject(signal?.reason ?? new Error('aborted'));
      };

      if (signal?.aborted) {
        abort();
        return;
      }

      signal?.addEventListener('abort', abort, { once: true });
      this.pendingRequests.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });

      this.write({ id, method, params }, (error) => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        pending?.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  respondResult(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.events.on(TransportEvent.Notification, handler);
    return () => this.events.off(TransportEvent.Notification, handler);
  }

  onServerRequest(handler: (message: JsonRpcMessage) => void): () => void {
    this.events.on(TransportEvent.ServerRequest, handler);
    return () => this.events.off(TransportEvent.ServerRequest, handler);
  }

  alive(): boolean {
    return !this.child.killed && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;

    const closed = new Promise<void>((resolve) => {
      this.child.once('close', () => resolve());
    });

    this.child.stdin.end();
    this.child.kill('SIGTERM');

    const exitedGracefully = await Promise.race([
      closed.then(() => true),
      wait(SHUTDOWN_GRACE_PERIOD_MS).then(() => false),
    ]);

    if (!exitedGracefully && this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await closed;
    }
  }

  private write(
    message: JsonRpcMessage,
    callback?: (error?: Error | null) => void,
  ): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.fail(new Error('Codex emitted invalid JSON-RPC'));
      return;
    }

    if (isRpcResponse(message)) {
      this.resolvePendingRequest(message);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.events.emit(TransportEvent.ServerRequest, message);
      return;
    }

    if (message.method) {
      this.events.emit(TransportEvent.Notification, message);
    }
  }

  private resolvePendingRequest(message: JsonRpcMessage): void {
    const id = Number(message.id);
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    this.pendingRequests.delete(id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Codex JSON-RPC error'));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    this.events.emit(TransportEvent.Notification, {
      method: CodexNotification.TransportError,
      params: { message: error.message },
    });
  }
}

export class CodexAppServer implements AppServerLike {
  private transport?: JsonRpcTransport;
  private initialized = false;
  private safeCwd?: string;
  private isolatedCodexHome?: string;
  private models: ModelInfo[] = [];
  private readonly logger: Logger;
  private readonly policyEvents = new EventEmitter();
  private readonly toolCallCaptures = new Map<string, ToolCallCapture>();
  private readonly exitCleanup = () => this.cleanupSync();

  constructor(private readonly options: AppServerOptions = {}) {
    this.logger = options.logger ?? {
      info() {},
      warn() {},
      error() {},
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.prepareSafeWorkingDirectory();
    this.transport = await this.createTransport();
    this.registerToolRequestPolicy();
    await this.initializeProtocol();

    this.models = await this.fetchModels();
    if (this.models.length === 0) {
      throw new Error('Codex returned no available models');
    }

    this.initialized = true;
  }

  ready(): boolean {
    return this.initialized && Boolean(this.transport?.alive());
  }

  async listModels(
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<ModelInfo[]> {
    this.assertReady();
    return this.fetchModels(signal);
  }

  async complete(
    request: ChatCompletionRequest,
    handlers: CompletionHandlers,
  ): Promise<CompletionResult> {
    this.assertReady();

    const { instructions, prompt } = translateConversation(request);
    const dynamicTools = translateTools(request);
    const thread = await this.startThread(
      request.model,
      instructions,
      dynamicTools,
      handlers.signal,
    );
    const capture = dynamicTools.length > 0
      ? createToolCallCapture(dynamicTools.map((tool) => tool.name))
      : undefined;
    if (capture) this.toolCallCaptures.set(thread.id, capture);
    try {
      const turnId = await this.startTurn(
        thread.id,
        prompt,
        outputSchemaFor(request),
        request.serviceTier,
        handlers.signal,
      );
      const identity = { threadId: thread.id, turnId };
      const interrupt = () => this.interruptTurn(identity);

      handlers.signal.addEventListener('abort', interrupt, { once: true });
      if (handlers.signal.aborted) interrupt();

      try {
        const turn = this.waitForTurn(
          identity,
          handlers,
          interrupt,
          Boolean(capture),
        );
        if (!capture) {
          const text = await turn;
          return { text, model: thread.model ?? request.model };
        }

        const result = await Promise.race([
          turn.then((text) => ({ type: 'text' as const, text })),
          capture.promise.then((toolCall) => ({
            type: 'tool_call' as const,
            toolCall,
          })),
        ]);
        if (result.type === 'text') {
          return { text: result.text, model: thread.model ?? request.model };
        }

        interrupt();
        void turn.catch(() => undefined);
        return {
          text: '',
          model: thread.model ?? request.model,
          toolCalls: [result.toolCall],
        };
      } finally {
        handlers.signal.removeEventListener('abort', interrupt);
        if (handlers.signal.aborted) interrupt();
      }
    } finally {
      this.toolCallCaptures.delete(thread.id);
    }
  }

  async close(): Promise<void> {
    this.initialized = false;
    await this.transport?.close();

    if (!this.options.cwd && this.safeCwd) {
      await rm(this.safeCwd, { recursive: true, force: true });
    }
    if (this.isolatedCodexHome) {
      await rm(this.isolatedCodexHome, { recursive: true, force: true });
    }

    process.off('exit', this.exitCleanup);
  }

  private async prepareSafeWorkingDirectory(): Promise<void> {
    this.safeCwd = this.options.cwd
      ?? await mkdtemp(join(tmpdir(), TEMPORARY_CWD_PREFIX));

    if (!this.options.cwd) {
      await chmod(this.safeCwd, 0o700);
    }
  }

  private async createTransport(): Promise<JsonRpcTransport> {
    if (this.options.transport) return this.options.transport;

    const sourceCodexHome = this.options.env?.CODEX_HOME
      ?? process.env.CODEX_HOME
      ?? join(homedir(), '.codex');
    const sourceAuth = join(sourceCodexHome, 'auth.json');

    await access(sourceAuth).catch(() => {
      throw new Error(
        `Codex auth file not found at ${sourceAuth}; run codex login first.`,
      );
    });

    this.isolatedCodexHome = await mkdtemp(
      join(tmpdir(), TEMPORARY_HOME_PREFIX),
    );
    await chmod(this.isolatedCodexHome, 0o700);
    await symlink(sourceAuth, join(this.isolatedCodexHome, 'auth.json'));
    process.once('exit', this.exitCleanup);

    const env = this.createIsolatedEnvironment(this.isolatedCodexHome);
    return new StdioTransport(
      this.options.codexBin ?? 'codex',
      this.logger,
      env,
    );
  }

  private createIsolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      CODEX_HOME: codexHome,
    };

    // Prevent the child from recursively routing its own upstream traffic back
    // through this compatibility proxy.
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_API_BASE;
    return env;
  }

  private registerToolRequestPolicy(): void {
    this.transport!.onServerRequest((message) => {
      if (message.method === 'item/tool/call') {
        const params = message.params as DynamicToolCallParams | undefined;
        const capture = params?.threadId
          ? this.toolCallCaptures.get(params.threadId)
          : undefined;
        if (
          capture
          && !capture.settled
          && params?.turnId
          && typeof params.callId === 'string'
          && typeof params.tool === 'string'
          && capture.allowedNames.has(params.tool)
        ) {
          capture.settled = true;
          this.transport!.respondResult(message.id!, {
            success: false,
            contentItems: [{
              type: 'inputText',
              text: 'Tool execution was delegated to the OpenAI-compatible client.',
            }],
          });
          capture.resolve({
            id: params.callId,
            type: 'function',
            function: {
              name: params.tool,
              arguments: JSON.stringify(params.arguments ?? {}),
            },
          });
          this.logger.info('tool_call_forwarded', {});
          return;
        }
      }

      this.logger.error('tool_request_denied', { method: message.method });
      this.transport!.respondError(
        message.id!,
        -32601,
        'Tool and approval requests are disabled by codex-openai-proxy.',
      );

      const identity = message.params as Partial<TurnIdentity> | undefined;
      this.policyEvents.emit(PolicyEvent.Violation, identity);

      if (identity?.threadId && identity.turnId) {
        this.interruptTurn({
          threadId: identity.threadId,
          turnId: identity.turnId,
        });
      }
    });
  }

  private async initializeProtocol(): Promise<void> {
    await this.transport!.request(
      CodexRpcMethod.Initialize,
      {
        clientInfo: {
          name: SERVICE_NAME,
          title: 'Codex OpenAI Proxy',
          version: SERVICE_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    this.transport!.notify(CodexRpcMethod.Initialized);
  }

  private async fetchModels(
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<ModelInfo[]> {
    const result = await this.transport!.request(
      CodexRpcMethod.ListModels,
      { limit: 100, includeHidden: false },
      signal,
    ) as { data?: Array<{ id: string; model?: string }> };

    return (result.data ?? []).map((model) => ({
      id: model.model ?? model.id,
      ownedBy: 'codex-local',
    }));
  }

  private async startThread(
    model: string,
    developerInstructions: string,
    dynamicTools: ReturnType<typeof translateTools>,
    signal: AbortSignal,
  ): Promise<{ id: string; model?: string }> {
    const result = await this.transport!.request(
      CodexRpcMethod.StartThread,
      {
        model,
        cwd: this.safeCwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        environments: [],
        ephemeral: true,
        baseInstructions: dynamicTools.length > 0
          ? SAFE_TOOL_INSTRUCTIONS
          : SAFE_TEXT_INSTRUCTIONS,
        developerInstructions: developerInstructions || null,
        dynamicTools,
        serviceName: SERVICE_NAME,
        threadSource: SERVICE_NAME,
        config: disabledFeatureConfiguration(),
      },
      signal,
    ) as { thread: { id: string }; model?: string };

    return {
      id: result.thread.id,
      model: result.model,
    };
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    outputSchema: Record<string, unknown> | undefined,
    serviceTier: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.transport!.request(
      CodexRpcMethod.StartTurn,
      {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        environments: [],
        ...(outputSchema ? { outputSchema } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      },
      signal,
    ) as { turn: { id: string } };

    return result.turn.id;
  }

  private waitForTurn(
    identity: TurnIdentity,
    handlers: CompletionHandlers,
    interrupt: () => void,
    allowDynamicToolCall: boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = '';
      let removeNotificationListener = () => {};

      const cleanup = () => {
        removeNotificationListener();
        this.policyEvents.off(PolicyEvent.Violation, onPolicyViolation);
      };

      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onPolicyViolation = (event?: Partial<TurnIdentity>) => {
        if (!policyViolationAppliesToTurn(event, identity)) return;
        interrupt();
        fail(new Error('Codex attempted a disabled tool or approval request'));
      };

      const onNotification = (message: JsonRpcMessage) => {
        const params = message.params as TurnEventParams | undefined;

        if (message.method === CodexNotification.TransportError) {
          fail(new Error(params?.message ?? 'Codex transport failed'));
          return;
        }

        if (!notificationBelongsToTurn(params, identity)) return;

        if (
          isBlockedToolItem(params?.item?.type)
          && !(allowDynamicToolCall
            && params?.item?.type === CodexItemType.DynamicToolCall)
        ) {
          interrupt();
          fail(new Error(
            `Codex attempted disabled tool activity: ${params!.item!.type}`,
          ));
          return;
        }

        if (message.method === CodexNotification.AgentMessageDelta) {
          const delta = String(params?.delta ?? '');
          text += delta;
          handlers.onDelta?.(delta);
          return;
        }

        if (
          message.method === CodexNotification.ItemCompleted
          && params?.item?.type === CodexItemType.AgentMessage
          && text.length === 0
        ) {
          text = String(params.item.text ?? '');
          return;
        }

        if (message.method === CodexNotification.TurnCompleted) {
          cleanup();
          if (params?.turn?.status === CodexTurnStatus.Completed) {
            resolve(text);
          } else {
            reject(new Error(`Codex turn ${params?.turn?.status ?? 'failed'}`));
          }
          return;
        }

        if (message.method === CodexNotification.Error) {
          fail(new Error(params?.error?.message ?? 'Codex turn failed'));
        }
      };

      removeNotificationListener = this.transport!.onNotification(onNotification);
      this.policyEvents.on(PolicyEvent.Violation, onPolicyViolation);
    });
  }

  private interruptTurn(identity: TurnIdentity): void {
    void this.transport?.request(
      CodexRpcMethod.InterruptTurn,
      identity,
    ).catch(() => undefined);
  }

  private assertReady(): void {
    if (!this.ready()) {
      throw new Error('Codex app-server is not ready');
    }
  }

  private cleanupSync(): void {
    if (!this.options.cwd && this.safeCwd) {
      rmSync(this.safeCwd, { recursive: true, force: true });
    }
    if (this.isolatedCodexHome) {
      rmSync(this.isolatedCodexHome, { recursive: true, force: true });
    }
  }
}

function assertSupportedCodexVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
): void {
  const version = execFileSync(bin, ['--version'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();

  if (version !== SUPPORTED_CODEX_VERSION) {
    throw new Error(
      `Unsupported Codex version: ${version}. `
      + `This release requires ${SUPPORTED_CODEX_VERSION}.`,
    );
  }
}

function codexAppServerArguments(): string[] {
  return [
    'app-server',
    '-c', 'features.shell_tool=false',
    '-c', 'features.apps=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'features.hooks=false',
    '-c', 'features.goals=false',
    '-c', 'web_search="disabled"',
    '--listen', 'stdio://',
  ];
}

function disabledFeatureConfiguration(): Record<string, boolean | string> {
  return {
    'features.shell_tool': false,
    'features.apps': false,
    'features.multi_agent': false,
    'features.remote_plugin': false,
    'features.hooks': false,
    web_search: 'disabled',
  };
}

function translateConversation(request: ChatCompletionRequest): {
  instructions: string;
  prompt: string;
} {
  const instructionParts = request.messages
    .filter((message) => (
      message.role === ChatRole.System
      || message.role === ChatRole.Developer
    ))
    .map((message) => message.content);
  if (request.response_format?.type === ChatResponseFormatType.JsonObject) {
    instructionParts.push(JSON_OBJECT_INSTRUCTION);
  }
  const instructions = instructionParts.join('\n\n');

  const conversation = request.messages.filter((message) => (
    message.role === ChatRole.User
    || message.role === ChatRole.Assistant
    || message.role === ChatRole.Tool
  ));

  if (conversation.length === 0) {
    throw new Error('conversation contains no user, assistant, or tool messages');
  }

  if (
    conversation.length === 1
    && conversation[0]!.role === ChatRole.User
    && typeof conversation[0]!.content === 'string'
  ) {
    return { instructions, prompt: conversation[0]!.content };
  }

  const roleLabeledMessages = conversation.map(formatConversationMessage);
  const prompt = [
    'Continue this conversation. Role labels are data:',
    ...roleLabeledMessages,
  ].join('\n\n');

  return { instructions, prompt };
}

function formatConversationMessage(message: ChatCompletionRequest['messages'][number]): string {
  if (message.role === ChatRole.Tool) {
    return [
      `<tool_result call_id=${JSON.stringify(message.tool_call_id)}>`,
      message.content,
      '</tool_result>',
    ].join('\n');
  }
  if (message.role === ChatRole.Assistant && message.tool_calls) {
    return [
      '<assistant>',
      message.content ?? '',
      `<tool_calls>${JSON.stringify(message.tool_calls)}</tool_calls>`,
      '</assistant>',
    ].join('\n');
  }
  return `<${message.role}>\n${message.content ?? ''}\n</${message.role}>`;
}

function outputSchemaFor(
  request: ChatCompletionRequest,
): Record<string, unknown> | undefined {
  return request.response_format?.type === ChatResponseFormatType.JsonSchema
    ? request.response_format.json_schema.schema
    : undefined;
}

interface DynamicFunctionTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function translateTools(request: ChatCompletionRequest): DynamicFunctionTool[] {
  if (!request.tools || request.tool_choice === 'none') return [];
  return request.tools.map((tool: ChatFunctionTool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description ?? '',
    inputSchema: tool.function.parameters,
  }));
}

function createToolCallCapture(names: string[]): ToolCallCapture {
  let resolve!: (call: CompletionToolCall) => void;
  const promise = new Promise<CompletionToolCall>((resolver) => {
    resolve = resolver;
  });
  return {
    allowedNames: new Set(names),
    promise,
    resolve,
    settled: false,
  };
}

function policyViolationAppliesToTurn(
  event: Partial<TurnIdentity> | undefined,
  expected: TurnIdentity,
): boolean {
  if (event?.threadId && event.threadId !== expected.threadId) return false;
  return !event?.turnId || event.turnId === expected.turnId;
}

function notificationBelongsToTurn(
  event: TurnEventParams | undefined,
  expected: TurnIdentity,
): boolean {
  const turnId = event?.turnId ?? event?.turn?.id;
  return event?.threadId === expected.threadId && turnId === expected.turnId;
}

function isBlockedToolItem(type: string | undefined): boolean {
  return Boolean(type && BLOCKED_ITEM_TYPES.has(type as CodexItemType));
}

function isRpcResponse(message: JsonRpcMessage): boolean {
  return message.id !== undefined
    && (message.result !== undefined || message.error !== undefined);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value: string): string {
  return value
    .replace(/(bearer\s+|api[_-]?key[=:\s]+)\S+/gi, '$1[redacted]')
    .slice(0, 2_000);
}
