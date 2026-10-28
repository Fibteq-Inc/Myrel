import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { MAX_SSH_OUTPUT, SSH_TIMEOUT_MS, type SshHostKey, type SshKeyRef, type SshLocalKey, type SshResult, type SshTarget } from "@myrel/protocol";
import { readJson, runnerHome, writeJson } from "./config";

/**
 * SSH for the project's agents (feature "ssh"). The runner, not the agent's CLI, holds the keys and
 * runs the commands, one at a time, after the computer's owner allowed each on a card in Myrel:
 *
 * - ~/.myrel-runner/ssh/<project>/<alias>: the key Myrel made for that server (mode 600). Its
 *   passphrase, when the computer has a keychain (macOS Keychain, Secret Service on Linux), is kept
 *   there and nowhere else; without one the key has none, protected by its file mode alone.
 * - keys.json: the servers that use one of the person's own keys in ~/.ssh instead (its path only).
 * - known_hosts: each server's key as the person confirmed it, under its own name
 *   (HostKeyAlias myrel.<project>.<alias>), checked strictly on every connection.
 *
 * The person's ~/.ssh/config, ssh-agent and known_hosts are never used for these connections.
 */

export const sshHome = () => join(runnerHome(), "ssh");
const keysFile = () => join(sshHome(), "keys.json");
const knownHostsFile = () => join(sshHome(), "known_hosts");
const askpassFile = () => join(sshHome(), "askpass.sh");
const KEYCHAIN_SERVICE = "myrel-runner-ssh";
/** How long a connection test may take. */
const TEST_TIMEOUT_MS = 30_000;

const keyPath = (ref: SshKeyRef) => join(sshHome(), ref.projectId, ref.alias);
const keyAccount = (ref: SshKeyRef) => `${ref.projectId}/${ref.alias}`;
/** The name the server's key is kept under in known_hosts, whatever its address. */
export const hostKeyAlias = (ref: SshKeyRef) => `myrel.${ref.projectId}.${ref.alias}`;

/** "SHA256:…" of a public key's blob, as `ssh-keygen -l` prints it. */
export function fingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1] ?? "";
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

type Exec = { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };

/** Runs a program without a shell; output past `max` (each stream) is dropped. */
export function exec(
  bin: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; max?: number } = {},
): Promise<Exec> {
  const max = opts.max ?? MAX_SSH_OUTPUT;
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env: opts.env ?? sshEnv(), stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (current: string, chunk: string) => {
      if (current.length + chunk.length <= max) return current + chunk;
      truncated = true;
      return current + chunk.slice(0, Math.max(0, max - current.length));
    };
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (stdout = take(stdout, c)));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr = take(stderr, c)));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, truncated, timedOut });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** The environment ssh runs with: the runner's own, without the person's ssh-agent or the runner's token. */
export function sshEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "MYREL_RUNNER_TOKEN"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

// ---- keychain ---------------------------------------------------------------

/**
 * The OS keychain, for a key's passphrase: macOS's `security` and Linux's `secret-tool`. The secret
 * goes in on stdin, never on a command line other processes can see. null where there is none
 * (Windows, a Linux server without a Secret Service).
 */
export type Keychain = {
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
};

export function osKeychain(platform = process.platform): Keychain | null {
  if (platform === "darwin") {
    return {
      async set(account, secret) {
        // `security -i` reads its commands from stdin, so the secret is not in its arguments.
        const r = await exec("security", ["-i"], { input: `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -w "${secret}"\n`, timeoutMs: 15_000 });
        if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
      },
      async get(account) {
        const r = await exec("security", ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], { timeoutMs: 15_000 });
        return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
      },
      async remove(account) {
        await exec("security", ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], { timeoutMs: 15_000 }).catch(() => {});
      },
    };
  }
  if (platform === "linux") {
    return {
      async set(account, secret) {
        const r = await exec("secret-tool", ["store", `--label=Myrel SSH key ${account}`, "service", KEYCHAIN_SERVICE, "account", account], { input: secret, timeoutMs: 15_000 });
        if (r.code !== 0) throw new Error(`Secret Service: ${r.stderr.trim() || `exit ${r.code}`}`);
      },
      async get(account) {
        const r = await exec("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account], { timeoutMs: 15_000 });
        return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : null;
      },
      async remove(account) {
        await exec("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account], { timeoutMs: 15_000 }).catch(() => {});
      },
    };
  }
  return null;
}

/** Saves a new passphrase and reads it back; false when the keychain is missing or does not work here. */
async function keepPassphrase(keychain: Keychain | null, account: string, secret: string): Promise<boolean> {
  if (!keychain) return false;
  try {
    await keychain.set(account, secret);
    return (await keychain.get(account)) === secret;
  } catch {
    return false;
  }
}

// ---- keys -------------------------------------------------------------------

type KeyMap = Record<string, string>;

/** Makes a key for the server (or takes one of the person's own) and returns its public half. */
export async function makeKey(
  ref: SshKeyRef,
  comment: string,
  existing?: string,
  keychain: Keychain | null = osKeychain(),
): Promise<{ publicKey: string; fingerprint: string; protected: boolean }> {
  await mkdir(sshHome(), { recursive: true, mode: 0o700 });
  await forgetKey(ref, keychain);
  if (existing) {
    const path = await ownKey(existing);
    // A key with a passphrase cannot be used without someone typing it.
    const r = await exec("ssh-keygen", ["-y", "-P", "", "-f", path], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new Error(
        /passphrase|incorrect/i.test(r.stderr)
          ? "This key has a passphrase, so Myrel cannot use it on its own. Let Myrel make a new key instead."
          : `Could not read ${path}: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    const keys = (await readJson<KeyMap>(keysFile())) ?? {};
    keys[keyAccount(ref)] = path;
    await writeJson(keysFile(), keys);
    const publicKey = r.stdout.trim();
    return { publicKey, fingerprint: fingerprint(publicKey), protected: false };
  }
  const path = keyPath(ref);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const passphrase = randomBytes(24).toString("base64url");
  const kept = await keepPassphrase(keychain, keyAccount(ref), passphrase);
  // ssh-keygen takes the passphrase only as an argument; it is on its command line for the moment it runs.
  const r = await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", kept ? passphrase : "", "-C", comment, "-f", path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr.trim() || `exit ${r.code}`}. Is OpenSSH installed on this computer?`);
  await chmod(path, 0o600).catch(() => {});
  const publicKey = (await readFile(`${path}.pub`, "utf8")).trim();
  return { publicKey, fingerprint: fingerprint(publicKey), protected: kept };
}

/** A key file the person picked: it must be in their ~/.ssh. */
async function ownKey(raw: string, home = homedir()): Promise<string> {
  const folder = join(home, ".ssh");
  const path = resolve(folder, raw);
  const rel = relative(folder, path);
  if (!rel || rel.startsWith("..") || resolve(folder, rel) !== path) throw new Error("Only keys in ~/.ssh can be used.");
  await access(path);
  return path;
}

/** The keys in ~/.ssh that have a private half next to their .pub, by name and fingerprint. */
export async function listKeys(home = homedir()): Promise<SshLocalKey[]> {
  const folder = join(home, ".ssh");
  const names = await readdir(folder).catch(() => [] as string[]);
  const keys: SshLocalKey[] = [];
  for (const name of names.filter((n) => n.endsWith(".pub")).sort()) {
    const path = join(folder, name.slice(0, -4));
    if (!(await access(path).then(() => true, () => false))) continue;
    const line = (await readFile(join(folder, name), "utf8").catch(() => "")).trim();
    const [type, blob, ...rest] = line.split(/\s+/);
    if (!type || !blob) continue;
    keys.push({ path, name: name.slice(0, -4), type, fingerprint: fingerprint(line), comment: rest.join(" ").slice(0, 500) });
  }
  return keys.slice(0, 100);
}

/** Deletes the key Myrel made for this server, its passphrase and its known host. A person's own key stays. */
export async function forgetKey(ref: SshKeyRef, keychain: Keychain | null = osKeychain()): Promise<void> {
  const path = keyPath(ref);
  await rm(path, { force: true });
  await rm(`${path}.pub`, { force: true });
  await keychain?.remove(keyAccount(ref));
  const keys = await readJson<KeyMap>(keysFile());
  if (keys && keyAccount(ref) in keys) {
    delete keys[keyAccount(ref)];
    await writeJson(keysFile(), keys);
  }
  await setKnownHost(ref, null);
}

/** Which key file a server uses, and its passphrase if it has one. */
async function keyFor(ref: SshKeyRef, keychain: Keychain | null): Promise<{ path: string; passphrase: string | null } | null> {
  const own = (await readJson<KeyMap>(keysFile()))?.[keyAccount(ref)];
  if (own) return { path: own, passphrase: null };
  const path = keyPath(ref);
  if (!(await access(path).then(() => true, () => false))) return null;
  return { path, passphrase: (await keychain?.get(keyAccount(ref)).catch(() => null)) ?? null };
}

// ---- server keys -------------------------------------------------------------

/** The server's own keys, for the person to confirm one by its fingerprint. ed25519 first. */
export async function scanHostKeys(host: string, port: number): Promise<SshHostKey[]> {
  const r = await exec("ssh-keyscan", ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", "--", host], { timeoutMs: 30_000 });
  const keys = parseKeyscan(r.stdout);
  if (!keys.length) throw new Error(`${host}:${port} did not answer with a server key${r.stderr.trim() ? ` (${r.stderr.trim().split("\n").pop()})` : ""}.`);
  return keys;
}

const KEY_ORDER = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "ssh-rsa"];

export function parseKeyscan(output: string): SshHostKey[] {
  const keys: SshHostKey[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [, type, blob] = line.trim().split(/\s+/);
    if (!type || !blob || !/^[A-Za-z0-9+/=]+$/.test(blob)) continue;
    const key = `${type} ${blob}`;
    if (keys.some((k) => k.key === key)) continue;
    keys.push({ type, key, fingerprint: fingerprint(key) });
  }
  const rank = (t: string) => (KEY_ORDER.indexOf(t) + 1 || 99);
  return keys.sort((a, b) => rank(a.type) - rank(b.type)).slice(0, 10);
}

/**
 * Keeps `hostKey` as this server's key in the runner's known_hosts (replacing any earlier one), or
 * drops it (null). `replace` false: only adds a missing one, and fails when another key is kept.
 */
export async function setKnownHost(ref: SshKeyRef, hostKey: string | null, replace = true): Promise<void> {
  const name = hostKeyAlias(ref);
  const lines = (await readFile(knownHostsFile(), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const mine = lines.filter((l) => l.startsWith(`${name} `));
  const want = hostKey ? `${name} ${hostKey.trim().split(/\s+/).slice(0, 2).join(" ")}` : null;
  if (!replace && mine.length) {
    if (want && mine.includes(want)) return;
    throw new HostKeyChanged();
  }
  const next = [...lines.filter((l) => !l.startsWith(`${name} `)), ...(want ? [want] : [])];
  if (!want && !mine.length) return;
  await mkdir(sshHome(), { recursive: true, mode: 0o700 });
  await writeFile(knownHostsFile(), next.length ? `${next.join("\n")}\n` : "", { mode: 0o600 });
}

class HostKeyChanged extends Error {
  constructor() {
    super("The server's key is not the one confirmed in Myrel.");
  }
}

// ---- running --------------------------------------------------------------------

/** ssh's options for one command: only Myrel's key, its known_hosts and none of the person's config. */
export function sshArgs(target: SshTarget, key: string, opts: { passphrase: boolean; timeoutSec: number }): string[] {
  const o = (s: string) => ["-o", s];
  return [
    "-F",
    "none",
    "-T",
    "-n",
    ...o(`BatchMode=${opts.passphrase ? "no" : "yes"}`),
    ...o("IdentitiesOnly=yes"),
    ...o("IdentityAgent=none"),
    ...o("PasswordAuthentication=no"),
    ...o("KbdInteractiveAuthentication=no"),
    ...o("StrictHostKeyChecking=yes"),
    ...o(`UserKnownHostsFile=${knownHostsFile()}`),
    ...o(`GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`),
    ...o(`HostKeyAlias=${hostKeyAlias(target)}`),
    ...o("UpdateHostKeys=no"),
    ...o("ForwardAgent=no"),
    ...o("ForwardX11=no"),
    ...o("ClearAllForwardings=yes"),
    ...o("PermitLocalCommand=no"),
    ...o(`ConnectTimeout=${opts.timeoutSec}`),
    "-i",
    key,
    "-p",
    String(target.port),
    "-l",
    target.user,
    "--",
    target.host,
  ];
}

/** Runs one command on the server. With `trust`, first keeps the target's host key (a test from the settings). */
export async function runSsh(target: SshTarget, command: string, opts: { trust?: boolean; keychain?: Keychain | null; timeoutMs?: number } = {}): Promise<SshResult> {
  const started = Date.now();
  const fail = (error: NonNullable<SshResult["error"]>, stderr: string): SshResult => ({ exitCode: null, stdout: "", stderr, truncated: false, ms: Date.now() - started, error });
  const keychain = opts.keychain === undefined ? osKeychain() : opts.keychain;
  const key = await keyFor(target, keychain);
  if (!key) return fail("nokey", "This computer has no key for this server. Set it up again in the project's SSH settings.");
  try {
    await setKnownHost(target, target.hostKey, !!opts.trust);
  } catch (err) {
    if (err instanceof HostKeyChanged) return fail("hostkey", err.message);
    throw err;
  }
  const timeoutMs = opts.timeoutMs ?? SSH_TIMEOUT_MS;
  const env = key.passphrase ? sshEnv({ SSH_ASKPASS: await askpass(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || ":0", MYREL_SSH_PASSPHRASE: key.passphrase }) : sshEnv();
  const r = await exec("ssh", [...sshArgs(target, key.path, { passphrase: !!key.passphrase, timeoutSec: 15 }), command], { env, timeoutMs });
  const ms = Date.now() - started;
  if (r.timedOut) return { exitCode: null, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, ms, error: "timeout" };
  return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, ms, ...(r.code === 255 && { error: sshError(r.stderr) }) };
}

export const testSsh = (target: SshTarget, keychain?: Keychain | null) => runSsh(target, "true", { trust: true, keychain, timeoutMs: TEST_TIMEOUT_MS });

/** Why ssh itself failed (exit 255), from what it printed. */
export function sshError(stderr: string): NonNullable<SshResult["error"]> {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) return "hostkey";
  if (/Permission denied|Too many authentication failures|no mutual signature/i.test(stderr)) return "auth";
  if (/Connection (refused|timed out|closed)|Could not resolve|No route to host|Network is unreachable|Operation timed out/i.test(stderr)) return "connect";
  return "other";
}

/** A small program ssh asks for the key's passphrase, which hands back the one in its environment. */
async function askpass(): Promise<string> {
  const path = askpassFile();
  await mkdir(sshHome(), { recursive: true, mode: 0o700 });
  await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$MYREL_SSH_PASSPHRASE"\n', { mode: 0o700 });
  return path;
}
