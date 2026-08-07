# Prior art and positioning

Reviewed on 2026-08-07. This is an architecture comparison, not an endorsement. No source code was copied.

## Closest project

[CIVITAS-John/codex-app-server-to-proxy](https://github.com/CIVITAS-John/codex-app-server-to-proxy) publishes the unscoped `codex-openai-proxy` npm package under MIT. It is a broad prerelease with text/SSE, client function tools, usage, thread continuation, login recovery, per-request Codex policy, generated protocol schemas, and a pinned Codex runtime.

Lessons adopted here:

- Pin and verify the exact experimental Codex protocol version.
- Use `environments: []` as well as read-only sandboxing to remove execution-environment access.
- Prime SSE before committing HTTP 200 so immediate upstream failures remain JSON errors.
- Respect HTTP backpressure, propagate cancellation, and never invent usage.

This repository intentionally differs by staying plain-model-only: independent local bearer authentication, one ephemeral thread per request, concurrency one by default, no workspace selection, no client tools, no persisted continuations, no API-key-free loopback mode, and fail-closed rejection of every unsupported request field.

## Broader gateways

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is a large MIT multi-provider gateway with account routing, streaming, tools, and several provider-compatible APIs. It demonstrates demand but its account pool, management API, and provider breadth are outside this MVP.
- [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) is an MIT provider-routing proxy with streaming, tools, images, reasoning, account pools, and quota-aware routing. Its explicit terms warning reinforces the need to describe subscription and account boundaries clearly.
- [cluic/codex-remote-proxy](https://github.com/cluic/codex-remote-proxy) is an MIT upstream-provider proxy rather than the same product. Its bounded transforms, cancellation, backpressure, keychain storage, and loopback admin protections are useful operational patterns.
- [jacob-bd/relay-ai](https://github.com/jacob-bd/relay-ai) is an MIT local gateway/provider registry with OS-keychain secret storage and broader UI/server deployment. Provider registries and network serving remain deliberately out of scope here.

## Future evaluation order

If the MVP grows, add observability and protocol contract generation first, then accurate rate-limit errors and usage. Evaluate Responses API, persisted threads, tools, account pools, UIs, and non-loopback operation only as separate threat-model and compatibility decisions.
