/**
 * Claude Code's streaming input (`claude -p --input-format stream-json --replay-user-messages`):
 * the prompt goes in as the first user message, and stdin stays open while the turn runs, so
 * people's new messages can go in mid-turn ("task.steer") and the turn can be stopped without
 * killing the process (an interrupt control request, which leaves the session whole).
 *
 * Claude Code gives a message written mid-turn to the model at its next step (after the running
 * tool's result) and echoes it back on stdout once it did (--replay-user-messages). One written as
 * the turn ends starts another turn in the same process, so stdin is ended only once every message
 * written was echoed back and a result came after it.
 */

type Io = { write(line: string): void; end(): void };

export class ClaudeStreamTurn {
  /** Messages written on stdin, the prompt included, and how many Claude Code echoed back. */
  private written = 0;
  private echoed = 0;
  private ended = false;
  private stopping = false;
  private requests = 0;

  constructor(
    private readonly io: Io,
    private readonly prompt: string,
  ) {}

  start(): void {
    this.user(this.prompt);
  }

  /**
   * Adds people's new message to the running turn. True when it went in: Claude Code reads it at its
   * next step, or right after this turn in the same process. False once the turn is over or stopping.
   */
  steer(text: string): Promise<boolean> {
    if (this.ended || this.stopping) return Promise.resolve(false);
    this.user(text);
    return Promise.resolve(true);
  }

  /** Stops the turn the way Claude Code's own Esc does; true when the request went. */
  interrupt(): boolean {
    if (this.ended) return false;
    this.stopping = true;
    this.io.write(`${JSON.stringify({ type: "control_request", request_id: `myrel-${++this.requests}`, request: { subtype: "interrupt" } })}\n`);
    return true;
  }

  /** One parsed line of Claude Code's stdout. */
  receive(event: Record<string, unknown>): void {
    if (this.ended) return;
    // Echoes carry isReplay; tool results and Claude Code's own notes ("[Request interrupted…]") do not.
    if (event.type === "user" && event.isReplay === true) this.echoed++;
    // Done when nothing written is still waiting for its turn (or the turn is being stopped).
    if (event.type === "result" && (this.stopping || this.echoed >= this.written)) this.end();
  }

  /** Ends stdin, so Claude Code exits once it is done. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.io.end();
  }

  private user(text: string) {
    this.written++;
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" };
    this.io.write(`${JSON.stringify(message)}\n`);
  }
}
