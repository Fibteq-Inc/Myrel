import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CliAccount, CliAccountId, CliId, CliLimits } from "@myrel/protocol";
import { childEnv, type RunnerConfig, runnerHome } from "./config";

/**
 * Claude Code logins besides the CLI's own: each lives in its own config folder, which Claude Code
 * takes from CLAUDE_CONFIG_DIR (its documented way to sign in with several accounts). The person signs
 * in with Claude Code's own `claude auth login`; Myrel never sees, reads or keeps the login itself.
 */
export type ClaudeAccount = { id: CliAccountId; name: string; dir: string };

/** The CLIs that take other logins so far. */
export const ACCOUNT_CLIS = new Set<CliId>(["claude"]);

/** How many other logins a CLI can have (RunnerCli.accounts). */
export const MAX_ACCOUNTS = 10;

/** Where `claude add` puts a new login's folder: ~/.myrel-runner/claude/<id>. */
export const claudeAccountsHome = () => join(runnerHome(), "claude");

/** Claude Code's own config folder: the runner's CLAUDE_CONFIG_DIR, or ~/.claude. */
export const claudeOwnDir = () => (process.env.CLAUDE_CONFIG_DIR?.trim() ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude"));

const TURKISH: Record<string, string> = { ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g", ç: "c", Ç: "c", ö: "o", Ö: "o", ü: "u", Ü: "u" };

/** An id for a login named `name` ("İş" → "is"), unlike any in `taken`. */
export function accountId(name: string, taken: string[]): CliAccountId {
  const base =
    name
      .replace(/[ıİşŞğĞçÇöÖüÜ]/g, (c) => TURKISH[c]!)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "account";
  // "default" would read as the CLI's own login.
  let id = base === "default" ? "default-2" : base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The login `ref` (its id or its name, in any case), or undefined. */
export function findAccount(config: RunnerConfig, ref: string): ClaudeAccount | undefined {
  const wanted = ref.trim().toLocaleLowerCase();
  return config.claudeAccounts?.find((a) => a.id === wanted || a.name.toLocaleLowerCase() === wanted);
}

/** A name for a login, trimmed; throws when it is empty or too long. */
function accountName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Give the account a name of up to 80 characters, e.g. myrel-runner claude add "Work".');
  return trimmed;
}

/** Throws when a login other than the one named `except` is already called `name`. */
function checkNameFree(config: RunnerConfig, name: string, except?: string) {
  const same = (a?: string) => a !== undefined && a !== except && a.toLocaleLowerCase() === name.toLocaleLowerCase();
  if (same(config.claudeDefaultName) || (config.claudeAccounts ?? []).some((a) => same(a.name))) {
    throw new Error(`There is already a Claude Code account named "${name}".`);
  }
}

/** Adds a login named `name`, in `dir` or a new folder of its own. Throws when it cannot. */
export async function addAccount(config: RunnerConfig, name: string, dir?: string): Promise<ClaudeAccount> {
  const trimmed = accountName(name);
  const accounts = config.claudeAccounts ?? [];
  if (accounts.length >= MAX_ACCOUNTS) throw new Error(`This computer already has ${MAX_ACCOUNTS} other Claude Code accounts; remove one first.`);
  checkNameFree(config, trimmed);
  const id = accountId(trimmed, accounts.map((a) => a.id));
  const folder = resolve(dir ?? join(claudeAccountsHome(), id));
  if (folder === claudeOwnDir()) {
    throw new Error(`${folder} is Claude Code's own login, which Myrel already uses. Name it with: myrel-runner claude rename default "${trimmed}"`);
  }
  const other = accounts.find((a) => a.dir === folder);
  if (other) throw new Error(`${folder} is already the account "${other.name}".`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const account = { id, name: trimmed, dir: folder };
  config.claudeAccounts = [...accounts, account];
  return account;
}

/** Forgets the login `ref`; its folder (and the login in it) stays. Undefined when there is none. */
export function removeAccount(config: RunnerConfig, ref: string): ClaudeAccount | undefined {
  const account = findAccount(config, ref);
  if (!account) return undefined;
  config.claudeAccounts = config.claudeAccounts!.filter((a) => a !== account);
  if (!config.claudeAccounts.length) delete config.claudeAccounts;
  return account;
}

/** Renames the login `ref`, or names the CLI's own one (ref "default"). False when there is none. */
export function renameAccount(config: RunnerConfig, ref: string, name: string): boolean {
  const trimmed = accountName(name);
  const wanted = ref.trim().toLocaleLowerCase();
  const own = wanted === "default" || wanted === config.claudeDefaultName?.toLocaleLowerCase();
  const account = own ? undefined : findAccount(config, ref);
  if (!own && !account) return false;
  checkNameFree(config, trimmed, own ? config.claudeDefaultName : account!.name);
  if (account) account.name = trimmed;
  else config.claudeDefaultName = trimmed;
  return true;
}

/**
 * The environment a task's CLI runs with for `account` (task.start's): Claude Code's config folder
 * of that login. Empty for the CLI's own; an error when this computer has no such login.
 */
export function accountEnv(config: RunnerConfig, cli: CliId, account: string | undefined): Record<string, string> | { error: string } {
  if (!account) return {};
  const found = ACCOUNT_CLIS.has(cli) ? config.claudeAccounts?.find((a) => a.id === account) : undefined;
  if (!found) return { error: `This computer has no ${cli === "claude" ? "Claude Code " : ""}account "${account}" any more. Choose another one for the thread, or add it again with \`myrel-runner claude add\`.` };
  return { CLAUDE_CONFIG_DIR: found.dir };
}

/** Where limits.json keeps a login's limits: the CLI's id for its own login, `<cli>@<account>` for another. */
export const limitsKey = (cli: CliId, account?: string) => (account ? `${cli}@${account}` : cli);

/** What hello says about a CLI's other logins (RunnerCli.accounts and defaultAccount). */
export function helloAccounts(
  config: RunnerConfig,
  cli: CliId,
  limits: Partial<Record<string, CliLimits>>,
): { accounts?: CliAccount[]; defaultAccount?: string } {
  const accounts = ACCOUNT_CLIS.has(cli) ? (config.claudeAccounts ?? []).slice(0, MAX_ACCOUNTS) : [];
  if (!accounts.length) return {};
  return {
    accounts: accounts.map((a) => {
      const l = limits[limitsKey(cli, a.id)];
      return { id: a.id, name: a.name.slice(0, 80), ...(l && { limits: l }) };
    }),
    ...(config.claudeDefaultName && { defaultAccount: config.claudeDefaultName.slice(0, 80) }),
  };
}

/** Claude Code's own account of whether `dir` holds a login (`claude auth status --json`); null when it could not say. */
export function claudeAuthStatus(dir?: string): Promise<{ loggedIn: boolean; subscriptionType?: string } | null> {
  return new Promise((done) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { timeout: 20_000, shell: process.platform === "win32", env: childEnv(dir ? { CLAUDE_CONFIG_DIR: dir } : undefined), windowsHide: true },
      (_err, stdout) => {
        // It exits 1 when signed out, still printing its JSON.
        try {
          const status = JSON.parse(stdout) as { loggedIn?: unknown; subscriptionType?: unknown };
          if (typeof status.loggedIn !== "boolean") return done(null);
          done({ loggedIn: status.loggedIn, ...(typeof status.subscriptionType === "string" && { subscriptionType: status.subscriptionType }) });
        } catch {
          done(null);
        }
      },
    );
  });
}

/** Runs Claude Code's own sign-in for the login in `dir`, in this terminal. Resolves with its exit code. */
export function claudeLogin(dir: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn("claude", ["auth", "login"], { stdio: "inherit", env: childEnv({ CLAUDE_CONFIG_DIR: dir }), shell: process.platform === "win32" });
    child.once("error", fail);
    child.once("close", (code) => done(code ?? 1));
  });
}
