# Security policy

## Supported versions

Until a stable release, only the latest commit on `main` is supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include Codex credentials, access tokens, private prompts, or customer data in a report. If private reporting is unavailable, open a minimal issue asking the maintainer to establish a private channel.

## Threat boundary

This adapter is for one trusted local user on loopback. It is not hardened for LAN, internet, hosted, shared-machine, or multi-tenant deployment. The local bearer token protects the HTTP surface; Codex retains responsibility for its own upstream authentication. A compromised local user account can inspect this process and is outside the threat model.

Tool disablement, sandboxing, and protocol translation are security-sensitive. Any Codex CLI upgrade requires the contract suite and authenticated hostile-prompt smoke test before release.

Codex itself may synchronize authenticated plugin metadata or refresh plugin OAuth state during startup. The adapter blocks model-initiated tool activity; it does not claim to suppress all Codex-managed startup network traffic.
