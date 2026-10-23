import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, detectClis, opencodeServerArgs, type ParseState } from "../src/clis";

const opencode = ADAPTERS.opencode;

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-opencode-"));
});
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A stand-in `opencode` alone on PATH that prints this version. */
async function fakeOpencode(version: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "opencode"), `#!/bin/sh\necho "${version}"\n`);
  await chmod(join(bin, "opencode"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

describe("opencode arguments", () => {
  it("runs headless with JSON events and takes the prompt on stdin", () => {
    expect(opencode.args({ access: "edit" })).toEqual(["run", "--format", "json"]);
    expect(opencode.args({ access: "read" })).toEqual(["run", "--format", "json"]);
    // Full access approves what would ask; the person's own denials still hold.
    expect(opencode.args({ access: "full" })).toEqual(["run", "--format", "json", "--auto"]);
    expect(opencode.args({ access: "edit", resume: "ses_1", extra: ["--standalone"] })).toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "ses_1",
      "--standalone",
    ]);
    expect(opencode.input).toBeUndefined();
  });

  it("asks opencode 2 for its own server, not the background service", () => {
    expect(opencodeServerArgs("1.19.4")).toEqual([]);
    expect(opencodeServerArgs("opencode v2.0.28")).toEqual(["--standalone"]);
    expect(opencodeServerArgs(null)).toEqual([]);
  });
});

describe("opencode output", () => {
  // As opencode 1.19.4 printed them for a run that read a file and answered.
  const run = [
    { type: "step_start", sessionID: "ses_a", part: { messageID: "msg_1", type: "step-start" } },
    {
      type: "tool_use",
      sessionID: "ses_a",
      part: { type: "tool", tool: "read", messageID: "msg_1", state: { status: "completed", input: { filePath: "/w/f.txt" }, output: "secret42" } },
    },
    {
      type: "step_finish",
      sessionID: "ses_a",
      part: { reason: "tool-calls", messageID: "msg_1", tokens: { total: 18282, input: 9789, output: 45, reasoning: 0, cache: { write: 0, read: 8448 } }, cost: 0 },
    },
    { type: "step_start", sessionID: "ses_a", part: { messageID: "msg_2", type: "step-start" } },
    { type: "text", sessionID: "ses_a", part: { messageID: "msg_2", type: "text", text: "Dosyada" } },
    { type: "text", sessionID: "ses_a", part: { messageID: "msg_2", type: "text", text: "secret42 yazıyor." } },
    {
      type: "step_finish",
      sessionID: "ses_a",
      part: { reason: "stop", messageID: "msg_2", tokens: { total: 18308, input: 12544, output: 4, reasoning: 10, cache: { write: 2, read: 5760 } }, cost: 0 },
    },
  ];

  it("reads the session, steps, answer and usage", () => {
    const state: ParseState = {};
    opencode.line(JSON.stringify(run[0]), state);
    expect(state.sessionId).toBe("ses_a");
    opencode.line(JSON.stringify(run[1]), state);
    expect(state.progress).toBe("read: /w/f.txt");
    for (const event of run.slice(2)) opencode.line(JSON.stringify(event), state);
    expect(state).toMatchObject({ result: "Dosyada\n\nsecret42 yazıyor.", progress: "secret42 yazıyor." });
    expect(state.failed).toBeFalsy();
    // Cache reads and writes count as input, reasoning as output.
    expect(state.usage).toEqual({ inputTokens: 9789 + 8448 + 12544 + 5760 + 2, outputTokens: 45 + 4 + 10 });
  });

  it("keeps only the last message's text as the answer", () => {
    const state: ParseState = {};
    opencode.line(JSON.stringify({ type: "text", sessionID: "s", part: { messageID: "m1", text: "Önce dosyaya bakıyorum." } }), state);
    opencode.line(JSON.stringify({ type: "text", sessionID: "s", part: { messageID: "m2", text: "Bitti." } }), state);
    expect(state.result).toBe("Bitti.");
  });

  it("fails the run with opencode's error, in both versions' shapes", () => {
    // opencode 1.19.4
    const v1: ParseState = {};
    opencode.line(JSON.stringify({ type: "error", sessionID: "s", error: { name: "UnknownError", data: { message: "Unexpected server error." } } }), v1);
    expect(v1).toMatchObject({ failed: true, result: "Unexpected server error." });
    // opencode 2.0.28
    const v2: ParseState = {};
    opencode.line(JSON.stringify({ type: "text", sessionID: "s", part: { messageID: "m", text: "Başlıyorum" } }), v2);
    opencode.line(JSON.stringify({ type: "error", sessionID: "s", error: { type: "provider.no-route", message: "Model unavailable: x/y" } }), v2);
    expect(v2).toMatchObject({ failed: true, result: "Model unavailable: x/y" });
  });

  it("ignores lines that are not its JSON events", () => {
    const state: ParseState = {};
    opencode.line("! permission requested: bash (ls); auto-rejecting", state);
    expect(state).toEqual({});
  });
});

describe.skipIf(process.platform === "win32")("opencode as the thread's agent", () => {
  const mcp = () => ({ url: "https://myrel.test/api/agent-mcp/thr_1", token: "t".repeat(32), dir: home });
  const config = (agent: { env?: Record<string, string> }) => JSON.parse(agent.env!.OPENCODE_CONFIG_CONTENT!);

  it("gives the run its servers and permissions in the environment, the token apart", async () => {
    await fakeOpencode("1.19.4");
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const agent = await opencode.agent({ ...mcp(), connectors, access: "edit", dirs: ["/code/app"], skills: { plugin: "/run/plugin", dir: "/run/plugin/skills" } });
    expect(agent.args).toEqual([]);
    expect(agent.env!.MYREL_MCP_TOKEN).toBe("t".repeat(32));
    expect(agent.env!.OPENCODE_CONFIG_CONTENT).not.toContain("t".repeat(32));
    const auth = { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" };
    expect(config(agent)).toEqual({
      mcp: {
        myrel: { type: "remote", url: "https://myrel.test/api/agent-mcp/thr_1", headers: auth, oauth: false },
        linear: { type: "remote", url: connectors[0]!.url, headers: auth, oauth: false },
        db: { type: "local", command: ["npx", "-y", "pg-mcp"], environment: { DATABASE_URL: "postgres://x" } },
      },
      permission: {
        edit: "allow",
        bash: "deny",
        "myrel_*": "allow",
        "linear_*": "allow",
        "db_*": "allow",
        external_directory: {
          "/code/app": "allow",
          "/code/app/*": "allow",
          "/run/plugin/skills": "allow",
          "/run/plugin/skills/*": "allow",
        },
      },
      skills: { paths: ["/run/plugin/skills"] },
      experimental: { continue_loop_on_deny: true },
    });
  });

  it("sets what opencode may do from the computer's access", async () => {
    await fakeOpencode("1.19.4");
    const permission = async (access: "read" | "edit" | "auto" | "full") => config(await opencode.agent({ ...mcp(), access })).permission;
    expect(await permission("read")).toEqual({ edit: "deny", bash: "deny", "myrel_*": "allow" });
    expect(await permission("auto")).toEqual({ edit: "allow", bash: "deny", "myrel_*": "allow" });
    expect(await permission("full")).toEqual({ edit: "allow", bash: "allow", "myrel_*": "allow" });
  });

  it("runs opencode 2 on its own server, so the run's config applies", async () => {
    await fakeOpencode("opencode v2.0.28");
    expect((await opencode.agent(mcp())).args).toEqual(["--standalone"]);
  });
});

describe.skipIf(process.platform === "win32")("detectClis", () => {
  it("finds opencode with its version", async () => {
    await fakeOpencode("1.19.4");
    expect(await detectClis()).toEqual([{ id: "opencode", version: "1.19.4" }]);
  });
});
