/**
 * Asciicast v2 writer — emits .cast files natively during recording.
 *
 * Format spec: https://docs.asciinema.org/manual/asciicast/v2/
 *
 * Header (first line):  {"version": 2, "width": 120, "height": 40, "timestamp": <unix>}
 * Event lines:          [<seconds>, "o"|"i", "<data>"]
 *   "o" = output (terminal renders this)
 *   "i" = input (what was typed)
 */

export class AsciicastWriter {
  private lines: string[] = [];
  private startTime: number;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.startTime = Date.now();

    // Write header
    this.lines.push(
      JSON.stringify({
        version: 2,
        width,
        height,
        timestamp: Math.floor(Date.now() / 1000),
      })
    );
  }

  /** Time offset in seconds since recording started. */
  private elapsed(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /** Record terminal output — what appears on screen. */
  output(data: string): void {
    this.lines.push(JSON.stringify([this.elapsed(), "o", data]));
  }

  /** Record user input — what was typed or sent. */
  input(data: string): void {
    this.lines.push(JSON.stringify([this.elapsed(), "i", data]));
  }

  /**
   * Record a full-screen frame from a screenshot.
   * Emits a clear-screen escape + the full content, so the player
   * renders a complete frame (not incremental).
   */
  frame(content: string): void {
    // ANSI: clear screen + move cursor to home
    const clear = "\x1b[2J\x1b[H";
    // Convert \n to \r\n for proper terminal rendering
    const normalized = content.replace(/\r?\n/g, "\r\n");
    this.output(clear + normalized);
  }

  /** Return the complete .cast file content. */
  toCast(): string {
    return this.lines.join("\n") + "\n";
  }

  /** Number of event lines (excluding header). */
  get eventCount(): number {
    return this.lines.length - 1;
  }
}
