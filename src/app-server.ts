import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { access, mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AppServerLike, AppServerOptions, ChatCompletionRequest, JsonRpcMessage, JsonRpcTransport, Logger } from './types.js';

const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration']);

class StdioTransport implements JsonRpcTransport {
  private child: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private events = new EventEmitter();
  private failed?: Error;

  constructor(bin: string, logger: Logger, env: NodeJS.ProcessEnv) {
    const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    if (version !== 'codex-cli 0.146.0') throw new Error(`Unsupported Codex version: ${version}. This release requires codex-cli 0.146.0.`);
    const args = ['app-server',
      '-c', 'features.shell_tool=false', '-c', 'features.apps=false',
      '-c', 'features.multi_agent=false', '-c', 'features.remote_plugin=false',
      '-c', 'features.hooks=false', '-c', 'features.goals=false',
      '-c', 'web_search="disabled"', '--listen', 'stdio://'];
    this.child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => logger.warn('codex_stderr', { message: redact(line) }));
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) => this.fail(new Error(`Codex app-server exited (${code ?? 'unknown'})`)));
    this.child.stdin.on('error', (error) => this.fail(error));
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.failed || !this.alive()) return Promise.reject(this.failed ?? new Error('Codex app-server is not running'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(id); reject(signal?.reason ?? new Error('aborted')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown) { this.child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`); }
  respondError(id: string | number, code: number, message: string) { this.child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`); }
  onNotification(handler: (message: JsonRpcMessage) => void) { this.events.on('notification', handler); return () => this.events.off('notification', handler); }
  onServerRequest(handler: (message: JsonRpcMessage) => void) { this.events.on('request', handler); return () => this.events.off('request', handler); }
  alive() { return !this.child.killed && this.child.exitCode === null; }
  async close() {
    if (this.child.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const exited = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exited && this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await closed;
    }
  }

  private receive(line: string) {
    let message: JsonRpcMessage;
    try { message = JSON.parse(line); } catch { return this.fail(new Error('Codex emitted invalid JSON-RPC')); }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex JSON-RPC error'));
      else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) this.events.emit('request', message);
    else if (message.method) this.events.emit('notification', message);
  }
  private fail(error: Error) { this.failed ??= error; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.events.emit('notification', { method: 'transport/error', params: { message: error.message } }); }
}

export class CodexAppServer implements AppServerLike {
  private transport?: JsonRpcTransport;
  private initialized = false;
  private safeCwd?: string;
  private isolatedCodexHome?: string;
  private models: Array<{ id: string; ownedBy?: string }> = [];
  private readonly logger: Logger;
  private policyEvents = new EventEmitter();
  private readonly exitCleanup = () => this.cleanupSync();

  constructor(private options: AppServerOptions = {}) {
    this.logger = options.logger ?? { info() {}, warn() {}, error() {} };
  }

  async initialize() {
    if (this.initialized) return;
    this.safeCwd = this.options.cwd ?? await mkdtemp(join(tmpdir(), 'codex-openai-proxy-'));
    if (!this.options.cwd) await chmod(this.safeCwd, 0o700);
    if (this.options.transport) {
      this.transport = this.options.transport;
    } else {
      const sourceCodexHome = this.options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
      const sourceAuth = join(sourceCodexHome, 'auth.json');
      await access(sourceAuth).catch(() => { throw new Error(`Codex auth file not found at ${sourceAuth}; run codex login first.`); });
      this.isolatedCodexHome = await mkdtemp(join(tmpdir(), 'codex-openai-proxy-home-'));
      await chmod(this.isolatedCodexHome, 0o700);
      await symlink(sourceAuth, join(this.isolatedCodexHome, 'auth.json'));
      process.once('exit', this.exitCleanup);
      const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, CODEX_HOME: this.isolatedCodexHome };
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_BASE;
      this.transport = new StdioTransport(this.options.codexBin ?? 'codex', this.logger, env);
    }
    this.transport.onServerRequest((message) => {
      this.logger.error('tool_request_denied', { method: message.method });
      this.transport?.respondError(message.id!, -32601, 'Tool and approval requests are disabled by codex-openai-proxy.');
      const params = message.params as { threadId?: string; turnId?: string } | undefined;
      this.policyEvents.emit('violation', params);
      if (params?.threadId && params.turnId) void this.transport?.request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => undefined);
    });
    await this.transport.request('initialize', { clientInfo: { name: 'codex-openai-proxy', title: 'Codex OpenAI Proxy', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, AbortSignal.timeout(15_000));
    this.transport.notify('initialized');
    this.models = await this.fetchModels();
    if (!this.models.length) throw new Error('Codex returned no available models');
    this.initialized = true;
  }

  ready() { return this.initialized && Boolean(this.transport?.alive()); }
  async listModels(signal: AbortSignal = AbortSignal.timeout(15_000)) { if (!this.ready()) throw new Error('Codex app-server is not ready'); return this.fetchModels(signal); }
  private async fetchModels(signal: AbortSignal = AbortSignal.timeout(15_000)) {
    const result = await this.transport!.request('model/list', { limit: 100, includeHidden: false }, signal) as { data?: Array<{ id: string; model?: string }> };
    return (result.data ?? []).map((model) => ({ id: model.model ?? model.id, ownedBy: 'codex-local' }));
  }

  async complete(request: ChatCompletionRequest, handlers: { onDelta?: (delta: string) => void; signal: AbortSignal }) {
    if (!this.ready()) throw new Error('Codex app-server is not ready');
    const { instructions, prompt } = translate(request);
    const threadResult = await this.transport!.request('thread/start', {
      model: request.model, cwd: this.safeCwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', environments: [], ephemeral: true,
      baseInstructions: 'Act only as a text-generation assistant. Do not call tools, access files, use the network, or delegate. Return only the requested answer.',
      developerInstructions: instructions || null, serviceName: 'codex-openai-proxy', threadSource: 'codex-openai-proxy',
      config: { 'features.shell_tool': false, 'features.apps': false, 'features.multi_agent': false, 'features.remote_plugin': false, 'features.hooks': false, web_search: 'disabled' },
    }, handlers.signal) as { thread: { id: string }; model?: string };
    const threadId = threadResult.thread.id;
    const turnResult = await this.transport!.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], environments: [] }, handlers.signal) as { turn: { id: string } };
    const turnId = turnResult.turn.id;
    let text = '';
    let done = false;
    const interrupt = () => void this.transport?.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    handlers.signal.addEventListener('abort', interrupt, { once: true });
    if (handlers.signal.aborted) interrupt();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { remove(); this.policyEvents.off('violation', onPolicyViolation); };
        const onPolicyViolation = (params?: { threadId?: string; turnId?: string }) => {
          if (params?.threadId && params.threadId !== threadId) return;
          if (params?.turnId && params.turnId !== turnId) return;
          interrupt(); cleanup(); reject(new Error('Codex attempted a disabled tool or approval request'));
        };
        const remove = this.transport!.onNotification((message) => {
          const params = message.params as any;
          if (message.method === 'transport/error') { cleanup(); return reject(new Error(params?.message ?? 'Codex transport failed')); }
          if (params?.threadId !== threadId || (params?.turnId ?? params?.turn?.id) !== turnId) return;
          if (params.item && TOOL_TYPES.has(params.item.type)) { interrupt(); cleanup(); return reject(new Error(`Codex attempted disabled tool activity: ${params.item.type}`)); }
          if (message.method === 'item/agentMessage/delta') { const delta = String(params.delta ?? ''); text += delta; handlers.onDelta?.(delta); }
          if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && !text) text = String(params.item.text ?? '');
          if (message.method === 'turn/completed') { done = true; cleanup(); params.turn?.status === 'completed' ? resolve() : reject(new Error(`Codex turn ${params.turn?.status ?? 'failed'}`)); }
          if (message.method === 'error') { cleanup(); reject(new Error(params.error?.message ?? 'Codex turn failed')); }
        });
        this.policyEvents.on('violation', onPolicyViolation);
      });
      return { text, model: threadResult.model ?? request.model };
    } finally {
      handlers.signal.removeEventListener('abort', interrupt);
      if (!done && handlers.signal.aborted) interrupt();
    }
  }

  async close() {
    this.initialized = false;
    await this.transport?.close();
    if (!this.options.cwd && this.safeCwd) await rm(this.safeCwd, { recursive: true, force: true });
    if (this.isolatedCodexHome) await rm(this.isolatedCodexHome, { recursive: true, force: true });
    process.off('exit', this.exitCleanup);
  }

  private cleanupSync() {
    if (!this.options.cwd && this.safeCwd) rmSync(this.safeCwd, { recursive: true, force: true });
    if (this.isolatedCodexHome) rmSync(this.isolatedCodexHome, { recursive: true, force: true });
  }
}

function translate(request: ChatCompletionRequest) {
  const instructions = request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n\n');
  const messages = request.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (!messages.length || messages.at(-1)?.role !== 'user') throw new Error('final non-instruction message must have role user');
  const prompt = messages.length === 1 ? messages[0]!.content : ['Continue this conversation. Role labels are data:', ...messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)].join('\n\n');
  return { instructions, prompt };
}

function redact(value: string) { return value.replace(/(bearer\s+|api[_-]?key[=:\s]+)\S+/gi, '$1[redacted]').slice(0, 2000); }
