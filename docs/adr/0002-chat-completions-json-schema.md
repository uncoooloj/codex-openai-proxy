# ADR 0002: Chat Completions structured-output translation

- Status: superseded in part by ADR 0003
- Date: 2026-08-07

## Context

ADR 0001 rejected structured output until both sides exposed a faithful contract. The [Codex app-server documentation](https://developers.openai.com/codex/app-server/) defines `turn/start.outputSchema` as the JSON Schema that constrains the final assistant message for that turn, and the generated Codex CLI 0.146.0 protocol also exposes `turn/start.serviceTier`. The OpenAI [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs/) documents the Chat Completions wrapper translated here.

## Decision

Accept only this Chat Completions shape:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "response",
      "strict": true,
      "schema": {}
    }
  }
}
```

Require `strict: true`, validate the wrapper, and pass only `json_schema.schema` to Codex as `turn/start.outputSchema`. Omitted or false strictness is rejected because Codex would still enforce the schema. Return Codex's final agent-message text as `choices[0].message.content`, which remains a JSON string. The name and description are OpenAI request metadata; they are validated but not forwarded because Codex accepts the schema itself, not the OpenAI wrapper.

Accept only the camel-case `serviceTier: "flex"` value supported by the mapped Codex protocol and pass it to the same Codex turn. Reject other tier values rather than silently ignoring billing or latency semantics.

Keep `{ "type": "json_object" }` unsupported. A live request proved that `serviceTier: "flex"` works and that strict JSON Schema plus flex works, while Codex rejects the generic `{ "type": "object" }` output schema. Prompt-only JSON instructions would not faithfully guarantee OpenAI JSON mode.

Do not add JSON object mode, tool calls, multimodal input, or `/v1/responses` in this decision. Do not relax the private home, read-only sandbox, `approvalPolicy: "never"`, empty execution environments, blocked tool-item checks, or server-request denial policy. JSON-object requests and tool requests remain explicit 400 responses until a separate protocol mapping is accepted.

Emit one diagnostic event before validating a structured-output or otherwise unsupported request shape. It may contain allowlisted wrapper field names, counts of unknown fields, normalized schema/tier categories, and categorical tool count/type/choice metadata. It must not contain prompts, message content, unknown key names, tool or schema names, property names, descriptions, arbitrary values, credentials, or request bodies. This makes unsupported caller shapes diagnosable without collecting content.

## Consequences

This is a narrow one-to-one protocol translation rather than prompt-based JSON emulation. Codex reports the final schema-constrained value as agent-message text, so callers parse `message.content` as JSON in the normal Chat Completions manner.

The existing request body limit also bounds schema size. Codex's generated protocol does not publish separate schema-depth or keyword limits; incompatible schemas therefore fail as upstream Codex errors rather than being silently rewritten.
