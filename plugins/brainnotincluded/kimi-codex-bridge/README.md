# Kimi Codex Bridge

Codex plugin that starts a local [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) Web backend and exposes it as MCP tools.

## What It Adds

- Starts `kimi web --no-open` on localhost when the MCP server starts.
- Creates and lists Kimi sessions.
- Sends prompts to a session over Kimi Web's JSON-RPC WebSocket stream.
- Steers or cancels active Kimi turns.
- Toggles plan mode.
- Renames, archives, forks, and deletes sessions.
- Reads recent raw Wire events from a session for debugging.

## Requirements

- Node.js 20 or newer.
- Kimi Code CLI installed and authenticated:

```sh
pipx install kimi-cli
kimi login
```

The `kimi-code` executable is also supported. Set `KIMI_BRIDGE_COMMAND=kimi-code` if that is the command on your machine.

No `npm install` step is required. The MCP bridge uses only Node.js built-ins.

## Install In Codex

Add this repo as a plugin marketplace in Codex:

```text
/plugin marketplace add brainnotincluded/codaxtropic
/plugin install kimi-codex-bridge@codaxtropic
```

After install, Codex should expose the `kimi-codex-bridge` MCP tools.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIMI_BRIDGE_COMMAND` | `kimi` | Kimi executable to run. |
| `KIMI_BRIDGE_HOST` | `127.0.0.1` | Host for the Kimi Web backend. |
| `KIMI_BRIDGE_PORT` | `5494` | Preferred backend port. |
| `KIMI_BRIDGE_TOKEN` | generated | Auth token passed to `kimi web`. |
| `KIMI_BRIDGE_AUTOSTART` | `1` | Set `0` to avoid starting Kimi Web automatically. |
| `KIMI_BRIDGE_START_TIMEOUT_MS` | `30000` | Startup wait time. |
| `KIMI_BRIDGE_LOG_DIR` | OS temp dir | Where backend stdout/stderr logs go. |

## Safety

The `kimi_prompt` tool defaults `approval_response` to `reject`, so Kimi cannot approve write or shell actions unless you explicitly request `approve` or `approve_for_session` in that tool call.

## Privacy

This plugin runs locally. It starts Kimi Code CLI on your machine and sends prompts to the local Kimi Web backend. Kimi Code CLI itself may contact Moonshot AI services depending on your Kimi configuration and authentication state.

## Terms

This plugin is provided as-is under the MIT license. Kimi Code CLI is a separate project governed by its own license and terms.
