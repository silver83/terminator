/**
 * Tests for AsciicastWriter — verifies asciicast v2 format output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsciicastWriter } from "./asciicast.js";

describe("AsciicastWriter", () => {
  it("writes a valid header as the first line", () => {
    const w = new AsciicastWriter(120, 40);
    const lines = w.toCast().trim().split("\n");
    const header = JSON.parse(lines[0]);

    assert.equal(header.version, 2);
    assert.equal(header.width, 120);
    assert.equal(header.height, 40);
    assert.ok(typeof header.timestamp === "number");
  });

  it("records output events with ascending timestamps", async () => {
    const w = new AsciicastWriter(80, 24);
    w.output("hello");
    await new Promise((r) => setTimeout(r, 10));
    w.output("world");

    const lines = w.toCast().trim().split("\n");
    assert.equal(lines.length, 3); // header + 2 events

    const ev1 = JSON.parse(lines[1]);
    const ev2 = JSON.parse(lines[2]);
    assert.equal(ev1[1], "o");
    assert.equal(ev1[2], "hello");
    assert.equal(ev2[1], "o");
    assert.equal(ev2[2], "world");
    assert.ok(ev1[0] <= ev2[0], "timestamps should be non-decreasing");
  });

  it("records input events", () => {
    const w = new AsciicastWriter(80, 24);
    w.input("ls -la");

    const lines = w.toCast().trim().split("\n");
    const ev = JSON.parse(lines[1]);
    assert.equal(ev[1], "i");
    assert.equal(ev[2], "ls -la");
  });

  it("frame() emits clear-screen + content with \\r\\n", () => {
    const w = new AsciicastWriter(80, 24);
    w.frame("line1\nline2\nline3");

    const lines = w.toCast().trim().split("\n");
    const ev = JSON.parse(lines[1]);
    assert.equal(ev[1], "o");
    // Should start with ANSI clear + home
    assert.ok(ev[2].startsWith("\x1b[2J\x1b[H"));
    // Content should have \r\n line endings
    assert.ok(ev[2].includes("line1\r\nline2\r\nline3"));
  });

  it("frame() handles content that already has \\r\\n", () => {
    const w = new AsciicastWriter(80, 24);
    w.frame("a\r\nb\r\nc");

    const lines = w.toCast().trim().split("\n");
    const ev = JSON.parse(lines[1]);
    // Should not double up \r\n
    assert.ok(ev[2].includes("a\r\nb\r\nc"));
    assert.ok(!ev[2].includes("\r\r\n"));
  });

  it("eventCount excludes the header", () => {
    const w = new AsciicastWriter(80, 24);
    assert.equal(w.eventCount, 0);

    w.output("a");
    assert.equal(w.eventCount, 1);

    w.input("b");
    assert.equal(w.eventCount, 2);

    w.frame("c");
    assert.equal(w.eventCount, 3);
  });

  it("toCast() ends with a trailing newline", () => {
    const w = new AsciicastWriter(80, 24);
    w.output("test");
    const cast = w.toCast();
    assert.ok(cast.endsWith("\n"));
  });

  it("stores terminal dimensions", () => {
    const w = new AsciicastWriter(132, 50);
    assert.equal(w.width, 132);
    assert.equal(w.height, 50);
  });
});
