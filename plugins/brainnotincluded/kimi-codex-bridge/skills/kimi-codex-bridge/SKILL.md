---
name: kimi-codex-bridge
description: Use when the user asks Codex to start Kimi Web, talk to Kimi Code CLI, compare with Kimi, or manage Kimi sessions from Codex.
---

# Kimi Codex Bridge

Use the `kimi-codex-bridge` MCP tools when the user wants Kimi Code CLI involved.

Preferred flow:

1. Call `kimi_status` to confirm the local Kimi Web backend is reachable.
2. Call `kimi_create_session` for the current repository when no session ID was provided.
3. Call `kimi_prompt` to send work to Kimi.
4. Use `kimi_steer`, `kimi_cancel`, or `kimi_set_plan_mode` for active turns.
5. Use `kimi_list_sessions`, `kimi_update_session`, `kimi_fork_session`, and `kimi_delete_session` to manage sessions.

Safety default:

- `kimi_prompt` rejects Kimi approval requests by default. Only pass `approval_response: "approve"` or `"approve_for_session"` when the user explicitly wants Kimi to execute file edits or shell commands.

Notes:

- The backend is Kimi Web, not a separate reimplementation of Kimi internals.
- Kimi sessions are stored wherever Kimi Code CLI stores its own session metadata.
- If Kimi is not authenticated, tell the user to run `kimi login`.
