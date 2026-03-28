# Network Hardening — Design Document

## Overview

Agent containers now run on an isolated Docker network with egress filtered through a domain allowlist. Containers cannot reach the internet directly — all traffic flows through a proxy chain that enforces domain restrictions and injects credentials.

```
Container → Squid (domain allowlist) → OneCLI gateway (credential injection) → Internet
```

---

## Problems Identified

### 1. Unrestricted egress — agents can exfiltrate data to any domain

**Before:** Containers had direct internet access. A prompt-injected agent could POST files, env vars, or conversation data to any external server.

**Alternatives considered:**
- **iptables rules on the host** — fragile, hard to maintain, doesn't integrate with Docker networking.
- **Docker network policies** — Docker CE doesn't support network policies (Kubernetes-only).
- **OneCLI-only (no squid)** — OneCLI proxies ALL domains, not just allowlisted ones. Tested: `evil.com` returned 200 through OneCLI.
- **Squid only (no OneCLI)** — squid can filter domains but can't inject credentials (MITM with CA cert replacement).

**Solution:** Two-proxy chain. Squid filters domains, OneCLI injects credentials. Squid's `cache_peer` directive chains to OneCLI as the parent proxy. The `--internal` Docker network flag removes the default route so containers can't bypass the proxies.

### 2. OneCLI gateway ignores HTTP_PROXY env vars

**Problem:** Initial attempt was Container → OneCLI → Squid → Internet. Set HTTP_PROXY on OneCLI to point at squid. OneCLI's Rust gateway (`reqwest` + custom `ap-proxy-client`) ignores standard proxy env vars for upstream connections.

**Discovery method:** Set HTTP_PROXY/HTTPS_PROXY on OneCLI container, verified the gateway process had them (`/proc/<pid>/environ`), but `evil.com` still returned 200 through OneCLI.

**Solution:** Reversed the chain. Container → Squid → OneCLI. Squid's `cache_peer` is a standard proxy-chaining mechanism that works regardless of what the upstream proxy does internally.

### 3. Proxy loop when OneCLI had HTTP_PROXY set

**Problem:** With HTTP_PROXY on OneCLI pointing at squid, AND squid's cache_peer pointing at OneCLI, traffic looped: squid → OneCLI → squid → OneCLI.

**Solution:** Removed HTTP_PROXY/HTTPS_PROXY from OneCLI's docker-compose.yml. Only squid uses cache_peer to reach OneCLI; OneCLI connects directly to the internet.

### 4. DNS resolution fails on internal network

**Problem:** Docker `--internal` networks have no DNS resolution for external domains. `wget` and similar tools fail with "bad address" because they resolve DNS locally before connecting to the proxy.

**Why it's not a real problem:** Node.js with `NODE_USE_ENV_PROXY=1` (undici) sends CONNECT requests to the proxy with the hostname — it does NOT resolve DNS locally. The proxy (squid → OneCLI) handles DNS resolution. Only affects tools like `wget` that resolve locally.

### 5. gh CLI doesn't work through MITM proxy

**Problem:** `gh` CLI needs `GH_TOKEN` env var to activate. OneCLI injects credentials via MITM (replaces Authorization headers at the TLS level), but `gh` won't even attempt API calls without a token.

**Solution:** Set `GH_TOKEN=placeholder` on the container. `gh` thinks it's authenticated, sends requests with the placeholder token, OneCLI's MITM replaces it with the real PAT. Verified: `gh api /user` returns the correct user.

### 6. git clone fails with 400 from GitHub

**Problem:** OneCLI secret for `github.com` was configured with `"valueFormat": "Basic {value}"` using the raw PAT as value. But Basic auth requires `base64("username:password")`, not the raw token.

**Solution:** Recreated the OneCLI secret with the properly base64-encoded value: `base64("x-access-token:<PAT>")`.

### 7. File permissions — root host, node container user

**Problem:** When nanoclaw runs as root (common on VPS/servers), all bind-mounted directories are owned by root. The container runs as `node` (uid 1000) and can't write to them. Claude Code fails with "session-env directory can't be created".

**Alternatives considered:**
- **chown -R in container-runner.ts** — hack, runs on every container launch, doesn't follow established patterns.
- **Always pass --user 0:0** — container runs as root, violates least privilege.
- **--user $(id -u):$(id -g)** — breaks when UID doesn't exist in container's /etc/passwd.

**Solution:** **gosu entrypoint pattern** (same as official postgres, redis, mysql images). The container starts as root, the entrypoint chowns writable bind-mounts, then drops to `node` via `gosu`. Works for both root and non-root hosts — the `if [ "$(id -u)" = '0' ]` guard skips the drop when already running as non-root.

### 8. Stale session infinite retry loop

**Problem:** Nanoclaw persists Claude Code session IDs in SQLite. When sessions expire or get invalidated (server-side, image rebuild, CLI version change), the agent-runner gets "No conversation found", exits with error, and the host retries with the same stale ID forever.

**Solution:** Agent-runner catches "No conversation found" errors specifically, clears the session ID, and retries once with a fresh session. The new session ID is persisted back to the host.

### 9. No way to stop a diverging agent

**Problem:** When an agent goes off-track (spending 10 minutes on a task that should take 30 seconds), there was no reliable way to stop it. The `_close` sentinel only called `stream.end()` which waits for the current tool call to finish — which could take minutes.

**Alternatives considered:**
- **Send "stop" from Telegram** — unreliable; message queues behind the active tool call.
- **`docker stop`** — works but loses all state.

**Solution:** Pass an `AbortController` to the SDK's `query()` function. When `_close` is detected, call `abortController.abort()` which kills the underlying Claude Code subprocess immediately. The SDK supports this natively (`options.abortController`).

### 10. Telegram channel support

**Problem:** NanoClaw only supported WhatsApp. Needed Telegram as a channel.

**Solution:** Added Telegram channel implementation (`src/channels/telegram.ts`) using the `node-telegram-bot-api` package. Self-registers via the channel registry at startup. Supports message send/receive, chat ID lookup, and the same trigger/group model as WhatsApp.

---

## Files Changed

| File | What changed |
|------|-------------|
| `src/index.ts` | `ensureProxyNetwork()` — creates internal network, connects squid + OneCLI, fetches gateway credentials, generates squid.conf with cache_peer and domain allowlist. `ALLOWED_DOMAINS` array. `writeSquidConfig()` — generates and hot-reloads squid config. |
| `src/container-runner.ts` | `overrideProxyArgs()` — replaces OneCLI proxy URL with squid's in container args. Adds `GH_TOKEN=placeholder`. Removes `hostGatewayArgs()` (unreachable on internal network). |
| `src/container-runtime.ts` | `cleanupOrphans()` — skips `nanoclaw-squid` container. |
| `container/Dockerfile` | Adds `gh` CLI and `gosu`. Removes `USER node` directive. Uses external `entrypoint.sh` instead of inline printf. |
| `container/entrypoint.sh` | gosu pattern — chowns writable mounts, drops to node, configures git/gh CA trust and proxy. |
| `container/agent-runner/src/index.ts` | Catches "No conversation found" → retries with fresh session. Uses `AbortController` for forceful query cancellation on `_close`. |
| `src/channels/telegram.ts` | New Telegram channel implementation. |
| `src/channels/telegram.test.ts` | Tests for Telegram channel. |
| `src/channels/index.ts` | Registers Telegram channel at startup. |

---

## External Changes (not in git)

| Component | Change |
|-----------|--------|
| `~/.onecli/docker-compose.yml` | OneCLI app joined to `nanoclaw-internal` network with `host.docker.internal` alias. |
| `~/nanoclaw-proxy/squid.conf` | Auto-generated by nanoclaw on startup. Domain allowlist + cache_peer to OneCLI. |
| `nanoclaw-squid` container | Squid proxy on `nanoclaw-internal` + `nanoclaw-proxy` networks. |
| OneCLI secrets | Fixed GitHub Git Token to use proper base64 Basic auth encoding. |

---

## Domain Allowlist

Currently allowed (configurable in `ALLOWED_DOMAINS` array in `src/index.ts`):

- `.anthropic.com` — Claude API
- `.github.com` — git push/pull, gh CLI
- `.githubusercontent.com` — raw file access
- `.telegram.org` — bot API
- `.npmjs.org` — npm install
- `.googleapis.com` — Google APIs

Everything else is denied by squid (TCP_DENIED/403).

---

## Verification

Tested end-to-end via Telegram:

1. **Allowed domain** — `api.anthropic.com` → 200 (via FIRSTUP_PARENT in squid logs)
2. **Allowed domain** — `api.github.com` → 200 (gh CLI listed repo issues)
3. **Blocked domain** — `evil.com` → TCP_DENIED/403
4. **Blocked telemetry** — `http-intake.logs.us5.datadoghq.com` → TCP_DENIED/403
5. **Direct internet** — timeout (no route on internal network)
6. **git clone** — works through proxy chain with OneCLI credential injection
7. **gh api /user** — returns correct user (dorringel)
