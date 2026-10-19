import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@altair/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, type ParseState } from "../src/clis";
import { loadConfig, type RunnerConfig, SessionStore, saveConfig, shareFolder, unshareFolder } from "../src/config";
import { RUNNER_VERSION } from "../src/runner";
import { sharedFolder, TaskRunner } from "../src/tasks";
import { isNewer } from "../src/update";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altair-runner-"));
  process.env.ALTAIR_RUNNER_HOME = home;
});

describe("config", () => {
  it("shares and unshares folders by absolute path", async () => {
    const config = await loadConfig();
    expect(config).toEqual({ folders: [], access: "edit" });
    expect(shareFolder(config, "/tmp/project/../project")).toBe(true);
    expect(shareFolder(config, "/tmp/project")).toBe(false);
    expect(config.folders).toEqual([{ path: "/tmp/project", name: "project" }]);
    await saveConfig(config);
    expect((await loadConfig()).folders).toHaveLength(1);
    expect(unshareFolder(config, "/tmp/project")).toBe(true);
  });
});

describe("env overrides", () => {
  it("uses ALTAIR_SERVER and ALTAIR_RUNNER_TOKEN without saving the token", async () => {
    await saveConfig({ folders: [], access: "edit", server: "https://saved.example", token: "art_saved" });
    process.env.ALTAIR_SERVER = "https://env.example";
    process.env.ALTAIR_RUNNER_TOKEN = "art_env";
    try {
      const config = await loadConfig();
      expect(config).toMatchObject({ server: "https://env.example", token: "art_env" });
      shareFolder(config, "/tmp/x");
      await saveConfig(config);
      delete process.env.ALTAIR_RUNNER_TOKEN;
      expect((await loadConfig()).token).toBe("art_saved");
    } finally {
      delete process.env.ALTAIR_SERVER;
      delete process.env.ALTAIR_RUNNER_TOKEN;
    }
  });
});

describe("sharedFolder", () => {
  it("accepts only folders the user shared, after resolving symlinks and ..", async () => {
    const shared = join(home, "code");
    await mkdir(join(shared, "sub"), { recursive: true });
    const config: RunnerConfig = { folders: [{ path: shared, name: "code" }], access: "edit" };
    expect(await sharedFolder(config, shared)).toBeTruthy();
    expect(await sharedFolder(config, join(shared, "sub", ".."))).toBeTruthy();
    expect(await sharedFolder(config, join(shared, "sub"))).toBeNull();
    expect(await sharedFolder(config, home)).toBeNull();
    expect(await sharedFolder(config, "/does/not/exist")).toBeNull();
  });
});

describe("CLI output parsing", () => {
  it("reads Claude Code stream-json", () => {
    const state: ParseState = {};
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "result", subtype: "success", is_error: false, result: "All 12 tests pass.", session_id: "s-1" },
    ];
    lines.forEach((l, i) => {
      ADAPTERS.claude.line(JSON.stringify(l), state);
      if (i === 1) expect(state.progress).toBe("Bash: pnpm test");
    });
    expect(state).toMatchObject({ sessionId: "s-1", result: "All 12 tests pass.", failed: false });
    expect(ADAPTERS.claude.args({ access: "edit", resume: "s-1" })).toEqual(
      expect.arrayContaining(["--permission-mode", "acceptEdits", "--resume", "s-1"]),
    );
  });

  it("reads Codex JSONL and Gemini JSON", () => {
    const codex: ParseState = {};
    ADAPTERS.codex.line(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }), codex);
    expect(codex.progress).toBe("$ ls");
    ADAPTERS.codex.line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }), codex);
    expect(codex.result).toBe("Done.");

    const gemini: ParseState = {};
    ADAPTERS.gemini.end!(JSON.stringify({ response: "Merhaba" }), gemini);
    expect(gemini.result).toBe("Merhaba");
  });
});

describe.skipIf(process.platform === "win32")("TaskRunner", () => {
  /** A stand-in `claude` on PATH that echoes its prompt and cwd as stream-json. */
  async function fakeClaude(script: string) {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  async function run(config: RunnerConfig, folder: string, threadId = "thr_01JTEST0000000000000000000") {
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    await runner.start({
      type: "task.start",
      taskId: "task_01JTEST0000000000000000000",
      threadId,
      folder,
      cli: "claude",
      prompt: "fix the bug",
    });
    return frames;
  }

  it("stops a task when the server asks", async () => {
    await fakeClaude("read prompt\nsleep 30");
    const folder = join(home, "proj");
    await mkdir(folder);
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit" };
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    const taskId = "task_01JTEST0000000000000000001";
    const done = runner.start({ type: "task.start", taskId, threadId: "thr_01JTEST0000000000000000000", folder, cli: "claude", prompt: "x" });
    for (let i = 0; i < 100 && !runner.runningIds().includes(taskId); i++) await new Promise((r) => setTimeout(r, 10));
    runner.cancel(taskId);
    await done;
    expect(frames.at(-1)).toEqual({ type: "task.done", taskId, ok: false, cancelled: true, result: "Stopped from Altair." });
    expect(runner.runningIds()).toEqual([]);
  });

  it("runs the CLI in the shared folder with the prompt on stdin and reports the result", async () => {
    await fakeClaude(
      `read prompt
echo '{"type":"system","subtype":"init","session_id":"sess-42"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it"}]}}'
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s in %s"}\\n' "$prompt" "$(pwd)"`,
    );
    const folder = join(home, "proj");
    await mkdir(folder);
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit" };

    const frames = await run(config, folder);
    expect(frames.at(-1)).toMatchObject({ type: "task.done", ok: true });
    expect((frames.at(-1) as { result: string }).result).toMatch(/^fix the bug in .*proj$/);
    // The thread's next task resumes the same CLI session.
    expect(await new SessionStore().get("thr_01JTEST0000000000000000000")).toBe("sess-42");
  });

  it("refuses folders that are not shared and reports a failing CLI", async () => {
    await fakeClaude(`echo "boom" >&2; exit 3`);
    const folder = join(home, "proj2");
    await mkdir(folder);
    const unshared = await run({ folders: [], access: "edit" }, folder);
    expect(unshared).toEqual([expect.objectContaining({ type: "task.done", ok: false })]);
    expect((unshared[0] as { result: string }).result).toContain("not shared");

    const failed = await run({ folders: [{ path: folder, name: "proj2" }], access: "edit" }, folder);
    expect(failed.at(-1)).toMatchObject({ type: "task.done", ok: false });
    expect((failed.at(-1) as { result: string }).result).toContain("boom");
  });
});

describe("package", () => {
  it("reports the version it is published as", async () => {
    const versions = await Promise.all(
      ["../package.json", "../../altair-runner-alias/package.json"].map(async (p) => {
        const pkg = JSON.parse(await readFile(new URL(p, import.meta.url), "utf8")) as { version: string };
        return pkg.version;
      }),
    );
    expect(versions).toEqual([RUNNER_VERSION, RUNNER_VERSION]);
  });
});

describe("update", () => {
  it("compares versions", () => {
    expect(isNewer("0.3.0", "0.2.9")).toBe(true);
    expect(isNewer("0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.2", "0.2.2")).toBe(false);
    expect(isNewer("0.2.1", "0.2.2")).toBe(false);
    expect(isNewer("0.3.0-beta.1", "0.2.2")).toBe(true);
  });
});
