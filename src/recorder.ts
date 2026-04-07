/**
 * Session recorder — captures a structured trace of all terminal operations
 * with millisecond timestamps for post-hoc analysis by humans or AI agents.
 */

export interface TraceEvent {
  t_ms: number;
  event: string;
  session: string;
  [key: string]: unknown;
}

export class Recorder {
  private events: TraceEvent[] = [];
  private startTime: number;
  private enabled: boolean;

  constructor(opts?: { enabled?: boolean }) {
    this.startTime = Date.now();
    this.enabled = opts?.enabled ?? true;
  }

  record(fields: { event: string; session: string; [key: string]: unknown }): void {
    if (!this.enabled) return;
    this.events.push({
      ...fields,
      t_ms: Date.now() - this.startTime,
      event: fields.event,
      session: fields.session,
    });
  }

  getTrace(): TraceEvent[] {
    return [...this.events];
  }

  getTraceForSession(session: string): TraceEvent[] {
    return this.events.filter((e) => e.session === session);
  }

  get length(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.startTime = Date.now();
  }
}
