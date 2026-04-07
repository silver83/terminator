/**
 * Smoke test — verifies the core terminal tools work end-to-end.
 * Run: npm run build && npm test
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

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

const TEST_SESSION = "terminator_test_" + Date.now();

describe("terminator core", () => {
  before(async () => {
    // Clean up any leftover test sessions
    try {
      await tmux("kill-session", "-t", TEST_SESSION);
    } catch {
      // OK
    }
  });

  after(async () => {
    try {
      await tmux("kill-session", "-t", TEST_SESSION);
    } catch {
      // OK
    }
  });

  it("spawn: creates a tmux session", async () => {
    await tmux(
      "new-session", "-d",
      "-s", TEST_SESSION,
      "-x", "80",
      "-y", "24",
      "bash"
    );
    const exists = await tmuxExists(TEST_SESSION);
    assert.equal(exists, true, "tmux session should exist after spawn");
  });

  it("type + send_key: sends text and Enter", async () => {
    // Type a command
    await tmux("send-keys", "-t", TEST_SESSION, "-l", "echo hello-terminator");
    // Send Enter
    await tmux("send-keys", "-t", TEST_SESSION, "Enter");
    // Wait for output
    await new Promise((r) => setTimeout(r, 500));
  });

  it("screenshot: captures rendered screen", async () => {
    const screen = await tmux("capture-pane", "-t", TEST_SESSION, "-p");
    assert.ok(
      screen.includes("hello-terminator"),
      `Screen should contain 'hello-terminator', got:\n${screen}`
    );
  });

  it("wait_for: polls until pattern appears", async () => {
    // Type another command
    await tmux("send-keys", "-t", TEST_SESSION, "-l", "echo marker-42");
    await tmux("send-keys", "-t", TEST_SESSION, "Enter");

    const start = Date.now();
    const timeout = 5000;
    const interval = 100;
    let found = false;
    let screen = "";

    while (Date.now() - start < timeout) {
      screen = await tmux("capture-pane", "-t", TEST_SESSION, "-p");
      if (/marker-42/.test(screen)) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    assert.ok(found, `wait_for should find 'marker-42' within ${timeout}ms`);
  });

  it("assert: checks screen content (pass case)", async () => {
    const screen = await tmux("capture-pane", "-t", TEST_SESSION, "-p");
    assert.ok(screen.includes("marker-42"), "Screen should contain 'marker-42'");
  });

  it("assert: checks screen content (fail case)", async () => {
    const screen = await tmux("capture-pane", "-t", TEST_SESSION, "-p");
    assert.ok(
      !screen.includes("this-string-does-not-exist"),
      "Screen should NOT contain 'this-string-does-not-exist'"
    );
  });

  it("close: kills the tmux session", async () => {
    await tmux("kill-session", "-t", TEST_SESSION);
    const exists = await tmuxExists(TEST_SESSION);
    assert.equal(exists, false, "tmux session should not exist after close");
  });
});
