import { execFile } from "node:child_process";
import type { CliId, RunnerCli } from "@altair/protocol";
import type { Access } from "./config";

/** What a CLI's output told us so far. */
export type ParseState = {
  /** The latest human-readable step, e.g. "Edit src/app.ts". */
  progress?: string;
  /** Session id to resume this conversation later, when the CLI supports it. */
  sessionId?: string;
  /** Final answer, once the CLI printed it. */
  result?: string;
  /** True when the CLI reported a failure in its own output. */
  failed?: boolean;
};

/**
 * One coding CLI. Every adapter takes the prompt on stdin, so prompts never pass
 * through a shell or get mistaken for flags. Logins stay with the CLI itself.
 */
export type CliAdapter = {
  id: CliId;
  bin: string;
  args(opts: { access: Access; resume?: string }): string[];
  /** Feeds one line of stdout; updates `state` in place. */
  line(line: string, state: ParseState): void;
  /** Called with all of stdout when the CLI exits, for CLIs that print one JSON document. */
  end?(stdout: string, state: ParseState): void;
};

const claude: CliAdapter = {
  id: "claude",
  bin: "claude",
  args: ({ access, resume }) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    { read: "plan", edit: "acceptEdits", full: "bypassPermissions" }[access],
    ...(resume ? ["--resume", resume] : []),
  ],
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.type === "assistant") {
      const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "tool_use") state.progress = describeTool(String(part.name), part.input);
        else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          state.progress = firstLine(part.text);
        }
      }
    }
    if (event.type === "result") {
      state.result = typeof event.result === "string" ? event.result : "";
      state.failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
    }
  },
};

const codex: CliAdapter = {
  id: "codex",
  bin: "codex",
  args: ({ access }) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    { read: "read-only", edit: "workspace-write", full: "danger-full-access" }[access],
    "-",
  ],
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (event.type === "thread.started" && typeof event.thread_id === "string") state.sessionId = event.thread_id;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution" && typeof item.command === "string") state.progress = `$ ${item.command}`;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      state.result = item.text;
      state.progress = firstLine(item.text);
    }
    if (event.type === "turn.failed" || event.type === "error") {
      state.failed = true;
      const message = (event.error as { message?: string } | undefined)?.message ?? event.message;
      if (typeof message === "string") state.result = message;
    }
  },
};

const gemini: CliAdapter = {
  id: "gemini",
  bin: "gemini",
  args: ({ access }) => [
    "--output-format",
    "json",
    "--approval-mode",
    { read: "default", edit: "auto_edit", full: "yolo" }[access],
  ],
  line() {},
  end(stdout, state) {
    const doc = parseJson(stdout.trim());
    if (doc && typeof doc.response === "string") state.result = doc.response;
    if (doc?.error) {
      state.failed = true;
      state.result = String((doc.error as { message?: string }).message ?? doc.error);
    }
  },
};

export const ADAPTERS: Record<CliId, CliAdapter> = { claude, codex, gemini };

/** Which CLIs are installed, by running `<bin> --version`. */
export async function detectClis(): Promise<RunnerCli[]> {
  const found = await Promise.all(
    Object.values(ADAPTERS).map(
      (a) =>
        new Promise<RunnerCli | null>((resolve) => {
          execFile(a.bin, ["--version"], { timeout: 10_000, shell: process.platform === "win32" }, (err, stdout) => {
            resolve(err ? null : { id: a.id, version: firstLine(stdout) || null });
          });
        }),
    ),
  );
  return found.filter((c): c is RunnerCli => c !== null);
}

function parseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description;
  return typeof detail === "string" ? `${name}: ${firstLine(detail)}` : name;
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}
