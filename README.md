# codex-openai-proxy

An **unofficial, experimental** local adapter that exposes a small OpenAI-compatible HTTP surface backed by your already-authenticated Codex CLI app-server.

This project is not affiliated with, endorsed by, or supported by OpenAI. It is not a local model: prompts still go to OpenAI through Codex and consume the account's Codex/ChatGPT entitlement and limits. It does not turn a ChatGPT subscription into OpenAI API credits or API terms.

## Quick start

Requirements: Node.js 22+ recommended (the proxy runtime supports 20+), `codex-cli 0.146.0`, and a working file-backed `codex` login. The exact version gate is intentional because app-server is experimental; each new Codex version needs regenerated protocol evidence and runtime security tests before support is widened. The desktop app is not required.

This branch prepares **0.0.2**. The older `v0.0.1` tag does not include JSON-object or function-tool support. Until 0.0.2 is tagged, install this feature branch or the exact commit reported in its PR:

```bash
npm install github:uncoooloj/codex-openai-proxy#feat/private-server-mvp openai@7.4.0
npx codex-openai-proxy
```

Run those commands from the project that will use the adapter. For repeatable deployments, replace the branch with a reviewed commit SHA and retain your package-lock.json. The scoped npm package is not currently published. Direct `npx github:...` installs are not recommended because some npm releases can fail while packing Git dependencies. The `openai` package is needed by the client examples, not by the proxy runtime.

On startup the proxy prints shell exports containing a freshly generated local adapter token:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18080/v1
export OPENAI_API_KEY=<generated-local-adapter-token>
```

Then use an official client normally:

```js
import OpenAI from "openai";

const client = new OpenAI();
const result = await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "Explain this error in one paragraph." }],
});
console.log(result.choices[0].message.content);
```

The unscoped npm name `codex-openai-proxy` belongs to another project, so this repository intentionally uses the scoped package `@uncoooloj/codex-openai-proxy`.

## Status and configuration

```bash
codex-openai-proxy status
curl http://127.0.0.1:18080/healthz
curl http://127.0.0.1:18080/readyz
```

Precedence is command-line flag, then environment variable, then default.

| Flag | Environment | Default |
|---|---|---|
| `--host` | `CODEX_PROXY_HOST` | `127.0.0.1` (other values are refused) |
| `--port` | `CODEX_PROXY_PORT` | `18080` |
| `--token` | `CODEX_PROXY_TOKEN` | random 256-bit token per start |
| `--token-file` | `CODEX_PROXY_TOKEN_FILE` | none; securely creates or reads a persistent owner-only token file |
| `--codex-bin` | `CODEX_PROXY_CODEX_BIN` | `codex` |
| `--body-limit` | `CODEX_PROXY_BODY_LIMIT` | `1048576` bytes |
| `--timeout` | `CODEX_PROXY_TIMEOUT_MS` | `120000` ms |
| `--startup-timeout` | `CODEX_PROXY_STARTUP_TIMEOUT_MS` | `60000` ms, total Codex startup deadline |
| `--max-concurrency` | `CODEX_PROXY_MAX_CONCURRENCY` | `1` |

The process runs in the foreground and handles `SIGINT`/`SIGTERM`, including during startup. Backend death exits nonzero so an external service manager can restart it. In-flight requests are not replayed. Status checks have a five-second deadline.

For repeatable starts use `--token-file ./adapter.token` in a private directory. Its parent must already exist. The proxy creates a new file with mode `0600`, or requires an existing regular file owned by the current user with no group/other permissions. It rejects symlinks. File-backed and supplied tokens are never printed; an ephemeral generated token is printed once. Do not provide both token and token-file at the same precedence level. Explicit token flags override token environment variables. Unknown flags, missing values, and invalid ports fail at startup.

See [Private Linux server setup](docs/server.md) for headless authentication, a systemd user service, private remote access, and rollback.

## Verify your installation

With the proxy running and `CODEX_PROXY_TOKEN_FILE` set to its token path:

```bash
node node_modules/@uncoooloj/codex-openai-proxy/examples/smoke.mjs
```

The smoke client uses the official OpenAI JavaScript SDK. It checks text, SSE, strict JSON Schema, JSON-object output, and a bounded client-owned coding tool loop: inspect a synthetic fixture, run its failing test, repair it through an exact allowlist, and run the passing test. It also checks that a hostile request cannot create a canary file. Run it on the proxy host for the filesystem check to be meaningful. It uses your Codex entitlement, prints a sanitized summary, exits nonzero on failure, and removes its synthetic workspace.

`PROXY_SMOKE_MODEL` selects a model returned by `/v1/models`; otherwise the client chooses one. `PROXY_SMOKE_SECTIONS` can select comma-separated `text,sse,schema,json,tools,hostile`, and `PROXY_SMOKE_TIMEOUT_MS` bounds each call. This fixture proves the supported tool loop, not compatibility with every coding client.

## Compatibility

| Surface | Status | Notes |
|---|---|---|
| `GET /healthz` | Supported | HTTP process liveness |
| `GET /readyz` | Supported | app-server initialized and model discovery succeeded |
| `GET /v1/models` | Supported | current Codex model list; bearer token required |
| `POST /v1/chat/completions` | Supported, text only | one ephemeral Codex thread per request; `n=1` |
| Chat Completions JSON Schema | Supported | `response_format.type="json_schema"` with `strict: true`; schema is passed to Codex `turn/start.outputSchema` |
| Chat Completions JSON object | Supported, validated | JSON-only instructions are added and the final value is parsed and required to be an object before returning it |
| Function tools | Experimental | function tools become Codex dynamic tools; calls are forwarded as OpenAI `tool_calls` and are never executed by this adapter |
| Tool-result history | Supported | assistant `tool_calls` and `tool` result messages are translated into the next ephemeral Codex prompt |
| `serviceTier` | `flex` only | the camel-case Chat Completions field is passed to Codex `turn/start.serviceTier` |
| Chat Completions SSE | Experimental | text deltas, terminal chunk, `[DONE]`, disconnect interruption |
| `/v1/responses` | Not supported | agent items do not map faithfully enough yet |
| Images/audio | Not supported | rejected |
| Sampling controls and usage | Not supported | `max_tokens` is accepted as a compatibility hint but is not enforced; Codex does not expose authoritative OpenAI token accounting here |

This is semantic compatibility for a narrow integration surface, not a drop-in implementation of the full OpenAI API.

Strict JSON Schema requests use the standard Chat Completions shape:

```js
const result = await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "Extract memories." }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "memory_result",
      strict: true,
      schema: {
        type: "object",
        properties: { memories: { type: "array", items: { type: "string" } } },
        required: ["memories"],
        additionalProperties: false,
      },
    },
  },
});
```

The returned `message.content` is still a JSON string, matching Chat Completions. The adapter requires `strict: true`, validates the wrapper, and forwards only `json_schema.schema` as the current turn's Codex output schema. Omitted or false strictness is rejected because Codex would still enforce `outputSchema`.

JSON object mode cannot use a generic Codex output schema because Codex rejects that schema. The adapter instead adds a JSON-only instruction and parses the final message before returning it. Invalid JSON, arrays, and scalar values fail with `502`; streaming JSON object mode is rejected because the complete payload cannot be validated first.

Function tools are mapped to Codex `thread/start.dynamicTools`. When Codex requests `item/tool/call`, the adapter does not execute it. It interrupts the ephemeral Codex turn and returns the call as a standard Chat Completions `message.tool_calls` response with `finish_reason: "tool_calls"`. Only the client-declared function name and JSON arguments are forwarded. `tool_choice: "auto"` and `"none"` are accepted; `"required"`, specific-function selection, parallel calls in one response, streaming tool calls, legacy `functions`, and non-function tools are not supported.

## Security model

- The HTTP server refuses non-loopback binding and requires a separate bearer token on `/v1/*`.
- It never parses, copies, logs, or returns raw Codex/ChatGPT credentials. A private mode-0700 `CODEX_HOME` contains only a temporary symlink to the existing `auth.json`; both are removed on shutdown.
- It owns a private `codex app-server --listen stdio://` subprocess instead of attaching to the desktop app or shared daemon.
- Each request gets an ephemeral Codex thread in a mode-0700 empty temporary directory, with experimental `environments: []` disabling the execution environment at both thread and turn scope.
- Static user config, hooks, and memories are excluded by the private `CODEX_HOME`. Shell, apps, web search, remote plugins, and multi-agent features are disabled; the sandbox is read-only and approvals are `never`.
- Client-declared dynamic function calls are forwarded but never executed by the adapter. Any undeclared dynamic tool, command, file change, MCP call, web action, delegation, approval, or other server tool request fails closed. Request bodies and bearer tokens are excluded from structured request logs; a generated adapter token is printed once to the local operator at startup.
- Request-shape diagnostics contain only allowlisted wrapper field names, counts of unknown fields, normalized schema/tier categories, and categorical tool count/type/choice metadata. Prompt text, unknown key names, tool or schema names, schema property names, descriptions, and arbitrary values are not logged.
- Body size, upload deadline, completion timeout, and concurrency are bounded. Partial uploads return `408`, oversized uploads return `413`, and excess concurrency returns `429` instead of silently queueing. The upload and completion each have a separate `--timeout` budget.

Codex app-server remains an experimental protocol. A future Codex version may change behavior. Treat a version upgrade as a security-sensitive change and rerun the real hostile-prompt test. See [SECURITY.md](SECURITY.md) and [ADR 0001](docs/adr/0001-architecture.md).

Codex 0.146.0 was observed synchronizing authenticated plugin metadata and attempting stale plugin MCP OAuth refreshes during startup even with the private home and plugin/tool feature flags. No tool was offered or executed in the hostile-prompt probe, but startup is not guaranteed to be free of Codex-managed plugin network activity.

### Recursion warning

Do not configure Codex's upstream OpenAI base URL to point at this proxy. The child process removes common upstream base-URL variables. Memory systems and Codex plugins can also create semantic recursion—for example, a memory extraction turn being captured as new memory. Use a separate scope/container and exclude proxy-generated sessions from automatic capture.

## Development

```bash
npm install
npm run typecheck
npm test
```

### Code map

| File | Responsibility |
|---|---|
| `src/constants.ts` | Closed protocol and configuration value sets |
| `src/config.ts` | CLI arguments, environment precedence, and safe defaults |
| `src/app-server.ts` | Codex process lifecycle, JSON-RPC transport, and turn isolation |
| `src/server.ts` | HTTP routing, OpenAI response translation, and concurrency limits |
| `src/cli.ts` | Foreground process startup, status, and graceful shutdown |
| `src/types.ts` | Public interfaces shared across those boundaries |

The contract suite uses the official `openai` JavaScript client against an in-process fake Codex backend. Release verification additionally requires a real installed-Codex smoke test.

See [Prior art](docs/prior-art.md), [ADR 0002](docs/adr/0002-chat-completions-json-schema.md) for strict structured output, and [ADR 0003](docs/adr/0003-chat-completions-json-tools.md) for JSON-object and tool-call compatibility.

## License

MIT
