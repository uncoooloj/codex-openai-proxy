# Changelog

## 0.0.2 - candidate

- Add persistent owner-only token files and strict CLI configuration validation.
- Bound asynchronous startup, status, cancellation, uploads, and shutdown; exit on backend death for service-manager recovery.
- Keep configured bearer tokens and raw upstream startup errors out of service logs.
- Apply one explicit native-feature deny policy at process and thread startup; remove adapter credentials from the Codex child environment.
- Include a private Linux server guide, systemd user unit, and packaged OpenAI-client smoke with a client-owned coding tool loop.
- Preserve JSON-object tool-call responses and final-only SSE content.

- Accept strict Chat Completions `response_format.type="json_schema"` requests.
- Pass the requested schema to Codex as the current turn's `outputSchema`.
- Pass the Chat Completions `serviceTier: "flex"` field to Codex.
- Add validated, non-streaming Chat Completions JSON object mode.
- Translate function tools into Codex dynamic tools and forward calls without executing them.
- Accept assistant tool-call and tool-result history for multi-turn tool workflows.
- Keep legacy functions, required/specific tool choice, multimodal input, and the Responses API explicitly unsupported.
- Log only non-content schema metadata for structured-output diagnostics.

## 0.0.1 - 2026-08-07

Initial experimental release.

- OpenAI-compatible model listing and text Chat Completions.
- Experimental Chat Completions SSE streaming with cancellation.
- Loopback-only bearer authentication and bounded request handling.
- Private, version-gated Codex app-server supervision.
- Ephemeral read-only Codex threads with fail-closed tool handling.
- Explicit compatibility and security documentation.
