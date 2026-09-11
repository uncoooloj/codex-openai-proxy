# Run a basic private server

Use this setup for one trusted owner. The proxy serves model requests; your application executes any function calls it receives. Codex's own shell and file tools stay disabled. Model inference still goes to OpenAI through your authenticated Codex account.

## Install and authenticate

Use Linux, Node.js 22+, npm, and Git. Install the exact supported Codex CLI version from the official `@openai/codex` package: `0.146.0`. Do not upgrade it independently of the adapter's tested version gate.

Complete Codex's documented headless sign-in before starting the proxy. See the [official authentication guide](https://learn.chatgpt.com/docs/auth). This adapter requires a readable `auth.json` under `CODEX_HOME` (default `~/.codex`); a keyring-only login is insufficient. It links that file into a private temporary Codex home without parsing or copying it. A new server should authenticate normally, rather than putting credentials into an image or repository.

Create a private install directory and install the candidate:

```bash
mkdir -p "$HOME/.local/share/codex-openai-proxy"
chmod 700 "$HOME/.local/share/codex-openai-proxy"
cd "$HOME/.local/share/codex-openai-proxy"
npm install github:uncoooloj/codex-openai-proxy#feat/private-server-mvp openai@7.4.0
npx codex-openai-proxy --token-file ./adapter.token
```

For a repeatable install replace the branch with the reviewed commit SHA from the PR. `v0.0.1` is an older release and omits later tool/JSON support. This candidate is not published to npm.

The token file is created on first start and reused afterward. Its value is the client API key, not an OpenAI Platform key. Clients on this host use `http://127.0.0.1:18080/v1`. Read `adapter.token` directly in your application instead of pasting it into logs or committing it.

In another terminal, from the install directory:

```bash
npx codex-openai-proxy status
CODEX_PROXY_TOKEN_FILE=./adapter.token node node_modules/@uncoooloj/codex-openai-proxy/examples/smoke.mjs
```

The smoke makes real model requests and creates only a disposable synthetic fixture. All sections must pass before treating this host as verified. The client executes only explicitly allowlisted fixture functions; it never runs an arbitrary model-supplied shell command.

## Run under systemd

The package includes `deploy/codex-openai-proxy.service`, a user service for the install directory above. Copy it to your systemd user unit directory after the foreground smoke succeeds. It uses `/usr/bin/env node` and a PATH of `/usr/local/bin:/usr/bin:/bin`. If you installed Node/Codex using nvm, set the unit's PATH to the actual installed bin directory or set `CODEX_PROXY_CODEX_BIN` to an absolute Codex path and adjust the Node executable. Service managers do not source your interactive shell profile.

The unit configures a persistent token path, a restrictive `0077` umask (the token itself uses mode `0600`), a 15-second stop budget, control-group cleanup, and restart-on-failure with a five-attempt limit per two minutes. Startup has a 60-second deadline. Requests interrupted by a restart fail; clients decide whether retrying their application operation is safe.

Use your systemd user manager to reload, enable, and start the unit. For unattended operation after logout, the server administrator must enable user lingering. Recheck readiness and run the smoke under the service. Unit syntax validation is separate from proving boot/logout behavior on your host.

## Connect from your workstation

Keep the proxy bound to `127.0.0.1` on the server. Forward server port `18080` to a free loopback port on your workstation through SSH, then configure the client with that forwarded `/v1` URL and the adapter token. Keep the SSH forwarding listener local; do not bind the proxy to `0.0.0.0` or publish it as an unauthenticated reverse-proxy route.

The smoke's hostile filesystem check is meaningful only when the smoke and proxy share the same filesystem, so run that section on the server itself.

## Limits and diagnostics

- `status` checks initialization/readiness, not a successful upstream model response. Use the smoke to verify upstream access.
- `401`: missing/wrong local adapter token.
- `400`: unsupported or invalid request; inspect the returned message and compatibility table.
- `408` / `413`: upload deadline or body-size limit.
- `429`: another request already occupies the configured concurrency limit (default one); serialize requests or retry with bounded backoff.
- `504`: completion/model-list deadline exceeded. Do not assume a client tool operation can be safely repeated.
- `502`: upstream failure or a response that violates the supported output contract.
- Nonzero startup exit: inspect the safe error category, verify the exact Codex version, file-backed login, and executable paths. Increase `--startup-timeout` only if a slow environment justifies it.

The request body limit is 1 MiB. Upload and completion each have a separate 120-second budget. History is sent in every request; there is no stored conversation API. Tool calls are sequential and non-streaming, with `tool_choice: auto` or `none`. Required/specific/parallel tool selection, Responses API, images/audio, and sampling controls remain unsupported. `max_tokens` is an unenforced compatibility hint, so it is not a cost or output-size control.

## Upgrade and rollback

Record the installed commit and retain `package-lock.json`. Stop the service before replacing its dependency. Install a reviewed new commit, start it, and repeat the smoke. On failure reinstall the previous commit/lockfile and restart. Keep the adapter token file to avoid unnecessarily changing all clients. Never change the Codex version gate without protocol and runtime validation.

See [the release verification record](verification-0.0.2.md) for the actual tested platform and remaining coverage limits.
