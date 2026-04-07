/**
 * E2E test — drives the MCP server via the SDK client to verify
 * the full JSON-RPC flow works end-to-end.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

let client: Client;
let sessionId: string;

describe("terminator MCP E2E", () => {
  it("connects to the server", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["build/index.js"],
    });

    client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(transport);
  });

  it("lists 7 tools", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7, `Expected 7 tools, got ${tools.length}`);

    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "terminal_assert",
      "terminal_close",
      "terminal_screenshot",
      "terminal_send_key",
      "terminal_spawn",
      "terminal_type",
      "terminal_wait_for",
    ]);
  });

  it("spawns a bash session", async () => {
    const result = await client.callTool({
      name: "terminal_spawn",
      arguments: { command: "bash", cols: 80, rows: 24 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.ok(data.session_id, "Should return a session_id");
    assert.equal(data.cols, 80);
    assert.equal(data.rows, 24);
    sessionId = data.session_id;
  });

  it("types text into the terminal", async () => {
    const result = await client.callTool({
      name: "terminal_type",
      arguments: { session_id: sessionId, text: "echo hello-mcp-e2e" },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(data, { ok: true });
  });

  it("sends Enter key", async () => {
    const result = await client.callTool({
      name: "terminal_send_key",
      arguments: { session_id: sessionId, key: "enter" },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(data, { ok: true });
  });

  it("waits for output to appear", async () => {
    const result = await client.callTool({
      name: "terminal_wait_for",
      arguments: {
        session_id: sessionId,
        pattern: "hello-mcp-e2e",
        timeout_ms: 5000,
      },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(data.found, true, "Pattern should be found on screen");
    assert.ok(data.screen.includes("hello-mcp-e2e"), "Screen should contain the output");
  });

  it("takes a screenshot", async () => {
    const result = await client.callTool({
      name: "terminal_screenshot",
      arguments: { session_id: sessionId },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.ok(data.screen, "Screenshot should return screen content");
    assert.equal(data.rows, 24);
    assert.equal(data.cols, 80);
    assert.ok(data.screen.includes("hello-mcp-e2e"), "Screen should contain the output");
  });

  it("asserts text is on screen (pass)", async () => {
    const result = await client.callTool({
      name: "terminal_assert",
      arguments: { session_id: sessionId, text: "hello-mcp-e2e" },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(data.pass, true);
    assert.ok(data.message.startsWith("PASS"));
  });

  it("asserts text is on screen (fail)", async () => {
    const result = await client.callTool({
      name: "terminal_assert",
      arguments: { session_id: sessionId, text: "nonexistent-text-xyz" },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(data.pass, false);
    assert.ok(data.message.startsWith("FAIL"));
  });

  it("asserts with regex", async () => {
    const result = await client.callTool({
      name: "terminal_assert",
      arguments: {
        session_id: sessionId,
        text: "hello-mcp-e2e",
        regex: true,
      },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(data.pass, true);
  });

  it("closes the session", async () => {
    const result = await client.callTool({
      name: "terminal_close",
      arguments: { session_id: sessionId },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(data, { ok: true });
  });

  it("screenshot on closed session returns error", async () => {
    const result = await client.callTool({
      name: "terminal_screenshot",
      arguments: { session_id: sessionId },
    });

    assert.equal(result.isError, true);
  });

  after(async () => {
    // Clean up client connection
    try {
      await client.close();
    } catch {
      // OK
    }
  });
});
