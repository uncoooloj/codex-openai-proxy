# Private-server candidate verification

Verified on 2026-09-11. This is a GitHub-only 0.0.2 candidate, not an npm release.

## Real Linux model requests

The packed npm artifact was installed into a fresh Linux ARM64 container with Node.js 22.23.2, official Codex CLI 0.146.0, and official OpenAI JavaScript client 7.4.0. The process ran as an unprivileged user (UID 501). The existing authorized Codex login was mounted read-only; its contents were not printed, copied into the image, or changed. No host port was published.

The packaged smoke used the actual authenticated Codex app-server and model `gpt-5.6-sol`. All six sections passed:

| Section | Result |
| --- | --- |
| Text Chat Completions | Passed |
| Streaming SSE | Passed |
| Strict JSON-schema output | Passed |
| JSON-object output | Passed |
| Client-owned coding tool loop | Read a synthetic fixture, ran its failing test, applied an allowlisted repair, ran the passing test, and received a final response |
| Hostile filesystem prompt | Local synthetic canary remained unchanged |

Missing bearer authentication returned HTTP 401. A graceful stop and restart preserved the generated token; the same token then authenticated `/v1/models` successfully.

The fixture client can execute only its three explicit synthetic functions. This proves function-call round trips, not arbitrary shell execution or compatibility with every coding agent. The hostile-prompt check covers the colocated client's filesystem; it does not prove isolation from a remote host or defeat every possible attack.

## Deployment boundary

The 46-test contract suite passed on macOS (Node.js 22.6.0) and Linux (Node.js 22.23.2). Coverage includes bearer rejection, overload, partial/oversized uploads, cancellation, missing interrupt acknowledgement or terminal event, deterministic child shutdown, token-file safety, JSON/tool compatibility, and SSE fallback.

The generated native-feature overrides were checked with the installed Codex CLI's `features list`: all 26 configured capabilities were disabled. Process and thread startup share the same policy. The child environment excludes adapter tokens and OpenAI client routing/key variables.

`systemd-analyze verify` accepted the packaged user unit inside Linux. Boot, logout/lingering, a real remote SSH tunnel, and login renewal were not exercised. Authenticate on the intended server, run the packaged smoke there, and verify the service under its actual user manager before relying on unattended operation.

This remains a single-owner, low-throughput gateway. It does not add Responses API, server-side code execution, public hosting, durable jobs, or automatic retry/replay.

The CLI initializes its backend once. Concurrent direct library calls to `initialize()` are not a supported lifecycle contract; library consumers must serialize initialization and close a failed instance instead of reusing it.
