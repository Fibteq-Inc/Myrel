import { type RunnerEvent, RunnerEvent as RunnerEventSchema } from "./spec";

/** Prefix of a line that carries a RunnerEvent as JSON. Task scripts print these between harness output. */
export const MARKER = "::myrel::";

export function formatMarker(event: RunnerEvent): string {
  return `${MARKER}${JSON.stringify(event)}`;
}

/** The event on a marker line, or null when the line is not a (valid) marker. */
export function parseMarker(line: string): RunnerEvent | null {
  if (!line.startsWith(MARKER)) return null;
  try {
    const parsed = RunnerEventSchema.safeParse(JSON.parse(line.slice(MARKER.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Splits a byte or text stream into lines. Feed chunks with `push`, then call `end`. */
export class LineSplitter {
  private buffer = "";
  private decoder = new TextDecoder();

  push(chunk: string | Uint8Array): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map(stripCr);
  }

  end(): string[] {
    const rest = this.buffer + this.decoder.decode();
    this.buffer = "";
    return rest ? [stripCr(rest)] : [];
  }
}

function stripCr(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
