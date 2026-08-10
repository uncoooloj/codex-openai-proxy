# ADR 0003: Chat Completions JSON-object and function-tool translation

- Status: accepted
- Date: 2026-08-10

## Context

OpenAI-compatible clients commonly use `response_format.type="json_object"` and function tools with `tool_choice: "auto"`. In a tool workflow, the model returns a tool call, the client executes the declared function, and the client sends the assistant tool-call plus tool-result messages back for the next model turn.

Codex app-server 0.146.0 does not accept a useful generic object-only `turn/start.outputSchema`. Its generated experimental protocol does expose `thread/start.dynamicTools`, the `item/tool/call` server request, and a structured dynamic-tool response. A real local probe confirmed that Codex calls a supplied dynamic function with JSON arguments.

## Decision

Support non-streaming JSON object mode by appending a JSON-only developer instruction, then parsing the complete Codex answer before returning it. Require a JSON object. Invalid JSON, arrays, and scalars fail with `502`. This is a validated compatibility implementation, not a claim that Codex natively implements OpenAI JSON mode.

Translate each validated OpenAI function tool into a Codex dynamic function tool. Accept `tool_choice: "auto"` and `"none"`. When Codex sends `item/tool/call` for an allowed function, acknowledge the app-server callback without executing the function, interrupt the ephemeral turn, and return the name and serialized arguments as an OpenAI `tool_calls` response. Undeclared tools and all other tool or approval requests continue to fail closed.

Accept standard assistant tool-call and tool-result messages. Because each HTTP request uses a new ephemeral Codex thread, encode that conversation history into the prompt as labeled data. The caller remains responsible for executing its function and supplying the result.

Accept a positive integer `max_tokens` as a compatibility hint, but do not claim enforcement because this Codex protocol exposes no corresponding turn parameter. Keep required or specific tool choice, parallel tool calls in one response, streaming tool calls, legacy `functions`, and non-function tools unsupported.

## Consequences

The adapter can support client-owned tool loops without gaining local execution authority. Tool arguments cross back to the trusted loopback client but are never passed to a shell, filesystem, MCP server, network tool, or approval path by the adapter.

The JSON object guarantee is implemented by instruction plus post-validation, so a model formatting failure becomes a bounded upstream error instead of malformed success. Tool workflows are sequential: one forwarded tool call ends one HTTP response, and the client submits its result in the next request.

The contract suite covers validation, dynamic-tool translation, callback forwarding, tool-result history, and fail-closed behavior. Runtime acceptance additionally requires a real Codex smoke using an OpenAI client, including JSON-object validation and a function-tool callback.
