#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Recorder } from "./recorder.js";
import { AsciicastWriter } from "./asciicast.js";

const execFileAsync = promisify(execFile);

// ── Session tracking ────────────────────────────────────────────────────────

interface TerminalSession {
  id: string;
  command: string;
  cols: number;
  rows: number;
  createdAt: number;
  cast: AsciicastWriter;
}

const sessions = new Map<string, TerminalSession>();
const closedSessions = new Map<string, TerminalSession>();

// ── Trace recorder ─────────────────────────────────────────────────────────

const recorder = new Recorder({
  enabled: process.env.TERMINATOR_NO_TRACE !== "1",
});

function generateSessionId(): string {
  return "term_" + randomBytes(4).toString("hex");
}

// ── tmux helpers ────────────────────────────────────────────────────────────

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

async function tmuxExists(sessionId: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", sessionId);
    return true;
  } catch {
    return false;
  }
}

function requireSession(sessionId: string): TerminalSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}. It may have been closed or never existed.`);
  }
  return session;
}

async function requireAliveSession(sessionId: string): Promise<TerminalSession> {
  const session = requireSession(sessionId);
  const alive = await tmuxExists(sessionId);
  if (!alive) {
    sessions.delete(sessionId);
    throw new Error(`Session ${sessionId} is no longer running. The process may have exited.`);
  }
  return session;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function terminalSpawn(params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}): Promise<{ session_id: string; cols: number; rows: number }> {
  const id = generateSessionId();
  const cols = params.cols ?? 120;
  const rows = params.rows ?? 40;

  // Build the full command string
  const fullCmd = params.args?.length
    ? `${params.command} ${params.args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`
    : params.command;

  // Build tmux command
  const tmuxArgs = [
    "new-session",
    "-d",
    "-s", id,
    "-x", String(cols),
    "-y", String(rows),
    fullCmd,
  ];

  // Set environment variables if provided
  if (params.env) {
    for (const [key, value] of Object.entries(params.env)) {
      // Set env vars in the tmux environment before spawning
      await tmux("set-environment", "-g", key, value);
    }
  }

  await tmux(...tmuxArgs);

  const cast = new AsciicastWriter(cols, rows);

  const session: TerminalSession = {
    id,
    command: fullCmd,
    cols,
    rows,
    createdAt: Date.now(),
    cast,
  };
  sessions.set(id, session);

  recorder.record({ event: "spawn", session: id, command: fullCmd, cols, rows });

  return { session_id: id, cols, rows };
}

async function terminalType(params: {
  session_id: string;
  text: string;
  delay_ms?: number;
}): Promise<{ ok: true }> {
  const session = await requireAliveSession(params.session_id);

  // tmux send-keys with -l flag sends literal characters (no key name interpretation)
  // We send the whole string at once — tmux handles it correctly
  await tmux("send-keys", "-t", params.session_id, "-l", params.text);

  recorder.record({ event: "type", session: params.session_id, text: params.text });
  session.cast.input(params.text);

  // Optional delay to let the application process input
  if (params.delay_ms && params.delay_ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, params.delay_ms));
  }

  return { ok: true };
}

async function terminalSendKey(params: {
  session_id: string;
  key: string;
}): Promise<{ ok: true }> {
  const session = await requireAliveSession(params.session_id);

  // Map friendly key names to tmux key names
  const keyMap: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
    space: "Space",
    backspace: "BSpace",
    delete: "DC",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    "ctrl-c": "C-c",
    "ctrl-d": "C-d",
    "ctrl-z": "C-z",
    "ctrl-l": "C-l",
    "ctrl-a": "C-a",
    "ctrl-e": "C-e",
    "ctrl-k": "C-k",
    "ctrl-u": "C-u",
    "ctrl-w": "C-w",
    "ctrl-r": "C-r",
    "ctrl-p": "C-p",
    "ctrl-n": "C-n",
  };

  const tmuxKey = keyMap[params.key.toLowerCase()] ?? params.key;

  // send-keys WITHOUT -l interprets key names
  await tmux("send-keys", "-t", params.session_id, tmuxKey);

  recorder.record({ event: "send_key", session: params.session_id, key: params.key });

  // Map keys to ANSI sequences for asciicast
  const keyAnsi: Record<string, string> = {
    enter: "\r\n", return: "\r\n", tab: "\t", space: " ",
    backspace: "\x7f", escape: "\x1b", up: "\x1b[A", down: "\x1b[B",
    left: "\x1b[D", right: "\x1b[C",
    "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a",
    "ctrl-l": "\x0c", "ctrl-a": "\x01", "ctrl-e": "\x05",
    "ctrl-k": "\x0b", "ctrl-u": "\x15", "ctrl-w": "\x17",
    "ctrl-r": "\x12", "ctrl-p": "\x10", "ctrl-n": "\x0e",
  };
  session.cast.input(keyAnsi[params.key.toLowerCase()] ?? params.key);

  return { ok: true };
}

async function terminalScreenshot(params: {
  session_id: string;
}): Promise<{ screen: string; rows: number; cols: number }> {
  const session = await requireAliveSession(params.session_id);

  const screen = await tmux("capture-pane", "-t", params.session_id, "-p");
  const trimmed = screen.trimEnd();

  recorder.record({
    event: "screenshot",
    session: params.session_id,
    lines: trimmed.split("\n").length,
    content: trimmed,
  });
  session.cast.frame(trimmed);

  return {
    screen: trimmed,
    rows: session.rows,
    cols: session.cols,
  };
}

async function terminalWaitFor(params: {
  session_id: string;
  pattern: string;
  timeout_ms?: number;
  interval_ms?: number;
}): Promise<{ found: boolean; screen: string; elapsed_ms: number }> {
  const session = await requireAliveSession(params.session_id);

  const timeout = params.timeout_ms ?? 10000;
  const interval = params.interval_ms ?? 200;
  const regex = new RegExp(params.pattern);
  const start = Date.now();

  recorder.record({
    event: "wait_for_start",
    session: params.session_id,
    pattern: params.pattern,
    timeout_ms: timeout,
  });

  while (Date.now() - start < timeout) {
    const screen = await tmux("capture-pane", "-t", params.session_id, "-p");
    if (regex.test(screen)) {
      const wait_ms = Date.now() - start;
      const trimmed = screen.trimEnd();
      recorder.record({
        event: "wait_for_found",
        session: params.session_id,
        pattern: params.pattern,
        wait_ms,
      });
      session.cast.frame(trimmed);
      return {
        found: true,
        screen: trimmed,
        elapsed_ms: wait_ms,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  // One final check
  const screen = await tmux("capture-pane", "-t", params.session_id, "-p");
  const found = regex.test(screen);
  const trimmedFinal = screen.trimEnd();
  const wait_ms = Date.now() - start;
  recorder.record({
    event: found ? "wait_for_found" : "wait_for_timeout",
    session: params.session_id,
    pattern: params.pattern,
    wait_ms,
  });
  session.cast.frame(trimmedFinal);
  return {
    found,
    screen: trimmedFinal,
    elapsed_ms: wait_ms,
  };
}

async function terminalAssert(params: {
  session_id: string;
  text: string;
  regex?: boolean;
}): Promise<{ pass: boolean; screen: string; message: string }> {
  await requireAliveSession(params.session_id);

  const screen = await tmux("capture-pane", "-t", params.session_id, "-p");
  const trimmedScreen = screen.trimEnd();

  let pass: boolean;
  if (params.regex) {
    const re = new RegExp(params.text);
    pass = re.test(trimmedScreen);
  } else {
    pass = trimmedScreen.includes(params.text);
  }

  recorder.record({
    event: pass ? "assert_pass" : "assert_fail",
    session: params.session_id,
    assertion: `${pass ? "contains" : "missing"} ${params.regex ? "pattern" : "text"} '${params.text}'`,
  });

  return {
    pass,
    screen: trimmedScreen,
    message: pass
      ? `PASS: Screen contains ${params.regex ? "pattern" : "text"} "${params.text}"`
      : `FAIL: Screen does NOT contain ${params.regex ? "pattern" : "text"} "${params.text}"`,
  };
}

async function terminalClose(params: {
  session_id: string;
}): Promise<{ ok: true }> {
  const session = sessions.get(params.session_id);
  if (!session) {
    return { ok: true }; // Already gone — idempotent
  }

  try {
    await tmux("kill-session", "-t", params.session_id);
  } catch {
    // Session already dead — that's fine
  }

  recorder.record({ event: "close", session: params.session_id });
  // Preserve in closedSessions so asciicast can still be exported after close
  closedSessions.set(params.session_id, session);
  sessions.delete(params.session_id);
  return { ok: true };
}

async function terminalExport(params: {
  session_id: string;
  save_path?: string;
}): Promise<{ events: number; cast: string; saved_to?: string }> {
  // Look up session (may be closed — check closed sessions map too)
  const session = sessions.get(params.session_id) ?? closedSessions.get(params.session_id);
  if (!session) {
    throw new Error(`Unknown session: ${params.session_id}. Export must happen before or immediately after close.`);
  }

  const cast = session.cast.toCast();

  let saved_to: string | undefined;
  if (params.save_path) {
    writeFileSync(params.save_path, cast);
    saved_to = params.save_path;
  }

  return { events: session.cast.eventCount, cast, saved_to };
}

async function terminalTrace(params: {
  session_id?: string;
  save_path?: string;
}): Promise<{ events: number; trace: unknown[]; saved_to?: string }> {
  const trace = params.session_id
    ? recorder.getTraceForSession(params.session_id)
    : recorder.getTrace();

  let saved_to: string | undefined;
  if (params.save_path) {
    writeFileSync(params.save_path, JSON.stringify(trace, null, 2));
    saved_to = params.save_path;
  }

  return { events: trace.length, trace, saved_to };
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "terminator", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "terminal_spawn",
      description:
        "Start a CLI process in a virtual terminal (tmux session). Returns a session_id for subsequent interactions. The process runs in a real PTY with proper ANSI rendering.",
      inputSchema: {
        type: "object" as const,
        properties: {
          command: {
            type: "string",
            description: "The command to run (e.g., 'bash', 'python3', 'pincer run -- claude')",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments (optional)",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Environment variables to set (optional)",
          },
          cols: {
            type: "number",
            description: "Terminal width in columns (default: 120)",
          },
          rows: {
            type: "number",
            description: "Terminal height in rows (default: 40)",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "terminal_type",
      description:
        "Type text into the terminal. Characters are sent literally (no key name interpretation). Use terminal_send_key for special keys like Enter or Ctrl-C.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
          text: {
            type: "string",
            description: "The text to type into the terminal",
          },
          delay_ms: {
            type: "number",
            description: "Delay in ms after typing to let the application process input (optional)",
          },
        },
        required: ["session_id", "text"],
      },
    },
    {
      name: "terminal_send_key",
      description:
        "Send a special key to the terminal. Supported keys: enter, escape, tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-c, ctrl-d, ctrl-z, ctrl-l, ctrl-a, ctrl-e, ctrl-k, ctrl-u, ctrl-w, ctrl-r, ctrl-p, ctrl-n.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
          key: {
            type: "string",
            description: "The key to send (e.g., 'enter', 'ctrl-c', 'tab', 'up')",
          },
        },
        required: ["session_id", "key"],
      },
    },
    {
      name: "terminal_screenshot",
      description:
        "Capture what the user currently sees in the terminal — the rendered text grid with ANSI escape sequences stripped. This is the equivalent of looking at the screen.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
        },
        required: ["session_id"],
      },
    },
    {
      name: "terminal_wait_for",
      description:
        "Poll the terminal screen until a regex pattern appears or timeout is reached. Useful for waiting for prompts, output, or UI elements to render.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
          pattern: {
            type: "string",
            description: "Regex pattern to search for in the screen content",
          },
          timeout_ms: {
            type: "number",
            description: "Maximum time to wait in ms (default: 10000)",
          },
          interval_ms: {
            type: "number",
            description: "Polling interval in ms (default: 200)",
          },
        },
        required: ["session_id", "pattern"],
      },
    },
    {
      name: "terminal_assert",
      description:
        "Assert that the terminal screen contains expected text or matches a regex pattern. Returns pass/fail with the current screen content and a human-readable message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
          text: {
            type: "string",
            description: "The text or regex pattern to search for",
          },
          regex: {
            type: "boolean",
            description: "If true, treat text as a regex pattern (default: false)",
          },
        },
        required: ["session_id", "text"],
      },
    },
    {
      name: "terminal_close",
      description:
        "Close a terminal session and kill the underlying process. Idempotent — safe to call on already-closed sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID returned by terminal_spawn",
          },
        },
        required: ["session_id"],
      },
    },
    {
      name: "terminal_export",
      description:
        "Export the session recording as an asciicast v2 (.cast) file, playable in asciinema-player or asciinema.org. Recording happens automatically — every type, send_key, and screenshot is captured with timing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "The session ID to export (works for open or recently closed sessions)",
          },
          save_path: {
            type: "string",
            description: "File path to save the .cast file (optional — omit to get content inline)",
          },
        },
        required: ["session_id"],
      },
    },
    {
      name: "terminal_trace",
      description:
        "Retrieve the recorded trace of all terminal operations since the server started. Each event has a t_ms timestamp, event type, session ID, and operation-specific fields. Useful for debugging timing issues, sharing with AI agents for analysis, or saving as a test artifact.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "Filter trace to a specific session (optional — omit for all sessions)",
          },
          save_path: {
            type: "string",
            description: "File path to save the trace JSON (optional)",
          },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "terminal_spawn": {
        const result = await terminalSpawn(args as Parameters<typeof terminalSpawn>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "terminal_type": {
        const result = await terminalType(args as Parameters<typeof terminalType>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "terminal_send_key": {
        const result = await terminalSendKey(args as Parameters<typeof terminalSendKey>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "terminal_screenshot": {
        const result = await terminalScreenshot(args as Parameters<typeof terminalScreenshot>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "terminal_wait_for": {
        const result = await terminalWaitFor(args as Parameters<typeof terminalWaitFor>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "terminal_assert": {
        const result = await terminalAssert(args as Parameters<typeof terminalAssert>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "terminal_close": {
        const result = await terminalClose(args as Parameters<typeof terminalClose>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "terminal_export": {
        const result = await terminalExport(args as Parameters<typeof terminalExport>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "terminal_trace": {
        const result = await terminalTrace(args as Parameters<typeof terminalTrace>[0]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Cleanup on exit ─────────────────────────────────────────────────────────

function cleanup() {
  for (const [id] of sessions) {
    try {
      execFileSync("tmux", ["kill-session", "-t", id], { stdio: "ignore" });
    } catch {
      // Ignore — session may already be dead
    }
  }
  sessions.clear();
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is running — communicates via stdin/stdout JSON-RPC
  console.error("terminator MCP server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  cleanup();
  process.exit(1);
});
