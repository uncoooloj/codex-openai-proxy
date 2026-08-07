# codex-openai-proxy

An **unofficial, experimental** local adapter that exposes a small OpenAI-compatible HTTP surface backed by your already-authenticated Codex CLI app-server.

This project is not affiliated with, endorsed by, or supported by OpenAI. It is not a local model: prompts still go to OpenAI through Codex and consume the account's Codex/ChatGPT entitlement and limits. It does not turn a ChatGPT subscription into OpenAI API credits or API terms.

## Quick start

Requirements: Node.js 20+, `codex-cli 0.146.0`, and a working `codex` login. The exact version gate is intentional because app-server is experimental; each new Codex version needs regenerated protocol evidence and runtime security tests before support is widened.

```bash
npx github:uncoooloj/codex-openai-proxy#feat/openai-compatible-mvp
```

That command installs the current pull-request branch directly from GitHub. After the scoped package is published, the shorter command will be `npx @uncoooloj/codex-openai-proxy`.

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
| `--codex-bin` | `CODEX_PROXY_CODEX_BIN` | `codex` |
| `--body-limit` | `CODEX_PROXY_BODY_LIMIT` | `1048576` bytes |
| `--timeout` | `CODEX_PROXY_TIMEOUT_MS` | `120000` ms |
| `--max-concurrency` | `CODEX_PROXY_MAX_CONCURRENCY` | `1` |

The process runs in the foreground and handles `SIGINT`/`SIGTERM`. A background daemon, launchd plist, and systemd unit are deferred until the protocol and upgrade lifecycle are more mature.

## Compatibility

| Surface | Status | Notes |
|---|---|---|
| `GET /healthz` | Supported | HTTP process liveness |
| `GET /readyz` | Supported | app-server initialized and model discovery succeeded |
| `GET /v1/models` | Supported | current Codex model list; bearer token required |
| `POST /v1/chat/completions` | Supported, text only | one ephemeral Codex thread per request; `n=1` |
| Chat Completions SSE | Experimental | text deltas, terminal chunk, `[DONE]`, disconnect interruption |
| `/v1/responses` | Not supported | agent items do not map faithfully enough yet |
| Tools/functions | Not supported | rejected; no tool-call emulation |
| Images/audio | Not supported | rejected |
| Structured outputs | Not supported | rejected rather than approximated |
| Sampling controls and usage | Not supported | Codex does not expose faithful equivalents or authoritative OpenAI token accounting here |

This is semantic compatibility for a narrow integration surface, not a drop-in implementation of the full OpenAI API.

## Security model

- The HTTP server refuses non-loopback binding and requires a separate bearer token on `/v1/*`.
- It never parses, copies, logs, or returns raw Codex/ChatGPT credentials. A private mode-0700 `CODEX_HOME` contains only a temporary symlink to the existing `auth.json`; both are removed on shutdown.
- It owns a private `codex app-server --listen stdio://` subprocess instead of attaching to the desktop app or shared daemon.
- Each request gets an ephemeral Codex thread in a mode-0700 empty temporary directory, with experimental `environments: []` disabling the execution environment at both thread and turn scope.
- Static user config, hooks, and memories are excluded by the private `CODEX_HOME`. Shell, apps, web search, remote plugins, and multi-agent features are disabled; the sandbox is read-only and approvals are `never`.
- Any observed tool item or server approval/tool request fails the request. Request bodies and bearer tokens are excluded from structured request logs; a generated adapter token is printed once to the local operator at startup.
- Body size, timeout, and concurrency are bounded. Excess concurrency returns `429` instead of silently queueing.

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

See [Prior art](docs/prior-art.md) for related projects, lessons adopted, and why this implementation remains deliberately narrower.

## License

MIT
