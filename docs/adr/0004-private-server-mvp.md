# ADR 0004: Basic private server operation

- Status: accepted for the 0.0.2 candidate
- Date: 2026-09-11

## Decision

Keep one private stdio Codex app-server and one ephemeral thread per HTTP request. Preserve loopback binding, client-owned tool execution, disabled native tools, and the exact CLI version gate. This remains a private model endpoint, not a job runner or multi-tenant inference service.

The server use case now justifies persistent token files, asynchronous bounded startup, deterministic configuration errors, bounded shutdown, process exit on backend failure, and a systemd user unit. This supersedes ADR 0001's deferral of service-manager guidance. Restart belongs to systemd; the proxy never replays an interrupted request automatically.

Use fail-fast overload responses instead of adding a queue or worker pool without workload evidence. Retain explicit Chat Completions history instead of adding a second conversation store. The smallest useful acceptance test is an official OpenAI client exercising text/JSON/SSE and a bounded client-owned coding tool loop against an authenticated Linux Codex process.

## Consequences

A private server can be reached through SSH forwarding without expanding the HTTP trust boundary. Persistent tokens survive restarts without being printed to service logs. Configuration fails before launch when a value is invalid. Cold start and child failure become observable process failures that a service manager can recover from.

Protocol compatibility, upstream account limits, and tool-call semantics still constrain clients. A container smoke establishes Linux runtime behavior; it does not establish a real systemd user's boot/logout lifecycle or compatibility with every third-party agent.
