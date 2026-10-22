import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  emptyProgress,
  formatMarker,
  LineSplitter,
  opencode,
  opencodeConfig,
  parseLine,
  parseMarker,
  PLAN_PLUGIN,
  reduceTask,
  renderChecklist,
  type RunnerEvent,
  SETUP_NOTE,
  shell,
  taskBranch,
  taskEnv,
  STOP_HARNESS_SCRIPT,
  taskScript,
  TaskSpec,
} from "../src";

const spec = (over: Partial<TaskSpec> = {}) =>
  TaskSpec.parse({ taskId: "task_01JABCDEFGHJKMNPQRSTVWXYZ", title: "Fix the login bug", prompt: "Fix it", ...over });

describe("lines", () => {
  it("splits chunks into lines across boundaries", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb")).toEqual(["a"]);
    expect(s.push(new TextEncoder().encode("c\r\nd"))).toEqual(["bc"]);
    expect(s.end()).toEqual(["d"]);
  });

  it("round-trips marker lines and rejects bad ones", () => {
    const e: RunnerEvent = { type: "pr", url: "https://github.com/a/b/pull/1" };
    expect(parseMarker(formatMarker(e))).toEqual(e);
    expect(parseMarker("::myrel::{nope")).toBeNull();
    expect(parseMarker('::myrel::{"type":"what"}')).toBeNull();
    expect(parseLine(shell, formatMarker(e))).toEqual([e]);
  });
});

describe("opencode", () => {
  it("maps its JSON events", () => {
    const line = (o: unknown) => opencode.parse(JSON.stringify(o));
    expect(line({ type: "text", part: { text: " Done. " } })).toEqual([{ type: "text", text: "Done." }]);
    expect(
      line({
        type: "tool_use",
        part: { tool: "todowrite", state: { input: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }] } } },
      }),
    ).toEqual([{ type: "todos", items: [{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }] }]);
    expect(line({ type: "tool_use", part: { tool: "bash", state: { title: "pnpm test", output: "ok\n" } } })).toEqual([
      { type: "tool", name: "bash", title: "pnpm test" },
      { type: "log", stream: "stdout", text: "ok" },
    ]);
    // git redraws its progress with carriage returns: only the last state of each line is kept.
    const clone = "Cloning into 'flow'...\nUpdating files:  15% (665/4323)\rUpdating files: 100% (4323/4323), done.\r\n";
    expect(line({ type: "tool_use", part: { tool: "bash", state: { title: "git clone", output: clone } } })[1]).toEqual({
      type: "log",
      stream: "stdout",
      text: "Cloning into 'flow'...\nUpdating files: 100% (4323/4323), done.",
    });
    const reminded = 'run3\n\n\n[Myrel] Your plan still shows "Clone" as the active step. If its work is done, call myrel_update_plan now.';
    expect(line({ type: "tool_use", part: { tool: "bash", state: { title: "x", output: reminded } } })[1]).toEqual({ type: "log", stream: "stdout", text: "run3" });
    expect(line({ type: "step_finish", part: { tokens: { input: 10, output: 5 }, cost: 0.01 } })).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    ]);
    expect(opencode.parse("plain output")).toEqual([{ type: "log", stream: "stdout", text: "plain output" }]);
    expect(opencode.parse("\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/workspace/*); auto-rejecting")).toEqual([
      {
        type: "log",
        stream: "stderr",
        text: "OpenCode was not allowed to use external_directory (/workspace/*): it needed approval, which nobody can give in the sandbox.",
      },
    ]);
  });

  it("works in the folders next to its own (repos, files, skills) without asking", () => {
    expect(opencodeConfig(spec()).permission).toMatchObject({ external_directory: "allow", bash: "allow", edit: "allow" });
  });

  it("registers OpenAI-compatible models as a custom provider without the key", () => {
    const s = spec({ model: { kind: "openai", provider: "fireworks", id: "firerouter/opus", baseUrl: "https://api.fireworks.ai/inference/v1" } });
    expect(opencode.command(s)).toBe(`opencode run --format json --model 'myrel/firerouter/opus' "$MYREL_PROMPT"`);
    const config = JSON.stringify(opencodeConfig(s));
    expect(config).toContain("{env:MYREL_MODEL_API_KEY}");
    expect(config).toContain("https://api.fireworks.ai/inference/v1");
  });

  it("lets a model that reads images see the images OpenCode reads", () => {
    const model = { kind: "openai" as const, provider: "fireworks", id: "qwen-vl", baseUrl: "https://api.fireworks.ai/inference/v1" };
    const entry = (images?: boolean) =>
      (opencodeConfig(spec({ model: { ...model, images } })).provider as Record<string, { models: Record<string, unknown> }>).myrel!.models["qwen-vl"];
    expect(entry(true)).toMatchObject({ attachment: true, modalities: { input: ["text", "image"], output: ["text"] } });
    expect(entry()).not.toHaveProperty("modalities");
  });

  it("connects to the thread's MCP endpoint as the thread's agent, with the token from the environment", () => {
    expect(opencodeConfig(spec()).mcp).toBeUndefined();
    const config = opencodeConfig(spec({ mcp: { url: "https://myrel.test/api/agent-mcp/thr_1" } }));
    expect(config.mcp).toEqual({
      myrel: {
        type: "remote",
        url: "https://myrel.test/api/agent-mcp/thr_1",
        enabled: true,
        headers: { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" },
      },
    });
  });

  it("adds connectors: remote ones through Myrel with the same token, commands with their variables from secrets", () => {
    const config = opencodeConfig(
      spec({
        mcp: {
          url: "https://myrel.test/api/agent-mcp/thr_1",
          connectors: [
            { transport: "http", name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
            { transport: "stdio", name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "MYREL_CONNECTOR_1_0" } },
          ],
        },
      }),
    );
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.linear).toEqual({
      type: "remote",
      url: "https://myrel.test/api/agent-mcp/thr_1/c/linear",
      enabled: true,
      headers: { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" },
    });
    expect(mcp.db).toEqual({ type: "local", command: ["npx", "-y", "pg-mcp"], enabled: true, environment: { DATABASE_URL: "{env:MYREL_CONNECTOR_1_0}" } });
  });
});

describe("claude code", () => {
  it("maps stream-json events", () => {
    const events = claudeCode.parse(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Looking" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
    );
    expect(events).toEqual([
      { type: "text", text: "Looking" },
      { type: "tool", name: "Bash", title: "ls" },
    ]);
  });
});

describe("progress", () => {
  it("renders phases and the harness's plan as a checklist", () => {
    const events: RunnerEvent[] = [
      { type: "phase", phase: "prepare", state: "done" },
      { type: "phase", phase: "clone", state: "skipped" },
      { type: "phase", phase: "agent", state: "started" },
      { type: "todos", items: [{ text: "Find the bug", status: "done" }, { text: "Fix it", status: "in_progress" }] },
      { type: "tool", name: "edit", title: "src/login.ts" },
    ];
    const p = events.reduce(reduceTask, emptyProgress());
    expect(renderChecklist("Fix the login bug", p)).toBe(
      [
        "Fix the login bug",
        "",
        "✓ Opened the sandbox",
        "✱ Working: src/login.ts",
        "  ✓ Find the bug",
        "  ✱ Fix it",
        "○ Open the pull request",
      ].join("\n"),
    );
  });

  it("says when the sandbox is installing its tools", () => {
    const p = reduceTask(emptyProgress(), { type: "phase", phase: "prepare", state: "started", detail: SETUP_NOTE });
    expect(renderChecklist("Run", p, "tr").split("\n")[2]).toBe(
      "✱ Sandbox açılıyor: araçlar kuruluyor, yalnızca ilk sefer (birkaç dakika)",
    );
  });

  it("names branches after the task", () => {
    expect(taskBranch({ taskId: "task_01JABCDEFGHJKMNPQRSTVWXYZ", title: "Giriş hatasını düzelt!" })).toBe(
      "myrel/giris-hatasini-duzelt-tvwxyz",
    );
  });
});

/** Runs the real task script with bash, like a sandbox would. */
function runScript(env: Record<string, string>) {
  const res = spawnSync("bash", ["-c", taskScript()], {
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "myrel-home-")), ...env },
    encoding: "utf8",
  });
  const events = res.stdout.split("\n").flatMap((l) => parseLine(shell, l));
  return { code: res.status, events, stderr: res.stderr };
}

describe("task script", () => {
  it("gives the GitHub token to github.com over https only", () => {
    const home = mkdtempSync(join(tmpdir(), "myrel-home-"));
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const s = spec({ harness: "shell", prompt: "true" });
    const { code } = runScript({ ...taskEnv(s, shell, { workdir }), HOME: home, GITHUB_TOKEN: "sentinel-github-token" });
    expect(code).toBe(0);
    // What git would send to a server asking for credentials, with the config the script left behind.
    const fill = (protocol: string, host: string) =>
      spawnSync("git", ["credential", "fill"], {
        input: `protocol=${protocol}\nhost=${host}\npath=org/repo.git\n\n`,
        // The task's processes have the token in their environment, as the helper expects.
        env: { PATH: process.env.PATH, HOME: home, GITHUB_TOKEN: "sentinel-github-token", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8",
      }).stdout;
    expect(fill("https", "github.com")).toContain("password=sentinel-github-token");
    for (const [protocol, host] of [
      ["https", "attacker.invalid"],
      ["https", "github.com.attacker.invalid"],
      ["https", "evil.github.com"],
      ["http", "github.com"],
    ]) {
      expect(fill(protocol!, host!)).not.toContain("sentinel-github-token");
    }
  });

  it("clones the repository, runs the harness on a fresh branch and reports phases", () => {
    const origin = mkdtempSync(join(tmpdir(), "myrel-origin-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: origin, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));

    const s = spec({ harness: "shell", prompt: "echo hello > out.txt && git branch --show-current", repo: { url: `file://${origin}` } });
    const home = mkdtempSync(join(tmpdir(), "myrel-home-"));
    const { code, events, stderr } = runScript({ ...taskEnv(s, shell, { workdir }), HOME: home });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const repoDir = join(workdir, origin.split("/").pop()!);
    expect(readFileSync(join(repoDir, "out.txt"), "utf8")).toBe("hello\n");
    expect(events).toContainEqual({ type: "log", stream: "stdout", text: taskBranch(s) });
    // There is no SSH key in the sandbox: GitHub's SSH addresses go over HTTPS with the token.
    const url = (u: string) => execFileSync("git", ["ls-remote", "--get-url", u], { cwd: repoDir, env: { ...process.env, HOME: home }, encoding: "utf8" }).trim();
    expect(url("git@github.com:Fibteq-Inc/flow.git")).toBe("https://github.com/Fibteq-Inc/flow.git");
    expect(url("ssh://git@github.com/Fibteq-Inc/flow.git")).toBe("https://github.com/Fibteq-Inc/flow.git");
    expect(events.filter((e) => e.type === "phase").map((e) => `${e.phase}:${e.state}`)).toEqual([
      "prepare:started",
      "prepare:done",
      "clone:started",
      "clone:done",
      "agent:started",
      "agent:done",
      "publish:skipped",
    ]);
  });

  it("ends a harness that keeps going after its turn is done, as finished", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const s = spec({ harness: "shell", prompt: "echo replied && sleep 30 && echo too-late" });
    const child = spawn("bash", ["-c", taskScript()], {
      env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "myrel-home-")), ...taskEnv(s, shell, { workdir }) },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    while (!out.includes("replied")) await new Promise((r) => setTimeout(r, 50));
    expect(spawnSync("bash", ["-c", STOP_HARNESS_SCRIPT]).status).toBe(0);
    expect(await exited).toBe(0);
    const events = out.split("\n").flatMap((l) => parseLine(shell, l));
    expect(events).toContainEqual({ type: "phase", phase: "agent", state: "done" });
    expect(events).toContainEqual({ type: "log", stream: "system", text: "Ended Shell: its reply was sent and its plan is done." });
    expect(out).not.toContain("too-late");
  });

  it("saves what the harness left unpushed in a cloned GitHub repository to the thread's branch there", () => {
    const origin = mkdtempSync(join(tmpdir(), "myrel-origin-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const home = mkdtempSync(join(tmpdir(), "myrel-home-"));
    // The test's "GitHub" is a local repository.
    writeFileSync(join(home, ".gitconfig"), `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
    const repos = mkdtempSync(join(tmpdir(), "myrel-repos-"));
    const prompt = [
      "git clone -q https://github.com/acme/app.git $REPOS/app",
      "cd $REPOS/app && git commit -q --allow-empty -m init && git push -q origin HEAD:main",
      "git checkout -q -b feature && echo wip > notes.txt",
      "git clone -q https://github.com/acme/app.git $REPOS/clean",
    ].join(" && ");
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const s = spec({ harness: "shell", prompt, saveRepos: { dir: repos, branch: "myrel/saved/thr_1" } });
    const { code, events } = runScript({ ...taskEnv(s, shell, { workdir }), HOME: home, REPOS: repos });
    expect(code).toBe(0);
    expect(events).toContainEqual({ type: "log", stream: "system", text: "Saved the unpushed work in app to its branch myrel/saved/thr_1 on GitHub." });
    expect(events.filter((e) => e.type === "log" && e.text.includes("clean"))).toEqual([]);
    expect(git(origin, "show", "myrel/saved/thr_1:notes.txt")).toBe("wip");
    expect(git(origin, "log", "-1", "--format=%s", "myrel/saved/thr_1")).toBe("Unsaved work on feature, saved by Myrel");
    // The harness's own branch and files are untouched.
    expect(git(join(repos, "app"), "status", "--porcelain")).toBe("?? notes.txt");
  });

  it("downloads the thread's attachments next to the work before the harness starts", () => {
    const source = mkdtempSync(join(tmpdir(), "myrel-src-"));
    writeFileSync(join(source, "report.pdf"), "%PDF-1.7\n");
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const files = [
      { path: "uploads/abc-report.pdf", url: `file://${join(source, "report.pdf")}` },
      { path: "../escape.txt", url: `file://${join(source, "report.pdf")}` },
      { path: "uploads/missing.png", url: `file://${join(source, "missing.png")}` },
    ];
    const s = spec({ harness: "shell", prompt: "cat files/uploads/abc-report.pdf" });
    const { code, events } = runScript({ ...taskEnv(s, shell, { workdir }), MYREL_FILES: JSON.stringify(files) });
    expect(code).toBe(0);
    expect(events).toContainEqual({ type: "log", stream: "stdout", text: "%PDF-1.7" });
    expect(events).toContainEqual({
      type: "log",
      stream: "system",
      text: "Could not download uploads/missing.png; read_file gives a fresh link.",
    });
    expect(existsSync(join(workdir, "escape.txt"))).toBe(false);
  });

  it("puts the turn's skills next to the work and where OpenCode looks, and takes them away again", () => {
    const source = mkdtempSync(join(tmpdir(), "myrel-src-"));
    const b64 = (t: string) => Buffer.from(t).toString("base64");
    const bundle = {
      skills: [
        { name: "pdf-forms", files: [{ path: "SKILL.md", content: b64("---\nname: pdf-forms\n---\n") }, { path: "scripts/fill.sh", content: b64("echo filled") }] },
        { name: "evil", files: [{ path: "../../escape.txt", content: b64("x") }] },
      ],
    };
    writeFileSync(join(source, "bundle.json"), JSON.stringify(bundle));
    const home = mkdtempSync(join(tmpdir(), "myrel-home-"));
    const own = join(home, ".config", "opencode", "skills");
    // Someone's own skill there stays.
    execFileSync("mkdir", ["-p", join(own, "theirs")]);
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const s = spec({ harness: "shell", prompt: "skills/pdf-forms/scripts/fill.sh", skills: { url: `file://${join(source, "bundle.json")}` } });
    const { code, events } = runScript({ ...taskEnv(s, shell, { workdir }), HOME: home });
    expect(code).toBe(0);
    expect(events).toContainEqual({ type: "log", stream: "stdout", text: "filled" });
    expect(readFileSync(join(own, "pdf-forms", "SKILL.md"), "utf8")).toContain("pdf-forms");
    expect(existsSync(join(home, ".claude", "skills", "pdf-forms", "scripts", "fill.sh"))).toBe(true);
    expect(existsSync(join(workdir, "escape.txt"))).toBe(false);
    expect(existsSync(join(workdir, "skills", ".bundle.json"))).toBe(false);

    const next = runScript({ ...taskEnv(spec({ harness: "shell", prompt: "true" }), shell, { workdir }), HOME: home });
    expect(next.code).toBe(0);
    expect(existsSync(join(own, "pdf-forms"))).toBe(false);
    expect(existsSync(join(workdir, "skills"))).toBe(false);
    expect(existsSync(join(own, "theirs"))).toBe(true);
  });

  it("saves every result to the workspace and starts the next task from it", () => {
    const remote = mkdtempSync(join(tmpdir(), "myrel-ws-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const workspace = { remote: `file://${remote}` };
    // Each task gets a fresh workdir, like a sandbox that went to sleep in between.
    const run = (prompt: string) =>
      runScript(taskEnv(spec({ harness: "shell", prompt, workspace }), shell, { workdir: mkdtempSync(join(tmpdir(), "myrel-work-")) }));

    const first = run("echo one > notes.txt");
    expect(first.code).toBe(0);
    expect(first.events.filter((e) => e.type === "phase" && e.phase === "save").map((e) => e.type === "phase" && e.state)).toEqual([
      "started",
      "done",
    ]);

    const second = run("cat notes.txt && echo two >> notes.txt && exit 4");
    expect(second.code).toBe(4);
    expect(second.events).toContainEqual({ type: "log", stream: "stdout", text: "one" });
    expect(second.events).toContainEqual({ type: "log", stream: "system", text: "Continuing from the work saved in this thread." });
    expect(second.events.at(-1)).toMatchObject({ type: "phase", phase: "save", state: "done" });

    // Unfinished work is saved too, marked as such.
    const log = execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "main"], { encoding: "utf8" });
    expect(log.trim().split("\n")).toEqual(["Fix the login bug (unfinished)", "Fix the login bug"]);
  });

  it("continues a repository branch from the saved work", () => {
    const origin = mkdtempSync(join(tmpdir(), "myrel-origin-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: origin });
    const remote = mkdtempSync(join(tmpdir(), "myrel-ws-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const run = (prompt: string) =>
      runScript(
        taskEnv(
          spec({ harness: "shell", prompt, repo: { url: `file://${origin}`, branch: "fix" }, workspace: { remote: `file://${remote}` } }),
          shell,
          { workdir: mkdtempSync(join(tmpdir(), "myrel-work-")) },
        ),
      );
    expect(run("echo draft > fix.txt").code).toBe(0);
    const second = run("cat fix.txt");
    expect(second.code).toBe(0);
    expect(second.events).toContainEqual({ type: "log", stream: "stdout", text: "draft" });
  });

  it("goes on without saving when the workspace cannot be reached", () => {
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    const s = spec({ harness: "shell", prompt: "true", workspace: { remote: "file:///nonexistent/myrel-ws" } });
    const { code, events } = runScript(taskEnv(s, shell, { workdir }));
    expect(code).toBe(0);
    expect(events.some((e) => e.type === "phase" && e.phase === "save")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "log", stream: "system", text: expect.stringContaining("will not be saved") }));
  });

  it("fails the agent phase with the harness's exit code", () => {
    const workdir = mkdtempSync(join(tmpdir(), "myrel-work-"));
    writeFileSync(join(workdir, "x"), "");
    const { code, events } = runScript(taskEnv(spec({ harness: "shell", prompt: "exit 3" }), shell, { workdir }));
    expect(code).toBe(3);
    expect(events.at(-1)).toEqual({ type: "phase", phase: "agent", state: "failed", detail: "Shell exited with code 3" });
  });
});

describe("OpenCode plan plugin", () => {
  it("reminds the agent of its active step after a few tool calls, until it updates the plan", async () => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(PLAN_PLUGIN)}`);
    const hooks = await mod.MyrelPlan({});
    const after = hooks["tool.execute.after"];
    const call = async (tool: string, args: unknown = {}) => {
      const output = { title: tool, output: "ok", metadata: {} };
      await after({ tool, sessionID: "s", callID: "c", args }, output);
      return output.output;
    };
    expect(await call("bash")).toBe("ok"); // no plan yet
    await call("myrel_update_plan", { title: "Bump", steps: [{ text: "Find the version", state: "done" }, { text: "Open the PR", state: "active" }] });
    expect(await call("bash")).toBe("ok");
    const reminded = await call("bash");
    expect(reminded).toContain('[Myrel] Your plan still shows "Open the PR" as the active step.');
    expect(await call("read")).toBe("ok");
    await call("myrel_update_plan", { title: "Bump", steps: [{ text: "Open the PR", state: "done" }] });
    expect(await call("bash")).toBe("ok");
    expect(await call("bash")).toBe("ok"); // nothing active any more
  });

  it("is written and loaded only when the task has Myrel's tools", () => {
    const withTools = spec({ harness: "opencode", mcp: { url: "https://myrel.example/mcp" } });
    expect(opencode.command(withTools)).toContain('printf \'%s\' "$MYREL_PLAN_PLUGIN" > "$HOME/.cache/myrel/opencode-plan.js" && opencode run');
    expect(opencodeConfig(withTools).plugin).toEqual(["file://{env:HOME}/.cache/myrel/opencode-plan.js"]);
    const bare = spec({ harness: "opencode" });
    expect(opencode.command(bare)).toMatch(/^opencode run/);
    expect(opencode.env(bare).MYREL_PLAN_PLUGIN).toBeUndefined();
  });
});
