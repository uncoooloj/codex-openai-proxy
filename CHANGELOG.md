# Changelog

## Unreleased

- Accept strict Chat Completions `response_format.type="json_schema"` requests.
- Pass the requested schema to Codex as the current turn's `outputSchema`.
- Pass Supermemory's evidenced `serviceTier: "flex"` field to Codex.
- Keep JSON object mode, tools/functions, multimodal input, and the Responses API explicitly unsupported.
- Log only non-content schema metadata for structured-output diagnostics.

## 0.0.1 - 2026-08-07

Initial experimental release.

- OpenAI-compatible model listing and text Chat Completions.
- Experimental Chat Completions SSE streaming with cancellation.
- Loopback-only bearer authentication and bounded request handling.
- Private, version-gated Codex app-server supervision.
- Ephemeral read-only Codex threads with fail-closed tool handling.
- Explicit compatibility and security documentation.
