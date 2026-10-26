import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDENTIALS_VAR, GitCredentials, gitEnv } from "../src/github";

const run = promisify(execFile);
const TOKEN = "ghs_sentinelTokenForTheTurn0123456789";
const github = (token = TOKEN) => ({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), repos: ["Fibteq-Inc/Myrel"] });

let dir: string;
let cli: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "myrel-git-"));
  cli = join(dir, "cli.mjs");
  await build({ entryPoints: [join(__dirname, "../src/cli.ts")], bundle: true, platform: "node", format: "esm", outfile: cli, logLevel: "silent" });
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

/** What `git credential fill` answers for `url` with these variables, the person's own config being a helper that answers "mine". */
async function fill(env: Record<string, string>, url: string) {
  const global = join(dir, "gitconfig");
  await run("git", ["config", "--file", global, "credential.helper", "!f() { cat >/dev/null; echo username=me; echo password=mine; }; f"]);
  const child = execFile("git", ["credential", "fill"], {
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  child.stdin!.end(`url=${url}\n\n`);
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  await new Promise((resolve) => child.on("close", resolve));
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=", 2) as [string, string]));
}

describe("the turn's GitHub token for git", () => {
  it("answers only for the project's repositories, never storing it in the person's helpers", async () => {
    const git = new GitCredentials();
    const env = await git.lend("task_1", github());
    // The token itself is not in the environment, only where to fetch it.
    expect(Object.values(env).join(" ")).not.toContain(TOKEN);
    const self = { command: process.execPath, args: [cli] };
    const vars = { ...gitEnv(env[CREDENTIALS_VAR]!, ["Fibteq-Inc/Myrel"], undefined, self) };

    expect(await fill(vars, "https://github.com/Fibteq-Inc/Myrel.git")).toMatchObject({ username: "x-access-token", password: TOKEN });
    expect(await fill(vars, "https://github.com/fibteq-inc/myrel")).toMatchObject({ password: TOKEN });
    // Any other repository, and any other host, keeps the computer's own login.
    expect(await fill(vars, "https://github.com/Fibteq-Inc/Other.git")).toMatchObject({ password: "mine" });
    expect(await fill(vars, "https://gitlab.com/Fibteq-Inc/Myrel.git")).toMatchObject({ password: "mine" });

    // A renewed token reaches the running CLI; after the run the address answers no more.
    git.renew("task_1", github("ghs_renewedTokenForTheTurn0123456789"));
    expect(await fill(vars, "https://github.com/Fibteq-Inc/Myrel.git")).toMatchObject({ password: "ghs_renewedTokenForTheTurn0123456789" });
    git.end("task_1");
    expect((await fill(vars, "https://github.com/Fibteq-Inc/Myrel.git")).password).toBeUndefined();
  }, 30_000);

  it("sends the project's SSH addresses over HTTPS, and only those", async () => {
    const vars = gitEnv("http://127.0.0.1:1/x", ["Fibteq-Inc/Myrel"], "'core.askpass=foo'", { command: "myrel-runner", args: [] });
    expect(vars.GIT_CONFIG_PARAMETERS!.startsWith("'core.askpass=foo' ")).toBe(true);
    const rewrite = async (url: string) =>
      (await run("git", ["ls-remote", "--get-url", url], { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", ...vars } })).stdout.trim();
    expect(await rewrite("git@github.com:Fibteq-Inc/Myrel.git")).toBe("https://github.com/Fibteq-Inc/Myrel.git");
    expect(await rewrite("ssh://git@github.com/Fibteq-Inc/Myrel.git")).toBe("https://github.com/Fibteq-Inc/Myrel.git");
    expect(await rewrite("git@github.com:Fibteq-Inc/Other.git")).toBe("git@github.com:Fibteq-Inc/Other.git");
  });
});
