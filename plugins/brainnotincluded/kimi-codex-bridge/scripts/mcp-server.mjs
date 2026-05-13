#!/usr/bin/env node
import { constants, createWriteStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.1";
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), "..");

const state = {
  host: process.env.KIMI_BRIDGE_HOST || "127.0.0.1",
  preferredPort: Number.parseInt(process.env.KIMI_BRIDGE_PORT || "5494", 10),
  port: undefined,
  token: process.env.KIMI_BRIDGE_TOKEN || randomBytes(24).toString("hex"),
  command: undefined,
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

async function executableExists(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveKimiCommand() {
  if (state.command) return state.command;

  const configured = process.env.KIMI_BRIDGE_COMMAND || "kimi";
  if (configured.includes("/") || configured.includes("\\")) {
    if (!(await executableExists(configured))) {
      throw new Error(`Kimi command is not executable: ${configured}`);
    }
    state.command = configured;
    return configured;
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const extraEntries = [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  for (const dir of [...pathEntries, ...extraEntries]) {
    const candidate = path.join(dir, configured);
    if (await executableExists(candidate)) {
      state.command = candidate;
      return candidate;
    }
  }

  throw new Error(
    `Cannot find '${configured}'. Install Kimi Code CLI or set KIMI_BRIDGE_COMMAND to its absolute path.`,
  );
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

  const command = await resolveKimiCommand();
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

  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
    state.lastStartError = error.message;
  });

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
    if (spawnError) {
      throw new Error(`Failed to start Kimi Web: ${spawnError.message}`);
    }
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
    command: state.command ?? null,
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
  const command = await resolveKimiCommand();
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

const JSON_SCHEMA = "http://json-schema.org/draft-07/schema#";
const schema = {
  empty: { type: "object", properties: {}, additionalProperties: false, $schema: JSON_SCHEMA },
  status: {
    type: "object",
    properties: {
      start: { type: "boolean", description: "Start Kimi Web if it is not reachable." },
    },
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  listSessions: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 500 },
      offset: { type: "integer", minimum: 0 },
      q: { type: "string" },
      archived: { type: "boolean" },
    },
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  createSession: {
    type: "object",
    properties: {
      work_dir: { type: "string" },
      create_dir: { type: "boolean" },
    },
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  sessionId: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
    },
    required: ["session_id"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  prompt: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
      session_id: { type: "string", format: "uuid" },
      work_dir: { type: "string" },
      create_session: { type: "boolean" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
      approval_response: { type: "string", enum: ["reject", "approve", "approve_for_session"] },
      rejection_feedback: { type: "string" },
      question_strategy: { type: "string", enum: ["empty", "first_option"] },
      include_events: { type: "boolean" },
    },
    required: ["prompt"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  steer: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      message: { type: "string", minLength: 1 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    required: ["session_id", "message"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  cancel: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    required: ["session_id"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  planMode: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      enabled: { type: "boolean" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    required: ["session_id", "enabled"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  updateSession: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      archived: { type: "boolean" },
    },
    required: ["session_id"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  forkSession: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      turn_index: { type: "integer", minimum: 0 },
    },
    required: ["session_id", "turn_index"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
  sessionEvents: {
    type: "object",
    properties: {
      session_id: { type: "string", format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    required: ["session_id"],
    additionalProperties: false,
    $schema: JSON_SCHEMA,
  },
};

const tools = new Map();

function registerTool(name, config, handler) {
  tools.set(name, {
    name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema || schema.empty,
    execution: { taskSupport: "forbidden" },
    handler,
  });
}

registerTool(
  "kimi_status",
  {
    title: "Kimi Status",
    description: "Start or inspect the local Kimi Web backend used by this bridge.",
    inputSchema: schema.status,
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

registerTool(
  "kimi_start",
  {
    title: "Start Kimi Web",
    description: "Force-start a Kimi Web backend owned by this bridge.",
    inputSchema: schema.empty,
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

registerTool(
  "kimi_stop",
  {
    title: "Stop Kimi Web",
    description: "Stop the Kimi Web backend process if it was started by this bridge.",
    inputSchema: schema.empty,
  },
  async () => {
    try {
      return textResult(await stopBackend());
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTool(
  "kimi_list_sessions",
  {
    title: "List Kimi Sessions",
    description: "List Kimi Code CLI Web sessions.",
    inputSchema: schema.listSessions,
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

registerTool(
  "kimi_create_session",
  {
    title: "Create Kimi Session",
    description: "Create a Kimi Code CLI session for a working directory.",
    inputSchema: schema.createSession,
  },
  async (args) => {
    try {
      return textResult(await createSession(args));
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTool(
  "kimi_get_session",
  {
    title: "Get Kimi Session",
    description: "Get Kimi session metadata.",
    inputSchema: schema.sessionId,
  },
  async ({ session_id }) => {
    try {
      return textResult(await requestJson(`/api/sessions/${session_id}`));
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTool(
  "kimi_prompt",
  {
    title: "Prompt Kimi",
    description: "Send a prompt to a Kimi session and wait for the turn to finish.",
    inputSchema: schema.prompt,
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

registerTool(
  "kimi_steer",
  {
    title: "Steer Kimi",
    description: "Inject follow-up input into an active Kimi turn.",
    inputSchema: schema.steer,
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

registerTool(
  "kimi_cancel",
  {
    title: "Cancel Kimi Turn",
    description: "Cancel an active Kimi turn.",
    inputSchema: schema.cancel,
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

registerTool(
  "kimi_set_plan_mode",
  {
    title: "Set Kimi Plan Mode",
    description: "Enable or disable plan mode for a Kimi session.",
    inputSchema: schema.planMode,
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

registerTool(
  "kimi_update_session",
  {
    title: "Update Kimi Session",
    description: "Rename, archive, or unarchive a Kimi session.",
    inputSchema: schema.updateSession,
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

registerTool(
  "kimi_delete_session",
  {
    title: "Delete Kimi Session",
    description: "Delete a Kimi session.",
    inputSchema: schema.sessionId,
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

registerTool(
  "kimi_fork_session",
  {
    title: "Fork Kimi Session",
    description: "Fork a Kimi session at a zero-based turn index.",
    inputSchema: schema.forkSession,
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

registerTool(
  "kimi_session_events",
  {
    title: "Read Kimi Session Events",
    description: "Read recent raw Kimi Wire events from a session wire.jsonl file.",
    inputSchema: schema.sessionEvents,
  },
  async ({ session_id, limit = 100 }) => {
    try {
      return textResult(await readSessionEvents(session_id, limit));
    } catch (error) {
      return errorResult(error);
    }
  },
);

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  writeJson({ result, jsonrpc: "2.0", id });
}

function sendError(id, code, message, data = undefined) {
  writeJson({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function listToolDescriptors() {
  return Array.from(tools.values()).map(({ handler: _handler, ...tool }) => tool);
}

async function handleRpcMessage(message) {
  const id = message.id ?? null;
  const method = message.method;

  if (!method) {
    if (id !== null) sendError(id, -32600, "Invalid request: missing method.");
    return;
  }

  if (id === null && method.startsWith("notifications/")) return;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "kimi-codex-bridge", version: VERSION },
      });
      return;

    case "ping":
      sendResult(id, {});
      return;

    case "tools/list":
      sendResult(id, { tools: listToolDescriptors() });
      return;

    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string") {
        sendError(id, -32602, "Invalid params: tools/call requires a tool name.");
        return;
      }
      const tool = tools.get(name);
      if (!tool) {
        sendError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const args = message.params?.arguments || {};
      const result = await tool.handler(args);
      sendResult(id, result);
      return;
    }

    case "resources/list":
      sendResult(id, { resources: [] });
      return;

    case "prompts/list":
      sendResult(id, { prompts: [] });
      return;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function serveStdio() {
  const pending = new Set();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let closedResolve;
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        sendError(null, -32700, "Parse error", String(error));
        return;
      }

      try {
        await handleRpcMessage(message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendError(message.id ?? null, -32603, msg);
      }
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  rl.once("close", () => closedResolve());
  await closed;
  while (pending.size > 0) {
    await Promise.allSettled(Array.from(pending));
  }
}

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

  await serveStdio();
  await stopBackend();
}

process.once("SIGINT", async () => {
  await stopBackend();
  process.exit(130);
});
process.once("SIGTERM", async () => {
  await stopBackend();
  process.exit(143);
});
process.once("exit", () => {
  if (state.child) state.child.kill("SIGTERM");
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
