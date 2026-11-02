import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerInfo, type RunnerToServer, ServerToRunner } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountEnv, accountId, addAccount, claudeAccountsHome, findAccount, helloAccounts, limitsKey, removeAccount, renameAccount } from "../src/accounts";
import { type RunnerConfig, SessionStore, sessionKey } from "../src/config";
import { TaskRunner } from "../src/tasks";

let home: string;
const savedPath = process.env.PATH;
const savedDir = process.env.CLAUDE_CONFIG_DIR;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-accounts-"));
  process.env.MYREL_RUNNER_HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedDir;
  delete process.env.MYREL_CLAUDE_ONESHOT;
});

const config = (): RunnerConfig => ({ folders: [], access: "edit" });

describe("account ids", () => {
  it("are made from the name, Turkish letters included, and never repeat", () => {
    expect(accountId("İş", [])).toBe("is");
    expect(accountId("Kişisel hesap", [])).toBe("kisisel-hesap");
    expect(accountId("Çalışma Ğ", [])).toBe("calisma-g");
    expect(accountId("Work", ["work"])).toBe("work-2");
    expect(accountId("Work", ["work", "work-2"])).toBe("work-3");
    expect(accountId("!!!", [])).toBe("account");
    // "default" would read as the CLI's own login.
    expect(accountId("Default", [])).toBe("default-2");
  });
});

describe("adding, renaming and removing accounts", () => {
  it("gives a new account a folder of its own under the runner's home", async () => {
    const c = config();
    const a = await addAccount(c, " İş ");
    expect(a).toEqual({ id: "is", name: "İş", dir: join(claudeAccountsHome(), "is") });
    expect((await stat(a.dir)).isDirectory()).toBe(true);
    expect(c.claudeAccounts).toEqual([a]);
  });

  it("refuses a name in use, Claude Code's own folder or a folder another account has", async () => {
    const c = config();
    const a = await addAccount(c, "Work");
    await expect(addAccount(c, "work")).rejects.toThrow(/already a Claude Code account/);
    await expect(addAccount(c, "Other", a.dir)).rejects.toThrow(/already the account "Work"/);
    process.env.CLAUDE_CONFIG_DIR = join(home, "own");
    await expect(addAccount(c, "Mine", join(home, "own"))).rejects.toThrow(/Claude Code's own login/);
    c.claudeDefaultName = "Personal";
    await expect(addAccount(c, "personal")).rejects.toThrow(/already a Claude Code account/);
  });

  it("finds, renames and removes an account by id or name, and names Claude Code's own login", async () => {
    const c = config();
    await addAccount(c, "İş");
    expect(findAccount(c, "is")?.name).toBe("İş");
    expect(findAccount(c, "İŞ")?.id).toBe("is");
    expect(renameAccount(c, "is", "Work")).toBe(true);
    expect(c.claudeAccounts![0]!.name).toBe("Work");
    expect(c.claudeAccounts![0]!.id).toBe("is");
    expect(renameAccount(c, "default", "Personal")).toBe(true);
    expect(c.claudeDefaultName).toBe("Personal");
    expect(() => renameAccount(c, "Personal", "work")).toThrow(/already/);
    expect(renameAccount(c, "nope", "x")).toBe(false);
    expect(removeAccount(c, "Work")?.id).toBe("is");
    expect(c.claudeAccounts).toBeUndefined();
    expect(removeAccount(c, "Work")).toBeUndefined();
  });
});

describe("a task's login", () => {
  it("is Claude Code's config folder of the chosen account, nothing for its own, an error for one that is gone", async () => {
    const c = config();
    const a = await addAccount(c, "Work");
    expect(accountEnv(c, "claude", undefined)).toEqual({});
    expect(accountEnv(c, "claude", "work")).toEqual({ CLAUDE_CONFIG_DIR: a.dir });
    expect(accountEnv(c, "claude", "gone")).toHaveProperty("error");
    // Only Claude Code takes other logins so far.
    expect(accountEnv(c, "codex", "work")).toHaveProperty("error");
  });

  it("keeps its sessions apart from the CLI's own login's", () => {
    expect(sessionKey("thr_1", "claude")).toBe("thr_1");
    expect(sessionKey("thr_1", "codex")).toBe("codex:thr_1");
    expect(sessionKey("thr_1", "claude", "work")).toBe("claude@work:thr_1");
    expect(limitsKey("claude")).toBe("claude");
    expect(limitsKey("claude", "work")).toBe("claude@work");
  });
});

describe("hello", () => {
  const limits = (used: number) => ({ windows: [{ kind: "session", usedPercent: used, resetsAt: null }], at: "2026-11-02T10:00:00.000Z" });

  it("lists Claude Code's other logins with their own limits, and nothing for other CLIs", async () => {
    const c = config();
    await addAccount(c, "Work");
    await addAccount(c, "Side");
    c.claudeDefaultName = "Personal";
    const saved = { claude: limits(80), "claude@work": limits(10) };
    expect(helloAccounts(c, "claude", saved)).toEqual({
      accounts: [
        { id: "work", name: "Work", limits: limits(10) },
        { id: "side", name: "Side" },
      ],
      defaultAccount: "Personal",
    });
    expect(helloAccounts(c, "codex", saved)).toEqual({});
    expect(helloAccounts(config(), "claude", saved)).toEqual({});
  });

  it("parses on the server, which drops a malformed account list instead of the CLI", () => {
    const info = RunnerInfo.parse({
      version: "0.34.0",
      hostname: "h",
      platform: "linux",
      folders: [],
      clis: [
        { id: "claude", version: "2.1.316", accounts: [{ id: "work", name: "Work" }], defaultAccount: "Personal" },
        { id: "codex", version: "1", accounts: [{ id: "Bad Id", name: "x" }] },
      ],
      features: ["cli-accounts"],
    });
    expect(info.clis[0]!.accounts).toEqual([{ id: "work", name: "Work" }]);
    expect(info.clis[1]).toEqual({ id: "codex", version: "1" });
    expect(info.features).toEqual(["cli-accounts"]);
  });
});

describe("running a task with an account", () => {
  const threadId = "thr_01JTEST0000000000000000000";

  /** A claude that answers once, naming its session after the config folder it runs with. */
  async function fakeClaude() {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.316 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("--print"); process.exit(0); }
const dir = process.env.CLAUDE_CONFIG_DIR || "own";
const session = "sess-" + require("node:path").basename(dir);
const send = (m) => process.stdout.write(JSON.stringify({ session_id: session, ...m }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  send({ type: "system", subtype: "init" });
  send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: dir === "own" ? 0.8 : 0.1 } });
  send({ type: "result", subtype: "success", result: "ran with " + dir + (args.includes("--resume") ? " resumed " + args[args.indexOf("--resume") + 1] : "") });
  process.exit(0);
});
`;
    await writeFile(join(bin, "claude"), script);
    await chmod(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.MYREL_CLAUDE_ONESHOT = "1";
  }

  async function setup() {
    await fakeClaude();
    const folder = join(home, "proj");
    await mkdir(folder, { recursive: true });
    const c: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit", worktrees: false };
    const work = await addAccount(c, "Work");
    const frames: RunnerToServer[] = [];
    const reported: { cli: string; account?: string; used: number | null | undefined }[] = [];
    const tasks = new TaskRunner({
      config: () => c,
      sessions: new SessionStore(),
      onLimits: (cli, limits, account) => reported.push({ cli, account, used: limits.windows[0]?.usedPercent }),
    });
    tasks.setSender((f) => frames.push(f));
    let n = 0;
    const run = async (account?: string) => {
      const taskId = `task_01JTEST000000000000000000${n++}`;
      const start = ServerToRunner.parse({ type: "task.start", taskId, threadId, folder, cli: "claude", prompt: "hi", ...(account && { account }) });
      await tasks.start(start as Extract<ServerToRunner, { type: "task.start" }>);
      return frames.find((f) => f.type === "task.done" && f.taskId === taskId) as { ok: boolean; result: string };
    };
    return { work, run, reported };
  }

  it("runs Claude Code with the account's config folder, keeps a session per login and reports limits per login", async () => {
    const { work, run, reported } = await setup();
    expect((await run("work")).result).toContain(`ran with ${work.dir}`);
    expect((await run()).result).toMatch(/ran with own/);
    // Each login continues its own session; switching never resumes the other's.
    expect((await run("work")).result).toContain("resumed sess-work");
    expect((await run()).result).toContain("resumed sess-own");
    const sessions = JSON.parse(await readFile(join(home, "sessions.json"), "utf8")) as Record<string, { id: string }>;
    expect(sessions[threadId]?.id).toBe("sess-own");
    expect(sessions[`claude@work:${threadId}`]?.id).toBe("sess-work");
    expect(reported[0]).toEqual({ cli: "claude", account: "work", used: 10 });
    expect(reported[1]).toEqual({ cli: "claude", account: undefined, used: 80 });
  });

  it("fails a task naming an account this computer no longer has, without starting the CLI", async () => {
    const { run } = await setup();
    const done = await run("gone");
    expect(done.ok).toBe(false);
    expect(done.result).toMatch(/no Claude Code account "gone"/);
  });
});
