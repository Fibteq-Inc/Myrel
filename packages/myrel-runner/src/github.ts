import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TaskGithub } from "@myrel/protocol";
import { selfCommand } from "./bridge";

/**
 * The turn's GitHub token for git on this computer (feature "github-token"). The token is never
 * written anywhere, and not even put in the CLI's environment: the runner keeps it in memory and
 * serves it on 127.0.0.1 at an address only that run knows (MYREL_GIT_CREDENTIALS). A git credential
 * helper (`myrel-runner git-credential`) fetches it from there, so a renewed token ("task.github")
 * reaches a CLI that is already running, and the address stops working when the run ends.
 *
 * Only the project's repositories use it: the helper and the SSH-to-HTTPS rewrite are set for their
 * github.com addresses alone, so git reaches every other repository with the computer's own login
 * as before. For those repositories the person's own helpers are left out, so none of them (a
 * keychain, a plain-text store) is asked to save the token.
 */
export const CREDENTIALS_VAR = "MYREL_GIT_CREDENTIALS";

/** More repositories than this would make the git settings too long for one environment variable. */
const MAX_REPOS = 40;

type Lent = { token: string; expiresAt: number };

export class GitCredentials {
  private readonly lent = new Map<string, Lent>();
  private readonly keyOf = new Map<string, string>();
  private port: Promise<number> | null = null;
  private server: Server | null = null;

  /** Lends the token to a task's run; returns the environment variables its CLI gets. */
  async lend(taskId: string, github: TaskGithub): Promise<Record<string, string>> {
    const key = randomBytes(32).toString("hex");
    this.keyOf.set(taskId, key);
    this.lent.set(key, { token: github.token, expiresAt: Date.parse(github.expiresAt) });
    try {
      return gitEnv(`http://127.0.0.1:${await this.listen()}/${key}`, github.repos);
    } catch (err) {
      this.end(taskId);
      throw err;
    }
  }

  /** A new token for a running task, from "task.github". */
  renew(taskId: string, github: TaskGithub) {
    const key = this.keyOf.get(taskId);
    if (key) this.lent.set(key, { token: github.token, expiresAt: Date.parse(github.expiresAt) });
  }

  /** The run ended: its address answers no more. */
  end(taskId: string) {
    const key = this.keyOf.get(taskId);
    if (!key) return;
    this.keyOf.delete(taskId);
    this.lent.delete(key);
    // The port is open only while a run has a token.
    if (this.lent.size === 0 && this.server) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  private listen(): Promise<number> {
    this.port ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        const lent = req.method === "GET" ? this.lent.get((req.url ?? "").slice(1)) : undefined;
        if (!lent || lent.expiresAt <= Date.now()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end(`username=x-access-token\npassword=${lent.token}\n`);
      });
      server.once("error", (err) => {
        this.server = null;
        this.port = null;
        reject(err);
      });
      this.server = server;
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.port;
  }
}

/**
 * The git settings for a run, as GIT_CONFIG_PARAMETERS (what `git -c` passes on to the git commands
 * it starts), after any the runner itself was started with. Not GIT_CONFIG_COUNT/KEY/VALUE: Codex
 * leaves variables named like *KEY* out of the commands it runs, and git refuses a count without its keys.
 */
export function gitEnv(
  url: string,
  repos: string[],
  base = process.env.GIT_CONFIG_PARAMETERS,
  self = selfCommand(),
): Record<string, string> {
  const helper = `!${[self.command, ...self.args].map(shellWord).join(" ")} git-credential`;
  const entries: [string, string][] = [];
  // The folder's remote may spell the name in another case (a renamed repository, say).
  const names = [...new Set(repos.slice(0, MAX_REPOS).flatMap((r) => [r, r.toLowerCase()]))];
  for (const name of names) {
    for (const https of [`https://github.com/${name}`, `https://github.com/${name}.git`]) {
      // An empty helper drops the ones set before it, so only Myrel's answers for this repository.
      entries.push([`credential.${https}.helper`, ""], [`credential.${https}.helper`, helper]);
    }
    entries.push(
      [`url.https://github.com/${name}.git.insteadOf`, `git@github.com:${name}.git`],
      [`url.https://github.com/${name}.git.insteadOf`, `ssh://git@github.com/${name}.git`],
    );
  }
  const params = entries.map(([key, value]) => sq(`${key}=${value}`)).join(" ");
  return { [CREDENTIALS_VAR]: url, GIT_CONFIG_PARAMETERS: base ? `${base} ${params}` : params };
}

/** Single-quoted the way git reads GIT_CONFIG_PARAMETERS. */
const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** One word for the shell git runs a helper with (sh, also on Windows), where forward slashes work. */
function shellWord(s: string): string {
  const path = process.platform === "win32" ? s.replaceAll("\\", "/") : s;
  return `"${path.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * `myrel-runner git-credential <operation>`: started by git, never by people. Answers "get" for
 * github.com over HTTPS with the token of the run it was started in; ignores "store" and "erase".
 */
export async function runGitCredential(operation: string | undefined, input: NodeJS.ReadableStream, out: (text: string) => void) {
  let text = "";
  for await (const chunk of input) text += String(chunk);
  const url = process.env[CREDENTIALS_VAR];
  if (operation !== "get" || !url) return;
  const fields = new Map(
    text
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) out(await res.text());
  } catch {
    // The run is over or the runner is gone: git asks for a login the usual way.
  }
}
