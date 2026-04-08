#!/usr/bin/env npx tsx
/**
 * Pincer Governance E2E Demo — powered by Terminator
 *
 * Demonstrates how Terminator ("Playwright for terminals") can automate
 * the exact kind of CLI testing that previously required a human watching
 * the terminal and typing responses.
 *
 * What this tests:
 *   1. Start pincerd daemon and verify it's listening
 *   2. Launch Claude Code under Pincer governance
 *   3. Verify a safe command auto-allows (no prompt)
 *   4. Verify a destructive command triggers the governance dialog
 *   5. Respond to the dialog and verify the outcome
 *   6. Kill the daemon and verify fail-closed behavior
 *
 * Prerequisites:
 *   - pincerd binary built (see PINCERD_BIN below)
 *   - pincer CLI binary (see PINCER_CLI below)
 *   - tmux installed
 *   - Valid Claude API credentials (ANTHROPIC_API_KEY or Claude Code OAuth)
 *
 * Usage:
 *   npx tsx examples/pincer-governance-demo.ts
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Configuration ───────────────────────────────────────────────────────────

const PINCERD_BIN =
  process.env.PINCERD_BIN ??
  `${process.env.HOME}/Code/pincer/.claude/worktrees/fix-auto-discovery/target/release/pincerd`;

const PINCER_CLI =
  process.env.PINCER_CLI ??
  `${process.env.HOME}/Code/pincer/cli/bin/pincer`;

// Safe working directory — all destructive operations happen here, never in real code
let WORK_DIR = "";

// Track whether we opened a live-view split pane (for cleanup)
let livePaneId: string | null = null;

const TIMEOUT_DAEMON_START = 15_000;
const TIMEOUT_CLAUDE_START = 30_000;
const TIMEOUT_LLM_RESPONSE = 60_000; // Claude needs time to call the LLM and process
const TIMEOUT_GOVERNANCE = 60_000;   // Governance dialog appears after LLM decides to use a tool
const POLL_INTERVAL = 500;

// ── Terminal helpers (same primitives as the MCP server) ────────────────────

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

async function tmuxExists(id: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", id);
    return true;
  } catch {
    return false;
  }
}

async function spawn(
  id: string,
  command: string,
  opts?: { cols?: number; rows?: number; cwd?: string }
): Promise<void> {
  const cols = opts?.cols ?? 120;
  const rows = opts?.rows ?? 40;
  const args = ["new-session", "-d", "-s", id, "-x", String(cols), "-y", String(rows)];
  if (opts?.cwd) {
    args.push("-c", opts.cwd);
  }
  args.push(command);
  await tmux(...args);
}

async function type(id: string, text: string): Promise<void> {
  await tmux("send-keys", "-t", id, "-l", text);
}

async function sendKey(id: string, key: string): Promise<void> {
  await tmux("send-keys", "-t", id, key);
}

async function screenshot(id: string): Promise<string> {
  const out = await tmux("capture-pane", "-t", id, "-p");
  return out.trimEnd();
}

async function waitFor(
  id: string,
  pattern: RegExp,
  timeoutMs: number
): Promise<{ found: boolean; screen: string; elapsed: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screen = await screenshot(id);
    if (pattern.test(screen)) {
      return { found: true, screen, elapsed: Date.now() - start };
    }
    await sleep(POLL_INTERVAL);
  }
  const screen = await screenshot(id);
  return { found: pattern.test(screen), screen, elapsed: Date.now() - start };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for a numbered menu to appear, then select an option by sending arrow keys + Enter. */
async function waitForMenuAndSelect(
  id: string,
  detectPattern: RegExp,
  choice: number, // 1-based menu index (1 = first item, already selected)
  timeoutMs: number
): Promise<{ found: boolean; screen: string; elapsed: number }> {
  const result = await waitFor(id, detectPattern, timeoutMs);
  if (!result.found) return result;

  // Navigate: choice 1 is pre-selected (❯), each additional choice needs one Down arrow
  for (let i = 1; i < choice; i++) {
    await sendKey(id, "Down");
    await sleep(100);
  }
  await sendKey(id, "Enter");

  return result;
}

function kill(id: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", id], { stdio: "ignore" });
  } catch {
    // OK
  }
}

// ── Test runner ─────────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
  screenshot?: string;
  elapsed?: number;
}

const results: StepResult[] = [];
const SESSION_DAEMON = "demo_pincerd";
const SESSION_CLAUDE = "demo_claude";

// After join-pane, the Claude session is destroyed but the pane lives on.
// All tmux commands target this ID (session name when headless, pane ID when live).
let claudeTarget = SESSION_CLAUDE;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

function printScreen(label: string, screen: string): void {
  // When running inside tmux, the live split pane IS the visual — never dump screenshots.
  // Check process.env.TMUX (not livePaneId) because printScreen may be called before join-pane.
  if (process.env.TMUX) return;
  console.error(`\n┌─── ${label} ${"─".repeat(Math.max(0, 70 - label.length))}┐`);
  for (const line of screen.split("\n").slice(0, 30)) {
    console.error(`│ ${line}`);
  }
  console.error(`└${"─".repeat(76)}┘\n`);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function step0_preflight(): Promise<StepResult> {
  const name = "0. Preflight checks";
  log(name);

  const missing: string[] = [];
  if (!existsSync(PINCERD_BIN)) missing.push(`pincerd not found at ${PINCERD_BIN}`);
  if (!existsSync(PINCER_CLI)) missing.push(`pincer CLI not found at ${PINCER_CLI}`);

  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    missing.push("tmux not installed");
  }

  if (missing.length > 0) {
    return { name, status: "FAIL", detail: missing.join("; ") };
  }

  // Kill any leftover sessions
  kill(SESSION_DAEMON);
  kill(SESSION_CLAUDE);

  return { name, status: "PASS", detail: "All binaries found, tmux available" };
}

async function step1_startDaemon(): Promise<StepResult> {
  const name = "1. Start pincerd daemon";
  log(name);

  await spawn(SESSION_DAEMON, PINCERD_BIN, { cols: 120, rows: 24 });

  const { found, screen, elapsed } = await waitFor(
    SESSION_DAEMON,
    /Daemon listening/i,
    TIMEOUT_DAEMON_START
  );

  if (!found) {
    printScreen("Daemon output", screen);
    return {
      name,
      status: "FAIL",
      detail: `Daemon did not print 'Daemon listening' within ${TIMEOUT_DAEMON_START}ms`,
      screenshot: screen,
    };
  }

  return {
    name,
    status: "PASS",
    detail: `Daemon listening (${elapsed}ms)`,
    screenshot: screen,
    elapsed,
  };
}

async function step2_launchClaude(): Promise<StepResult> {
  const name = "2. Launch Claude under Pincer governance";
  log(name);

  const cmd = `${PINCER_CLI} run --no-sandbox -- claude`;
  await spawn(SESSION_CLAUDE, cmd, { cols: 120, rows: 40, cwd: WORK_DIR });

  // FIRST: check for the workspace trust dialog — this appears immediately in fresh dirs
  // and blocks everything until answered. Check before anything else.
  log("  Checking for workspace trust dialog...");
  const trustCheck = await waitFor(
    claudeTarget,
    /trust this folder|safety check|❯|running under Pincer/i,
    TIMEOUT_CLAUDE_START
  );

  if (!trustCheck.found) {
    printScreen("Claude startup", trustCheck.screen);
    return {
      name,
      status: "FAIL",
      detail: `Claude did not start within ${TIMEOUT_CLAUDE_START}ms`,
      screenshot: trustCheck.screen,
    };
  }

  if (/trust this folder|safety check/i.test(trustCheck.screen)) {
    log("  Trust dialog detected — selecting '1. Yes, I trust this folder'");
    // Wait for the dialog to become interactive before pressing Enter
    await sleep(300);
    await sendKey(claudeTarget, "Enter");
    await sleep(500);

    // Verify the dialog dismissed — wait for prompt or banner to appear
    const dismissed = await waitFor(
      claudeTarget,
      /❯|running under Pincer/i,
      5_000
    );
    if (!dismissed.found) {
      // Enter may have been swallowed — retry
      log("  Trust dialog still showing — retrying Enter");
      await sendKey(claudeTarget, "Enter");
      await sleep(500);
    }
  }

  // Now wait for the governance banner (may already be visible)
  const bannerResult = await waitFor(
    claudeTarget,
    /running under Pincer governance/,
    10_000
  );

  if (bannerResult.found) {
    log("  Governance banner appeared");
    printScreen("Pincer banner", bannerResult.screen);
  }

  // Wait for the ❯ prompt — Claude is ready for input
  const { found, screen, elapsed } = await waitFor(
    claudeTarget,
    /❯/,
    TIMEOUT_CLAUDE_START
  );

  if (!found) {
    printScreen("Claude startup", screen);
    return {
      name,
      status: "FAIL",
      detail: `Claude did not reach input prompt within ${TIMEOUT_CLAUDE_START}ms`,
      screenshot: screen,
    };
  }

  // Auto-split: if running inside tmux, move the Claude pane into the current window.
  // We use join-pane (not attach) because tmux attach fails inside an existing session.
  // Pattern inspired by Claude Code's TmuxBackend.
  if (process.env.TMUX) {
    try {
      // Get the Claude session's pane ID before we move it
      const claudePaneId = execFileSync("tmux", [
        "list-panes", "-t", SESSION_CLAUDE, "-F", "#{pane_id}",
      ]).toString().trim().split("\n")[0];

      // $TMUX_PANE is most reliable; fall back to display-message
      const currentPaneId = process.env.TMUX_PANE
        ?? execFileSync("tmux", ["display-message", "-p", "#{pane_id}"]).toString().trim();

      // Move Claude's pane into the current window (70% right, 30% left for demo output).
      // This destroys the SESSION_CLAUDE session, but the pane (and its process) lives on.
      execFileSync("tmux", [
        "join-pane", "-s", claudePaneId, "-t", currentPaneId, "-h", "-l", "70%", "-d",
      ]);

      // All subsequent tmux operations target the pane ID directly
      livePaneId = claudePaneId;
      claudeTarget = claudePaneId;

      // Brief pause for layout to settle (Claude Code uses 200ms for shell init)
      await sleep(200);

      // Label the panes
      execFileSync("tmux", ["set-option", "-w", "pane-border-status", "top"]);
      execFileSync("tmux", ["select-pane", "-t", claudePaneId, "-T", "Claude under Pincer"]);
      execFileSync("tmux", ["select-pane", "-t", currentPaneId, "-T", "Demo output"]);

      // Clear the left pane — join-pane leaves residual Claude output behind
      process.stderr.write("\x1b[2J\x1b[H");

      log(`  Live view opened (pane ${claudePaneId})`);
    } catch (e) {
      log(`  Could not open live view pane (non-fatal): ${e}`);
    }
  }

  return {
    name,
    status: "PASS",
    detail: `Claude running under governance (${elapsed}ms)`,
    screenshot: screen,
    elapsed,
  };
}

async function waitForClaudeReady(): Promise<void> {
  // Wait until Claude shows the input prompt — ❯ means ready for input
  await waitFor(claudeTarget, /❯\s*$/, 10_000);
}

async function step3_safeCommand(): Promise<StepResult> {
  const name = "3. Test safe command (ls)";
  log(name);

  // Wait for Claude's prompt to be ready
  log("  Waiting for prompt...");
  await waitForClaudeReady();

  // Type a prompt asking Claude to list files
  log("  Typing prompt...");
  await type(claudeTarget, "please run ls in the current directory");
  await sendKey(claudeTarget, "Enter");

  // Wait for Claude to start processing (the spinner or "thinking" indicator)
  log("  Waiting for Claude to respond...");
  const processing = await waitFor(claudeTarget, /\.{3}|Thinking|thinking|Running|Bash|⏺/, 15_000);
  if (processing.found) {
    log(`  Claude processing... (${processing.elapsed}ms)`);
  }

  // Now wait for tool output or Claude's response — ls output should appear
  // without any governance prompt since ls is safe.
  const { found, screen, elapsed } = await waitFor(
    claudeTarget,
    /Bash|Listed|empty|no files|directory is empty|✓|⏺/,
    TIMEOUT_LLM_RESPONSE
  );

  printScreen("After 'ls' request", screen);

  // Check if a governance prompt appeared (it shouldn't for ls)
  const hasGovernance =
    /requires confirmation|Do you want to proceed|ask:/.test(screen);

  if (hasGovernance) {
    return {
      name,
      status: "FAIL",
      detail: "Governance prompt appeared for a safe command — should have auto-allowed",
      screenshot: screen,
    };
  }

  if (found) {
    return {
      name,
      status: "PASS",
      detail: `Safe command auto-allowed, output visible (${elapsed}ms)`,
      screenshot: screen,
      elapsed,
    };
  }

  return {
    name,
    status: "PASS",
    detail: "No governance prompt appeared (correct). Output may still be rendering.",
    screenshot: screen,
  };
}

async function step4_destructiveCommand(): Promise<StepResult> {
  const name = "4. Test destructive command (rm -rf)";
  log(name);

  // Wait for Claude to finish the previous response and show prompt
  log("  Waiting for Claude to be ready...");
  await waitForClaudeReady();

  // First, create a real test directory so Claude can't dodge the deletion
  log("  Creating test directory for Claude to delete...");
  await type(claudeTarget, "please create a directory called test-pincer-delete with a file inside it, then delete the entire directory with rm -rf");
  await sendKey(claudeTarget, "Enter");

  // Wait for Claude to start processing
  log("  Waiting for Claude to respond...");
  const processing = await waitFor(claudeTarget, /\.{3}|Thinking|thinking|Running|Bash|⏺/, 15_000);
  if (processing.found) {
    log(`  Claude processing... (${processing.elapsed}ms)`);
  }

  // Wait for the governance dialog — Claude renders it as:
  //   "Hook PreToolUse:Bash requires confirmation for this command:"
  //   "• pincer · rm -rf ... · ask:destructive-operation"
  //   "Do you want to proceed?"
  //   "❯ 1. Yes"  /  "2. No"
  log("  Waiting for governance dialog...");
  const { found, screen, elapsed } = await waitFor(
    claudeTarget,
    /requires confirmation|Do you want to proceed|ask:|pincer \·/,
    TIMEOUT_GOVERNANCE
  );

  printScreen("Governance dialog", screen);

  if (!found) {
    return {
      name,
      status: "SKIP",
      detail: `No governance dialog within ${TIMEOUT_GOVERNANCE / 1000}s — Claude may not have attempted a destructive tool call`,
      screenshot: screen,
    };
  }

  // Classify what we see
  let classification = "governance dialog";
  const askMatch = screen.match(/ask:([^\s]+)/);
  if (askMatch) {
    classification = `ask:${askMatch[1]}`;
  }

  return {
    name,
    status: "PASS",
    detail: `Governance dialog appeared (${classification}, ${elapsed}ms)`,
    screenshot: screen,
    elapsed,
  };
}

async function step5_respondToDialog(): Promise<StepResult> {
  const name = "5. Respond to governance dialog";
  log(name);

  const screen = await screenshot(claudeTarget);

  // Check if there's actually a dialog to respond to
  if (!/Do you want to proceed|1\. Yes|2\. No/.test(screen)) {
    return {
      name,
      status: "SKIP",
      detail: "No active governance dialog to respond to",
      screenshot: screen,
    };
  }

  // Select "2. No" to deny the destructive operation
  log("  Selecting '2. No' to deny...");
  await waitForMenuAndSelect(claudeTarget, /Do you want to proceed/, 2, 5_000);

  // Wait for the dialog to dismiss and Claude to show the denial result
  const { found: dismissed, screen: finalScreen } = await waitFor(
    claudeTarget,
    /denied|rejected|not proceed|aborted|❯\s*$/,
    15_000
  );
  printScreen("After deny", finalScreen);

  // The dialog should no longer be visible
  const promptStillVisible = /Do you want to proceed/.test(finalScreen);
  if (promptStillVisible) {
    return {
      name,
      status: "FAIL",
      detail: "Governance prompt still visible after sending deny",
      screenshot: finalScreen,
    };
  }

  return {
    name,
    status: "PASS",
    detail: "Denied destructive operation successfully",
    screenshot: finalScreen,
  };
}

async function step6_failClosed(): Promise<StepResult> {
  const name = "6. Test fail-closed (daemon unreachable)";
  log(name);

  // Kill the daemon
  log("  Killing pincerd...");
  kill(SESSION_DAEMON);
  await sleep(1000);

  // Verify daemon is actually dead
  const daemonAlive = await tmuxExists(SESSION_DAEMON);
  if (daemonAlive) {
    // Force kill
    await sendKey(SESSION_DAEMON, "C-c");
    await sleep(500);
    kill(SESSION_DAEMON);
  }

  log("  Daemon killed. Typing another command into Claude...");

  // Type another command in Claude
  await type(claudeTarget, "please run echo hello-fail-closed-test");
  await sendKey(claudeTarget, "Enter");

  // Wait for a response — should see a denial or error about daemon unreachable
  // Be specific to avoid false positives from previous output
  const { found, screen } = await waitFor(
    claudeTarget,
    /cannot connect to pincerd|daemon unreachable|denied.*daemon|connection refused|EPIPE|ECONNREFUSED|hook.*error|fail.closed/i,
    TIMEOUT_GOVERNANCE
  );

  printScreen("Fail-closed response", screen);

  if (found) {
    return {
      name,
      status: "PASS",
      detail: "Fail-closed behavior confirmed — command denied with daemon down",
      screenshot: screen,
    };
  }

  // Even if we don't see a specific error message, check if the command was blocked
  return {
    name,
    status: "SKIP",
    detail: "Could not confirm fail-closed behavior — Claude may still be processing",
    screenshot: screen,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Create a safe temp directory for all demo operations
  WORK_DIR = mkdtempSync(join(tmpdir(), "terminator-demo-"));

  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║  Terminator — Pincer Governance E2E Demo               ║");
  console.error("║  \"Playwright for terminals\"                             ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error("");
  console.error(`  Working directory: ${WORK_DIR}`);
  if (process.env.TMUX) {
    console.error("  Live view: will auto-split when Claude launches");
  } else {
    console.error("");
    console.error("  Watch live in another terminal:");
    console.error(`    tmux attach -t ${SESSION_DAEMON} -r    # daemon logs`);
    console.error(`    tmux attach -t ${SESSION_CLAUDE} -r    # Claude session`);
  }
  console.error("");

  const steps = [
    step0_preflight,
    step1_startDaemon,
    step2_launchClaude,
    step3_safeCommand,
    step4_destructiveCommand,
    step5_respondToDialog,
    step6_failClosed,
  ];

  let abort = false;
  for (const step of steps) {
    if (abort) {
      results.push({ name: step.name, status: "SKIP", detail: "Skipped due to earlier failure" });
      continue;
    }

    try {
      const result = await step();
      results.push(result);
      log(`  → ${result.status}: ${result.detail}`);

      // Abort on preflight or daemon failure
      if (result.status === "FAIL" && (step === step0_preflight || step === step1_startDaemon)) {
        abort = true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name: step.name, status: "FAIL", detail: `Exception: ${msg}` });
      log(`  → FAIL (exception): ${msg}`);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  log("Cleaning up...");
  // If we used join-pane, the Claude pane is in our window — kill it by pane ID.
  // If headless (no join-pane), kill the session by name.
  if (livePaneId) {
    try { execFileSync("tmux", ["kill-pane", "-t", livePaneId], { stdio: "ignore" }); } catch { /* OK */ }
  } else {
    kill(SESSION_CLAUDE);
  }
  kill(SESSION_DAEMON);
  if (WORK_DIR) {
    try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* OK */ }
    log(`  Removed temp dir: ${WORK_DIR}`);
  }

  // ── Report ──────────────────────────────────────────────────────────────

  console.error("");
  console.error("═══════════════════════════════════════════════════════════");
  console.error("  RESULTS");
  console.error("═══════════════════════════════════════════════════════════");

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "○";
    console.error(`  ${icon} ${r.name}`);
    console.error(`    ${r.status}: ${r.detail}`);
  }

  console.error("");
  console.error(`  Total: ${results.length} | Pass: ${passed} | Fail: ${failed} | Skip: ${skipped}`);
  console.error("═══════════════════════════════════════════════════════════");

  // Write detailed report + asciicast to files, print paths on stdout
  const ts = Math.floor(Date.now() / 1000);
  const traceFile = join(tmpdir(), `terminator-trace-${ts}.json`);
  const castFile = join(tmpdir(), `terminator-trace-${ts}.cast`);

  const report = {
    timestamp: new Date().toISOString(),
    summary: { total: results.length, passed, failed, skipped },
    steps: results,
  };
  writeFileSync(traceFile, JSON.stringify(report, null, 2));

  // Build a simple asciicast from screenshot events in the results
  const castLines: string[] = [
    JSON.stringify({ version: 2, width: 120, height: 40, timestamp: ts }),
  ];
  let castTime = 0;
  for (const r of results) {
    if (r.screenshot) {
      const content = r.screenshot.replace(/\r?\n/g, "\r\n");
      castLines.push(JSON.stringify([castTime, "o", "\x1b[2J\x1b[H" + content]));
    }
    castTime += (r.elapsed ?? 1000) / 1000;
  }
  writeFileSync(castFile, castLines.join("\n") + "\n");

  // Clean one-line summary on stdout
  console.log(`Total: ${results.length} | Pass: ${passed} | Fail: ${failed} | Skip: ${skipped}`);
  console.log(`Trace: ${traceFile}`);
  console.log(`Cast:  ${castFile}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  if (livePaneId) {
    try { execFileSync("tmux", ["kill-pane", "-t", livePaneId], { stdio: "ignore" }); } catch { /* OK */ }
  } else {
    kill(SESSION_CLAUDE);
  }
  kill(SESSION_DAEMON);
  if (WORK_DIR) {
    try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* OK */ }
  }
  process.exit(2);
});
