/**
 * Tests for the Recorder class — verifies trace collection, filtering, and timing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "./recorder.js";

describe("Recorder", () => {
  it("records events with ascending t_ms timestamps", () => {
    const rec = new Recorder();
    rec.record({ event: "spawn", session: "s1", command: "bash" });
    rec.record({ event: "type", session: "s1", text: "hello" });

    const trace = rec.getTrace();
    assert.equal(trace.length, 2);
    assert.equal(trace[0].event, "spawn");
    assert.equal(trace[1].event, "type");
    assert.ok(trace[0].t_ms <= trace[1].t_ms, "timestamps should be non-decreasing");
  });

  it("preserves custom fields on events", () => {
    const rec = new Recorder();
    rec.record({ event: "wait_for_found", session: "s1", pattern: "hello", wait_ms: 450 });

    const trace = rec.getTrace();
    assert.equal(trace[0].pattern, "hello");
    assert.equal(trace[0].wait_ms, 450);
  });

  it("filters trace by session", () => {
    const rec = new Recorder();
    rec.record({ event: "spawn", session: "daemon" });
    rec.record({ event: "spawn", session: "claude" });
    rec.record({ event: "type", session: "claude", text: "ls" });
    rec.record({ event: "screenshot", session: "daemon" });

    const claudeTrace = rec.getTraceForSession("claude");
    assert.equal(claudeTrace.length, 2);
    assert.ok(claudeTrace.every((e) => e.session === "claude"));

    const daemonTrace = rec.getTraceForSession("daemon");
    assert.equal(daemonTrace.length, 2);
  });

  it("returns empty trace for unknown session", () => {
    const rec = new Recorder();
    rec.record({ event: "spawn", session: "s1" });

    const trace = rec.getTraceForSession("nonexistent");
    assert.equal(trace.length, 0);
  });

  it("reports length correctly", () => {
    const rec = new Recorder();
    assert.equal(rec.length, 0);
    rec.record({ event: "spawn", session: "s1" });
    assert.equal(rec.length, 1);
    rec.record({ event: "close", session: "s1" });
    assert.equal(rec.length, 2);
  });

  it("clears all events and resets timeline", async () => {
    const rec = new Recorder();
    rec.record({ event: "spawn", session: "s1" });
    rec.record({ event: "type", session: "s1", text: "foo" });
    assert.equal(rec.length, 2);

    rec.clear();
    assert.equal(rec.length, 0);
    assert.deepEqual(rec.getTrace(), []);

    // New events after clear should start from ~0 t_ms
    rec.record({ event: "spawn", session: "s2" });
    const trace = rec.getTrace();
    assert.equal(trace.length, 1);
    assert.ok(trace[0].t_ms < 50, "t_ms after clear should be near 0");
  });

  it("does nothing when disabled", () => {
    const rec = new Recorder({ enabled: false });
    rec.record({ event: "spawn", session: "s1" });
    rec.record({ event: "type", session: "s1", text: "hello" });
    assert.equal(rec.length, 0);
    assert.deepEqual(rec.getTrace(), []);
  });

  it("returns a copy of the trace (not a reference)", () => {
    const rec = new Recorder();
    rec.record({ event: "spawn", session: "s1" });

    const trace1 = rec.getTrace();
    rec.record({ event: "close", session: "s1" });
    const trace2 = rec.getTrace();

    assert.equal(trace1.length, 1, "first snapshot should not be mutated");
    assert.equal(trace2.length, 2);
  });
});
