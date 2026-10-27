import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeStreamTurn } from "../src/claude-stream";
import { ADAPTERS, hasStreamInput } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-claude-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.MYREL_CLAUDE_ONESHOT;
});

/** A streaming turn whose stdin lines are collected. */
function turn() {
  const sent: Record<string, unknown>[] = [];
  let ended = false;
  const t = new ClaudeStreamTurn(
    { write: (line) => sent.push(JSON.parse(line) as Record<string, unknown>), end: () => (ended = true) },
    "fix the bug",
  );
  const text = (m: Record<string, unknown>) => ((m.message as { content: { text: string }[] }).content[0]!.text);
  return { t, sent, text, ended: () => ended };
}

const echo = (text: string) => ({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } });
const result = { type: "result", subtype: "success", result: "done" };

describe("Claude Code's streaming input", () => {
  it("writes the prompt as the first user message and ends stdin after the result", () => {
    const a = turn();
    a.t.start();
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toMatchObject({ type: "user", parent_tool_use_id: null });
    expect(a.text(a.sent[0]!)).toBe("fix the bug");
    a.t.receive(echo("fix the bug"));
    expect(a.ended()).toBe(false);
    a.t.receive(result);
    expect(a.ended()).toBe(true);
  });

  it("hands new messages to the running turn, and keeps stdin open until each had its turn", async () => {
    const a = turn();
    a.t.start();
    a.t.receive(echo("fix the bug"));
    expect(await a.t.steer("README'yi de güncelle")).toBe(true);
    expect(a.text(a.sent[1]!)).toBe("README'yi de güncelle");
    // A tool's result is not an echo.
    a.t.receive({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    // The turn ended before Claude Code took the message: it runs it next, in the same process.
    a.t.receive(result);
    expect(a.ended()).toBe(false);
    a.t.receive(echo("README'yi de güncelle"));
    a.t.receive(result);
    expect(a.ended()).toBe(true);
    expect(await a.t.steer("too late")).toBe(false);
    expect(a.sent).toHaveLength(2);
  });

  it("stops the turn with an interrupt request, takes no more messages, and ends at its result", async () => {
    const a = turn();
    a.t.start();
    a.t.receive(echo("fix the bug"));
    await a.t.steer("waiting");
    expect(a.t.interrupt()).toBe(true);
    expect(a.sent[2]).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    expect(await a.t.steer("x")).toBe(false);
    // Claude Code's own note on the stop is not an echo; the result ends it even with a message unread.
    a.t.receive({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    a.t.receive({ type: "result", subtype: "error_during_execution" });
    expect(a.ended()).toBe(true);
    expect(a.t.interrupt()).toBe(false);
  });

  it("adds the streaming flags only when asked", () => {
    const plain = ADAPTERS.claude.args({ access: "edit" });
    expect(plain).not.toContain("--input-format");
    const stream = ADAPTERS.claude.args({ access: "edit", stream: true, resume: "s-1" });
    expect(stream).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--replay-user-messages", "--resume", "s-1"]));
  });
});

describe.skipIf(process.platform === "win32")("TaskRunner with Claude Code's streaming input", () => {
  /**
   * A stand-in `claude` alone on PATH. With streaming input it echoes each message, waits a little
   * as if a tool ran, then answers with every message it got; an interrupt request ends the turn.
   */
  async function fakeClaude(streams = true) {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const marks = join(home, "marks.txt");
    const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("${streams ? "2.1.310" : "1.0.0"} (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log(${streams} ? "--replay-user-messages  Re-emit user messages" : "--print"); process.exit(0); }
const send = (m) => process.stdout.write(JSON.stringify({ session_id: "sess-1", ...m }) + "\\n");
fs.appendFileSync(${JSON.stringify(marks)}, "args " + JSON.stringify(args) + "\\n");
if (!args.includes("--input-format")) {
  let input = ""; process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => { send({ type: "result", subtype: "success", result: "oneshot: " + input }); process.exit(0); });
  return;
}
const got = []; let buf = ""; let busy = false; let stopped = false;
const turn = () => {
  busy = true;
  setTimeout(() => {
    if (stopped) return;
    const taken = got.splice(0);
    for (const t of taken) send({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: t }] } });
    busy = false;
    send({ type: "result", subtype: "success", result: "got: " + taken.join(" | ") });
  }, 400);
};
process.stdin.on("data", (c) => {
  buf += c; const lines = buf.split("\\n"); buf = lines.pop();
  for (const l of lines) {
    const m = JSON.parse(l);
    if (m.type === "control_request") {
      fs.appendFileSync(${JSON.stringify(marks)}, "interrupt\\n");
      stopped = true;
      send({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
      send({ type: "result", subtype: "error_during_execution" });
      continue;
    }
    got.push(m.message.content[0].text);
    if (!busy) turn();
  }
});
process.stdin.on("end", () => process.exit(0));
`;
    await writeFile(join(bin, "claude"), script);
    await chmod(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    return { marks: () => readFile(marks, "utf8").catch(() => "") };
  }

  function runner(folder: string) {
    const frames: RunnerToServer[] = [];
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit", worktrees: false };
    const tasks = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    tasks.setSender((f) => frames.push(f));
    const start = () =>
      tasks.start({ type: "task.start", taskId: "task_01JTEST0000000000000000009", threadId: "thr_01JTEST0000000000000000000", folder, cli: "claude", prompt: "fix the bug" });
    const done = () => frames.find((f) => f.type === "task.done") as { ok: boolean; result: string; cancelled?: boolean } | undefined;
    return { tasks, start, done };
  }

  async function folder() {
    const f = join(home, "proj");
    await mkdir(f, { recursive: true });
    return f;
  }

  it("takes a message written while the turn runs into the same run", async () => {
    await fakeClaude();
    const r = runner(await folder());
    const running = r.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await r.tasks.steer("task_01JTEST0000000000000000009", "README'yi de güncelle")).toBe(true);
    await running;
    expect(r.done()).toMatchObject({ ok: true });
    // The prompt's turn took it, or the next one in the same process did.
    expect(r.done()!.result).toContain("README'yi de güncelle");
    expect(await new SessionStore().get("thr_01JTEST0000000000000000000", "claude")).toMatchObject({ id: "sess-1" });
    expect(await r.tasks.steer("task_01JTEST0000000000000000009", "after")).toBe(false);
  });

  it("stops a turn with an interrupt request instead of killing it", async () => {
    const fake = await fakeClaude();
    const r = runner(await folder());
    const running = r.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    r.tasks.cancel("task_01JTEST0000000000000000009");
    await running;
    expect(r.done()).toMatchObject({ ok: false, cancelled: true });
    expect(await fake.marks()).toContain("interrupt");
  });

  it("keeps the prompt on a stdin that ends at once where Claude Code has no streaming input, or when MYREL_CLAUDE_ONESHOT=1", async () => {
    await fakeClaude(false);
    expect(await hasStreamInput("claude")).toBe(false);
    const r = runner(await folder());
    await r.start();
    expect(r.done()!.result).toBe("oneshot: fix the bug");
    await fakeClaude(true);
    process.env.MYREL_CLAUDE_ONESHOT = "1";
    expect(await hasStreamInput("claude")).toBe(false);
  });
});
