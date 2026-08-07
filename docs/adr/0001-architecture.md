# ADR 0001: Private app-server compatibility adapter

- Status: accepted for experimental MVP
- Date: 2026-08-07

## Context

Codex app-server is a JSON-RPC agent-control protocol, not an OpenAI HTTP inference server. Consumers such as self-hosted memory products often accept an OpenAI-compatible base URL. The adapter must be useful without pretending the two contracts are identical.

## Decision

Ship a foreground TypeScript CLI which owns one long-lived private `codex app-server --listen stdio://` child and exposes a loopback-only HTTP server. Create one ephemeral Codex thread per Chat Completions request. Implement model listing, text Chat Completions, and evidence-backed SSE translation. Do not implement Responses API or tool compatibility until it can be faithful. Structured-output support was reconsidered after concrete protocol and consumer evidence; see ADR 0002.

### Daemon, foreground CLI, or library

The foreground CLI is the primary product and exports small library seams for tests/integration. A daemon adds lifecycle, upgrades, token persistence, and log ownership before they are justified. launchd/systemd guidance is deferred.

### Private app-server versus existing daemon/control socket

The proxy supervises its own subprocess. This gives it version, configuration, cancellation, stderr, restart, and shutdown ownership. Attaching to the desktop app's stdio is not possible. The managed daemon's default socket path is not part of the documented stable contract, and sharing it risks configuration and session interference.

### Transport

Stdio JSONL is the documented default and works on macOS and Linux. Unix sockets are useful for independent processes but add path/permission/lifecycle work. WebSocket is experimental and officially not recommended for production. HTTP Upgrade and WebSocket auth are unnecessary inside this single-process boundary.

### Authentication and networking

Bind only `127.0.0.1` and refuse overrides. Generate a 256-bit adapter bearer token when one is not supplied. Never parse, copy, log, or return Codex/ChatGPT credentials. A private mode-0700 `CODEX_HOME` contains only a temporary symlink to the existing `auth.json`; this lets the Codex child authenticate while excluding user configuration, and both are removed on shutdown.

### Isolation, concurrency, and cancellation

Every request receives an ephemeral thread and an empty mode-0700 temporary cwd. Default concurrency is one; overload returns `429`. HTTP disconnect and deadline aborts call `turn/interrupt`. Notifications are matched by thread and turn IDs to prevent cross-talk.

### Approvals, tools, and sandboxing

Plain model callers cannot answer Codex approval prompts safely. The private `CODEX_HOME` excludes static user config, hooks, and memories. The child additionally disables shell, apps, web search, remote plugins, and multi-agent features. Threads and turns use read-only sandboxing, approval policy `never`, and experimental `environments: []` to remove execution-environment access. Any tool item or server-initiated tool/approval request is a policy violation, not an OpenAI tool call. This invariant must be runtime-tested against every supported Codex version. Codex 0.146.0 still synchronized authenticated plugin metadata and attempted stale plugin MCP OAuth refreshes during startup; therefore startup is not claimed to be free of Codex-managed plugin network activity.

### API scope and translation

Chat Completions is the only generative endpoint. System/developer messages become Codex developer instructions; user/assistant history is serialized with explicit role markers because app-server cannot inject historical assistant messages. This is an approximation and is documented. `/v1/responses` is omitted because Codex reasoning, commands, approvals, file changes, and agent items cannot be represented faithfully. Sampling controls, usage, multimodal content, and tools are rejected rather than ignored. Chat Completions JSON Schema is supported only through the evidence-backed translation in ADR 0002.

### Streaming

App-server emits ordered `item/agentMessage/delta` notifications and a terminal `turn/completed`, so the adapter translates these to Chat Completions SSE chunks plus `[DONE]`. The HTTP response is not committed until the first delta, so immediate upstream failures remain ordinary JSON errors. Mid-stream adapter failure closes the stream because OpenAI's SSE format has no universally safe JSON error after headers. Disconnect triggers interruption.

### Portability

Node.js and stdio are portable across macOS/Linux. Actual sandbox enforcement remains Codex/platform-specific, so both platforms need authenticated smoke coverage before being claimed as release-tested.

### Subscription, terms, and recursion boundary

This is not a local model, an OpenAI API key, API billing, or entitlement conversion. It uses the locally authenticated Codex account and its limits. Users are responsible for applicable terms and data handling. Memory products can recursively capture their own extraction turns, particularly when installed as Codex plugins; isolate scopes and exclude proxy sessions from automatic capture.

## Alternatives rejected for the MVP

- `@openai/codex-sdk`: official and simpler, but wraps `codex exec` rather than exposing model discovery, app-server lifecycle, precise notification matching, and cancellation controls needed here.
- Shared daemon/control socket: lower process cost but weaker ownership/isolation and an undocumented default path.
- WebSocket listener: unsupported experimental transport with unnecessary network/auth surface.
- Full `/v1/responses` emulation: would misrepresent agent semantics.

## Consequences

The MVP is deliberately narrow, experimental, single-user, and version-sensitive. It accepts exactly `codex-cli 0.146.0`; widening that gate requires regenerated protocol evidence and runtime validation. Its main benefit is honest compatibility and strong local defaults; its cost is direct JSON-RPC maintenance.
