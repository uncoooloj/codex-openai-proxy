# Security policy

## Supported versions

Until a stable release, only the latest commit on `main` is supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include Codex credentials, access tokens, private prompts, or customer data in a report. If private reporting is unavailable, open a minimal issue asking the maintainer to establish a private channel.

## Threat boundary

This adapter is for one trusted owner on loopback, including a private server accessed by that owner through SSH forwarding. It is not hardened for a public inference service, direct LAN/internet exposure, shared-machine, or multi-tenant deployment. The local bearer token protects the HTTP surface; Codex retains responsibility for its own upstream authentication. A compromised local user account can inspect this process and is outside the threat model.

Use a persistent owner-only `--token-file` for a service. Supplied and file-backed tokens are not printed; ephemeral tokens are printed once for interactive setup. Do not put tokens in command-line arguments on a shared host. The packaged systemd unit runs as the logged-in user and restarts a failed proxy; it does not replay unfinished requests or turn the proxy into a tool execution service.

Tool disablement, sandboxing, and protocol translation are security-sensitive. Any Codex CLI upgrade requires the contract suite and authenticated hostile-prompt smoke test before release.

Codex itself may synchronize authenticated plugin metadata or refresh plugin OAuth state during startup. The adapter blocks model-initiated tool activity; it does not claim to suppress all Codex-managed startup network traffic.
