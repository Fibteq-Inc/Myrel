import { spawn } from "node:child_process";
import { access, constants, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { CliId } from "@myrel/protocol";

/**
 * Ubuntu (23.10 and later) lets a program without an AppArmor profile make a user namespace but
 * gives it no capabilities inside, unless this is 0. Bubblewrap needs them: it fails at once with
 * "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted". Ubuntu exempts only /usr/bin/bwrap,
 * and the CLIs that sandbox their commands with bubblewrap bring their own copy: Muse Code inside its
 * binary, Codex next to it. So below full access every command they run fails.
 */
export const USERNS_RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** The CLIs whose own bubblewrap needs the AppArmor profile. */
export type SandboxCli = Extract<CliId, "muse" | "codex">;

/** A CLI's bubblewrap and the path pattern its profile attaches to, so it keeps matching after the CLI updates. */
export type SandboxBinary = { cli: SandboxCli; path: string; attach: string };

export type SandboxState = {
  /** Linux with the restriction on: the CLIs below need the profile. */
  restricted: boolean;
  /** The restriction exists on this computer, on or off (Ubuntu with AppArmor). */
  applies: boolean;
  binaries: SandboxBinary[];
  /** The ones the installed profile does not cover yet: their sandbox fails while the restriction is on. */
  blocked: SandboxBinary[];
  /** Where this person's profile goes. */
  file: string;
};

type Paths = { restrict?: string; profileDir?: string; env?: NodeJS.ProcessEnv; user?: string; platform?: NodeJS.Platform };

/** The profile file for this person, one per user so two people on one computer do not overwrite each other. */
export function profileFile(user = safeUser(), dir = "/etc/apparmor.d"): string {
  return join(dir, `myrel-runner-${user}`);
}

function safeUser(): string {
  return userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
}

/** Looks at the restriction, the CLIs' bubblewrap and the installed profile. Never throws. */
export async function sandboxState(paths: Paths = {}): Promise<SandboxState> {
  const user = paths.user ?? safeUser();
  const file = profileFile(user, paths.profileDir);
  const state: SandboxState = { restricted: false, applies: false, binaries: [], blocked: [], file };
  if ((paths.platform ?? process.platform) !== "linux") return state;
  const value = await readFile(paths.restrict ?? USERNS_RESTRICT, "utf8").catch(() => null);
  if (value === null) return state;
  state.applies = true;
  state.restricted = value.trim() === "1";
  state.binaries = await findBinaries(paths.env ?? process.env);
  const profile = await readFile(file, "utf8").catch(() => "");
  state.blocked = state.binaries.filter((b) => !profile.includes(attachRule(b.attach)));
  return state;
}

/** The bubblewrap of each installed CLI that brings its own. */
export async function findBinaries(env: NodeJS.ProcessEnv = process.env): Promise<SandboxBinary[]> {
  const found: SandboxBinary[] = [];
  const muse = await onPath("muse", env);
  if (muse) {
    // `muse` is a launcher script that execs muse-bin-<version> beside it; the sandbox runs inside that binary.
    const dir = dirname(muse);
    const bins = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("muse-bin-")).sort();
    if (basename(muse).startsWith("muse-bin-") || bins.length) {
      found.push({ cli: "muse", path: basename(muse).startsWith("muse-bin-") ? muse : join(dir, bins.at(-1)!), attach: `${escape(dir)}/muse-bin-*` });
    }
  }
  const codex = await onPath("codex", env);
  if (codex) {
    // The standalone install: <releases>/<version>/bin/codex, with <releases>/<version>/codex-resources/bwrap.
    const release = dirname(dirname(codex));
    const bwrap = join(release, "codex-resources", "bwrap");
    if (await isFile(bwrap)) {
      const releases = dirname(release);
      found.push({ cli: "codex", path: bwrap, attach: basename(releases) === "releases" ? `${escape(releases)}/*/codex-resources/bwrap` : escape(bwrap) });
    }
  }
  return found;
}

/** The first executable called `bin` on PATH, with its links followed. */
async function onPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      // not here
    }
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** A literal path for an AppArmor pattern: its glob characters, quotes and backslashes escaped. */
function escape(path: string): string {
  return path.replace(/[\\"*?[\]{}^]/g, (c) => `\\${c}`);
}

function attachRule(attach: string): string {
  return `"${attach}" flags=(unconfined)`;
}

/**
 * The AppArmor profile that lets these binaries make user namespaces with capabilities, the way Ubuntu's
 * own bwrap-userns-restrict profile does for /usr/bin/bwrap. Unconfined otherwise: it only lifts the
 * restriction for them, and the rest of the computer keeps it.
 */
export function sandboxProfile(binaries: SandboxBinary[], user = safeUser()): string {
  const lines = [
    "# Written by myrel-runner (`myrel-runner sandbox fix`). Lets the bubblewrap that Muse Code and Codex",
    "# bring with them sandbox their commands under Ubuntu's restriction on unprivileged user namespaces.",
    "# Remove: sudo apparmor_parser -R <this file> && sudo rm <this file>",
    "abi <abi/4.0>,",
    "include <tunables/global>",
  ];
  for (const b of binaries) {
    const name = `myrel-runner-${user}-${b.cli}`;
    lines.push("", `profile ${name} ${attachRule(b.attach)} {`, "  userns,", `  include if exists <local/${name}>`, "}");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Whether the CLI runs its commands in its own bubblewrap at this access level: Codex in its read-only and
 * workspace-write sandboxes, Muse Code at edit and auto (read has no shell, full no sandbox).
 */
export function sandboxed(cli: CliId, access: "read" | "edit" | "auto" | "full"): boolean {
  if (cli === "codex") return access !== "full";
  if (cli === "muse") return access === "edit" || access === "auto";
  return false;
}

/**
 * What a run of Muse Code or Codex below full access is told when its sandbox cannot work here, so it
 * stops retrying commands and tells the person the fix. Nothing when the sandbox works.
 */
export async function sandboxNote(cli: CliId, state?: SandboxState): Promise<string | null> {
  if (cli !== "muse" && cli !== "codex") return null;
  const s = state ?? (await sandboxState());
  if (!s.restricted || !s.blocked.some((b) => b.cli === cli)) return null;
  return "(myrel-runner: on this computer Ubuntu's AppArmor blocks this CLI's sandbox, so every shell command fails with \"bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\". Do not retry commands or work around it. Read and edit files, use Myrel's tools, and tell the person to run `npx myrel-runner sandbox fix` once in a terminal on this computer (it asks for their sudo password), or to give this computer full access in Myrel > Devices.)";
}

/** One line for logs and `status`; null when nothing is wrong. */
export function sandboxProblem(s: SandboxState): string | null {
  if (!s.restricted || !s.blocked.length) return null;
  const names = [...new Set(s.blocked.map((b) => (b.cli === "muse" ? "Muse Code" : "Codex")))].join(" and ");
  return `Ubuntu's AppArmor blocks the sandbox of ${names}, so their commands fail below full access. Fix it once with \`myrel-runner sandbox fix\`.`;
}

/**
 * Installs the profile with sudo (which asks for the password in this terminal) and loads it. Runs as
 * the person, not under sudo: the CLIs are found on their PATH, in their home.
 */
export async function fixSandbox(log: (line: string) => void = console.log): Promise<void> {
  if (process.platform !== "linux") return log("Only Linux needs this; nothing to do here.");
  if (process.getuid?.() === 0 && process.env.SUDO_USER) {
    throw new Error("Run it without sudo, as yourself: it finds your CLIs in your home and asks for sudo by itself.");
  }
  const state = await sandboxState();
  if (!state.applies) return log("This computer does not restrict user namespaces with AppArmor; nothing to do.");
  if (!state.binaries.length) return log("Neither Muse Code nor Codex with its own bubblewrap is installed; nothing to do.");
  if (!state.blocked.length) return log(`The profile in ${state.file} already covers ${state.binaries.map((b) => b.path).join(" and ")}.`);
  const dir = await mkdtemp(join(tmpdir(), "myrel-apparmor-"));
  try {
    const tmp = join(dir, "profile");
    await writeFile(tmp, sandboxProfile(state.binaries), { mode: 0o644 });
    log(`Writing ${state.file} for:\n${state.binaries.map((b) => `  ${b.attach}`).join("\n")}`);
    const root = process.getuid?.() === 0;
    await sh(root ? "install" : "sudo", [...(root ? [] : ["install"]), "-m", "0644", tmp, state.file]);
    await sh(root ? "apparmor_parser" : "sudo", [...(root ? [] : ["apparmor_parser"]), "-r", state.file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log(
    state.restricted
      ? "Done: Muse Code and Codex can sandbox their commands now. Running tasks pick it up with their next command."
      : "Done. The restriction is off right now, so nothing changes yet; the CLIs keep working once it is back on (after a restart, for example).",
  );
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", (err) => reject(new Error(`Could not run ${cmd}: ${err.message}`)));
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`\`${cmd} ${args.join(" ")}\` failed (exit ${code}).`))));
  });
}
