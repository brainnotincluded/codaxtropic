#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.1.0";
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), "..");

const state = {
  host: process.env.KIMI_BRIDGE_HOST || "127.0.0.1",
  preferredPort: Number.parseInt(process.env.KIMI_BRIDGE_PORT || "5494", 10),
  port: undefined,
  token: process.env.KIMI_BRIDGE_TOKEN || randomBytes(24).toString("hex"),
  child: undefined,
  owned: false,
  lastStartError: undefined,
  stdoutLog: undefined,
  stderrLog: undefined,
};

function backendUrl(port = state.port) {
  if (!port) return undefined;
  return `http://${state.host}:${port}`;
}

function wsUrl(sessionId) {
  const token = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  return `ws://${state.host}:${state.port}/api/sessions/${sessionId}/stream${token}`;
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, state.host);
  });
}

async function findFreePort(startPort, attempts = 10) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found from ${startPort} to ${startPort + attempts - 1}.`);
}

async function healthCheck(port) {
  try {
    const response = await fetch(`http://${state.host}:${port}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function apiUsable(port) {
  try {
    const response = await fetch(`http://${state.host}:${port}/api/sessions/?limit=1`, {
      headers: authHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
}

async function requestJson(route, { method = "GET", body, headers = {} } = {}) {
  await ensureBackend();
  const response = await fetch(`${backendUrl()}${route}`, {
    method,
    headers: authHeaders({
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? payload.detail
        : text || response.statusText;
    throw new Error(`Kimi Web API ${response.status} ${response.statusText}: ${detail}`);
  }

  return payload;
}

async function discoverUsableBackend() {
  for (
    let port = state.preferredPort;
    port < state.preferredPort + 10;
    port += 1
  ) {
    if ((await healthCheck(port)) && (await apiUsable(port))) {
      state.port = port;
      state.owned = false;
      return true;
    }
  }
  return false;
}

async function ensureBackend({ forceStart = false } = {}) {
  if (!forceStart && state.port && (await healthCheck(state.port)) && (await apiUsable(state.port))) {
    return statusSnapshot();
  }

  if (!forceStart && (await discoverUsableBackend())) {
    return statusSnapshot();
  }

  if (process.env.KIMI_BRIDGE_AUTOSTART === "0") {
    throw new Error(
      "Kimi Web is not reachable and KIMI_BRIDGE_AUTOSTART=0. Start `kimi web` or enable autostart.",
    );
  }

  const command = process.env.KIMI_BRIDGE_COMMAND || "kimi";
  const port = await findFreePort(state.preferredPort);
  const logDir = process.env.KIMI_BRIDGE_LOG_DIR || path.join(os.tmpdir(), "kimi-codex-bridge");
  const stdoutPath = path.join(logDir, `kimi-web-${port}.stdout.log`);
  const stderrPath = path.join(logDir, `kimi-web-${port}.stderr.log`);

  await import("node:fs/promises").then((fs) => fs.mkdir(logDir, { recursive: true }));
  state.stdoutLog = stdoutPath;
  state.stderrLog = stderrPath;

  const args = [
    "web",
    "--host",
    state.host,
    "--port",
    String(port),
    "--no-open",
    "--auth-token",
    state.token,
  ];
  const extraArgs = (process.env.KIMI_BRIDGE_EXTRA_ARGS || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const child = spawn(command, [...args, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, KIMI_WEB_SESSION_TOKEN: state.token },
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.child = child;
  state.owned = true;
  state.port = port;
  state.lastStartError = undefined;

  child.stdout.pipe(createWriteStream(stdoutPath, { flags: "a" }));
  child.stderr.pipe(createWriteStream(stderrPath, { flags: "a" }));
  child.once("exit", (code, signal) => {
    if (state.child === child) {
      state.child = undefined;
      state.owned = false;
      state.lastStartError = `kimi web exited with code=${code} signal=${signal}`;
    }
  });

  const timeoutMs = Number.parseInt(process.env.KIMI_BRIDGE_START_TIMEOUT_MS || "30000", 10);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Kimi Web exited during startup with code ${child.exitCode}. See ${stderrPath}.`,
      );
    }
    if ((await healthCheck(port)) && (await apiUsable(port))) {
      return statusSnapshot();
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for Kimi Web on ${backendUrl(port)}. See ${stderrPath}.`);
}

async function stopBackend() {
  if (!state.child) {
    return { stopped: false, reason: "No Kimi Web process is owned by this bridge." };
  }
  const child = state.child;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
  state.child = undefined;
  state.owned = false;
  return { stopped: true };
}

function statusSnapshot() {
  return {
    backend_url: backendUrl(),
    host: state.host,
    port: state.port,
    preferred_port: state.preferredPort,
    owned_process: state.owned,
    process_pid: state.child?.pid ?? null,
    token_configured: Boolean(state.token),
    stdout_log: state.stdoutLog ?? null,
    stderr_log: state.stderrLog ?? null,
    last_start_error: state.lastStartError ?? null,
    plugin_root: PLUGIN_ROOT,
  };
}

async function getKimiVersion() {
  const command = process.env.KIMI_BRIDGE_COMMAND || "kimi";
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
    child.once("exit", (code) => {
      resolve({ ok: code === 0, output: out.trim(), error: err.trim(), code });
    });
  });
}

async function createSession({ work_dir, create_dir = false } = {}) {
  const body =
    work_dir || create_dir
      ? { work_dir: work_dir || undefined, create_dir: Boolean(create_dir) }
      : {};
  return requestJson("/api/sessions/", { method: "POST", body });
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // no-op
      }
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`Failed to open WebSocket ${url}`));
      },
      { once: true },
    );
  });
}

function makeSocketQueue(ws) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let closeError;

  function push(value) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queue.push(value);
  }

  ws.addEventListener("message", (event) => {
    try {
      push(JSON.parse(event.data.toString()));
    } catch {
      push({ jsonrpc: "2.0", method: "parse_error", raw: event.data.toString() });
    }
  });
  ws.addEventListener("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(closeError || new Error("Kimi WebSocket closed."));
    }
  });
  ws.addEventListener("error", () => {
    closeError = new Error("Kimi WebSocket error.");
  });

  return {
    async next(timeoutMs) {
      if (queue.length) return queue.shift();
      if (closed) throw closeError || new Error("Kimi WebSocket closed.");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a Kimi WebSocket message."));
        }, timeoutMs);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
  };
}

async function openSession(sessionId, timeoutMs) {
  await ensureBackend();
  const ws = await openWebSocket(wsUrl(sessionId), Math.min(timeoutMs, 30000));
  const messages = makeSocketQueue(ws);

  const readyDeadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < readyDeadline) {
    const msg = await messages.next(Math.max(1000, readyDeadline - Date.now()));
    if (msg.method === "history_complete") break;
  }

  return { ws, messages };
}

function sendRpc(ws, method, params = undefined) {
  const id = randomUUID();
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method,
      id,
      ...(params === undefined ? {} : { params }),
    }),
  );
  return id;
}

function sendResponse(ws, id, result) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function handleKimiRequest(ws, msg, opts, handledRequests) {
  const params = msg.params || {};
  const payload = params.payload || {};
  const type = params.type;
  handledRequests.push({ id: msg.id, type, payload });

  if (type === "ApprovalRequest") {
    const response = opts.approval_response || "reject";
    sendResponse(ws, msg.id, {
      request_id: payload.id,
      response,
      ...(response === "reject"
        ? {
            feedback:
              opts.rejection_feedback ||
              "Codex Kimi bridge rejected this approval request by default.",
          }
        : {}),
    });
    return;
  }

  if (type === "QuestionRequest") {
    const answers = {};
    if (opts.question_strategy === "first_option") {
      for (const question of payload.questions || []) {
        const first = question.options?.[0]?.label;
        if (question.question && first) answers[question.question] = first;
      }
    }
    sendResponse(ws, msg.id, { request_id: payload.id, answers });
    return;
  }

  if (type === "ToolCallRequest") {
    sendResponse(ws, msg.id, {
      tool_call_id: payload.id,
      return_value: {
        is_error: true,
        output: `External tool '${payload.name}' is not implemented by kimi-codex-bridge.`,
        message: "No external tools are registered by this Codex bridge.",
        display: [],
      },
    });
    return;
  }

  if (type === "HookRequest") {
    sendResponse(ws, msg.id, {
      request_id: payload.id,
      action: "allow",
      reason: "No hook handler is configured in kimi-codex-bridge.",
    });
    return;
  }

  sendResponse(ws, msg.id, {});
}

function collectEvent(summary, event) {
  const type = event.params?.type;
  const payload = event.params?.payload || {};
  summary.event_count += 1;

  if (type === "ContentPart") {
    if (payload.type === "text" && payload.text) summary.assistant_text += payload.text;
    if (payload.type === "think" && payload.think) summary.thinking_text += payload.think;
    return;
  }

  if (type === "ToolCall") {
    summary.tool_calls.push({
      id: payload.id,
      name: payload.function?.name,
      arguments: payload.function?.arguments,
    });
    return;
  }

  if (type === "ToolResult") {
    summary.tool_results.push({
      tool_call_id: payload.tool_call_id,
      is_error: payload.return_value?.is_error,
      message: payload.return_value?.message,
    });
    return;
  }

  if (type === "StatusUpdate") {
    summary.last_status_update = payload;
    return;
  }

  if (type === "PlanDisplay") {
    summary.plan_displays.push(payload);
    return;
  }

  if (type === "StepBegin") {
    summary.steps = Math.max(summary.steps, payload.n || 0);
    return;
  }

  if (type === "TurnEnd") {
    summary.turn_ended = true;
  }
}

async function initializeWire(ws, messages, timeoutMs) {
  const initId = sendRpc(ws, "initialize", {
    protocol_version: "1.10",
    client: { name: "kimi-codex-bridge", version: VERSION },
    capabilities: { supports_question: true, supports_plan_mode: true },
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await messages.next(Math.max(1000, deadline - Date.now()));
    if (msg.id === initId) return msg;
  }
  throw new Error("Timed out waiting for Kimi Wire initialize response.");
}

function summarizeInitializeResponse(response) {
  if (response.error) return { error: response.error };
  const result = response.result || {};
  return {
    protocol_version: result.protocol_version,
    server: result.server,
    slash_command_count: Array.isArray(result.slash_commands)
      ? result.slash_commands.length
      : 0,
    capabilities: result.capabilities || null,
    hooks: result.hooks
      ? {
          supported_events: Array.isArray(result.hooks.supported_events)
            ? result.hooks.supported_events.length
            : 0,
          configured: result.hooks.configured || {},
        }
      : null,
  };
}

async function sessionRpc(sessionId, method, params, opts = {}) {
  const timeoutMs = opts.timeout_ms || 600000;
  const { ws, messages } = await openSession(sessionId, timeoutMs);
  const summary = {
    assistant_text: "",
    thinking_text: "",
    event_count: 0,
    steps: 0,
    turn_ended: false,
    last_status_update: null,
    session_status: null,
    tool_calls: [],
    tool_results: [],
    plan_displays: [],
    handled_requests: [],
    raw_events: [],
  };

  try {
    if (opts.initialize !== false) {
      const initResponse = await initializeWire(ws, messages, Math.min(timeoutMs, 30000));
      summary.initialize = summarizeInitializeResponse(initResponse);
    }

    const requestId = sendRpc(ws, method, params);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const msg = await messages.next(Math.max(1000, deadline - Date.now()));

      if (msg.method === "event") {
        collectEvent(summary, msg);
        if (opts.include_events) summary.raw_events.push(msg.params);
        continue;
      }

      if (msg.method === "request") {
        handleKimiRequest(ws, msg, opts, summary.handled_requests);
        continue;
      }

      if (msg.method === "session_status") {
        summary.session_status = msg.params;
        continue;
      }

      if (msg.id === requestId) {
        if (msg.error) {
          return { ok: false, session_id: sessionId, error: msg.error, summary };
        }
        return { ok: true, session_id: sessionId, result: msg.result, summary };
      }
    }

    throw new Error(`Timed out waiting for Kimi ${method} response after ${timeoutMs}ms.`);
  } finally {
    try {
      ws.close();
    } catch {
      // no-op
    }
  }
}

async function readSessionEvents(sessionId, limit = 100) {
  const session = await requestJson(`/api/sessions/${sessionId}`);
  if (!session?.session_dir) {
    throw new Error(`Session ${sessionId} has no session_dir in Kimi Web response.`);
  }
  const wirePath = path.join(session.session_dir, "wire.jsonl");
  const content = await readFile(wirePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(limit, 1000)))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

const server = new McpServer({
  name: "kimi-codex-bridge",
  version: VERSION,
});

server.registerTool(
  "kimi_status",
  {
    title: "Kimi Status",
    description: "Start or inspect the local Kimi Web backend used by this bridge.",
    inputSchema: {
      start: z.boolean().optional().describe("Start Kimi Web if it is not reachable."),
    },
  },
  async ({ start = true }) => {
    try {
      if (start) await ensureBackend();
      const version = await getKimiVersion();
      return textResult({ ...statusSnapshot(), kimi_version: version });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_start",
  {
    title: "Start Kimi Web",
    description: "Force-start a Kimi Web backend owned by this bridge.",
    inputSchema: {},
  },
  async () => {
    try {
      await ensureBackend({ forceStart: true });
      return textResult(statusSnapshot());
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_stop",
  {
    title: "Stop Kimi Web",
    description: "Stop the Kimi Web backend process if it was started by this bridge.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult(await stopBackend());
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_list_sessions",
  {
    title: "List Kimi Sessions",
    description: "List Kimi Code CLI Web sessions.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      q: z.string().optional(),
      archived: z.boolean().optional(),
    },
  },
  async ({ limit = 100, offset = 0, q, archived }) => {
    try {
      const query = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (q) query.set("q", q);
      if (archived !== undefined) query.set("archived", String(archived));
      return textResult(await requestJson(`/api/sessions/?${query}`));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_create_session",
  {
    title: "Create Kimi Session",
    description: "Create a Kimi Code CLI session for a working directory.",
    inputSchema: {
      work_dir: z.string().optional(),
      create_dir: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return textResult(await createSession(args));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_get_session",
  {
    title: "Get Kimi Session",
    description: "Get Kimi session metadata.",
    inputSchema: {
      session_id: z.string().uuid(),
    },
  },
  async ({ session_id }) => {
    try {
      return textResult(await requestJson(`/api/sessions/${session_id}`));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_prompt",
  {
    title: "Prompt Kimi",
    description: "Send a prompt to a Kimi session and wait for the turn to finish.",
    inputSchema: {
      prompt: z.string().min(1),
      session_id: z.string().uuid().optional(),
      work_dir: z.string().optional(),
      create_session: z.boolean().optional(),
      timeout_ms: z.number().int().min(1000).max(3600000).optional(),
      approval_response: z.enum(["reject", "approve", "approve_for_session"]).optional(),
      rejection_feedback: z.string().optional(),
      question_strategy: z.enum(["empty", "first_option"]).optional(),
      include_events: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      let sessionId = args.session_id;
      let session = null;
      if (!sessionId) {
        if (args.create_session === false) {
          throw new Error("session_id is required when create_session is false.");
        }
        session = await createSession({ work_dir: args.work_dir, create_dir: false });
        sessionId = session.session_id;
      }
      const response = await sessionRpc(
        sessionId,
        "prompt",
        { user_input: args.prompt },
        {
          timeout_ms: args.timeout_ms ?? 600000,
          approval_response: args.approval_response ?? "reject",
          rejection_feedback: args.rejection_feedback,
          question_strategy: args.question_strategy ?? "empty",
          include_events: Boolean(args.include_events),
        },
      );
      return textResult({ created_session: session, ...response });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_steer",
  {
    title: "Steer Kimi",
    description: "Inject follow-up input into an active Kimi turn.",
    inputSchema: {
      session_id: z.string().uuid(),
      message: z.string().min(1),
      timeout_ms: z.number().int().min(1000).max(300000).optional(),
    },
  },
  async ({ session_id, message, timeout_ms = 30000 }) => {
    try {
      return textResult(
        await sessionRpc(
          session_id,
          "steer",
          { user_input: message },
          { timeout_ms, approval_response: "reject", question_strategy: "empty" },
        ),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_cancel",
  {
    title: "Cancel Kimi Turn",
    description: "Cancel an active Kimi turn.",
    inputSchema: {
      session_id: z.string().uuid(),
      timeout_ms: z.number().int().min(1000).max(300000).optional(),
    },
  },
  async ({ session_id, timeout_ms = 30000 }) => {
    try {
      return textResult(
        await sessionRpc(session_id, "cancel", undefined, {
          timeout_ms,
          approval_response: "reject",
          question_strategy: "empty",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_set_plan_mode",
  {
    title: "Set Kimi Plan Mode",
    description: "Enable or disable plan mode for a Kimi session.",
    inputSchema: {
      session_id: z.string().uuid(),
      enabled: z.boolean(),
      timeout_ms: z.number().int().min(1000).max(300000).optional(),
    },
  },
  async ({ session_id, enabled, timeout_ms = 30000 }) => {
    try {
      return textResult(
        await sessionRpc(
          session_id,
          "set_plan_mode",
          { enabled },
          { timeout_ms, approval_response: "reject", question_strategy: "empty" },
        ),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_update_session",
  {
    title: "Update Kimi Session",
    description: "Rename, archive, or unarchive a Kimi session.",
    inputSchema: {
      session_id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      archived: z.boolean().optional(),
    },
  },
  async ({ session_id, title, archived }) => {
    try {
      return textResult(
        await requestJson(`/api/sessions/${session_id}`, {
          method: "PATCH",
          body: { title, archived },
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_delete_session",
  {
    title: "Delete Kimi Session",
    description: "Delete a Kimi session.",
    inputSchema: {
      session_id: z.string().uuid(),
    },
  },
  async ({ session_id }) => {
    try {
      await requestJson(`/api/sessions/${session_id}`, { method: "DELETE" });
      return textResult({ deleted: true, session_id });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_fork_session",
  {
    title: "Fork Kimi Session",
    description: "Fork a Kimi session at a zero-based turn index.",
    inputSchema: {
      session_id: z.string().uuid(),
      turn_index: z.number().int().min(0),
    },
  },
  async ({ session_id, turn_index }) => {
    try {
      return textResult(
        await requestJson(`/api/sessions/${session_id}/fork`, {
          method: "POST",
          body: { turn_index },
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "kimi_session_events",
  {
    title: "Read Kimi Session Events",
    description: "Read recent raw Kimi Wire events from a session wire.jsonl file.",
    inputSchema: {
      session_id: z.string().uuid(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ session_id, limit = 100 }) => {
    try {
      return textResult(await readSessionEvents(session_id, limit));
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function main() {
  if (process.env.KIMI_BRIDGE_AUTOSTART !== "0") {
    try {
      await ensureBackend();
      console.error(`[kimi-codex-bridge] Kimi Web ready at ${backendUrl()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[kimi-codex-bridge] Autostart failed: ${message}`);
    }
  }

  await server.connect(new StdioServerTransport());
}

process.once("SIGINT", async () => {
  await stopBackend();
  process.exit(130);
});
process.once("SIGTERM", async () => {
  await stopBackend();
  process.exit(143);
});
process.stdin.once("end", async () => {
  await stopBackend();
  process.exit(0);
});
process.stdin.once("close", async () => {
  await stopBackend();
  process.exit(0);
});
process.once("exit", () => {
  if (state.child) state.child.kill("SIGTERM");
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
