import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { delimiter, join } from "node:path";
import { selfCommand } from "./bridge";
import { readJson } from "./config";

/**
 * An agent run's `ssh`, `scp` and `sftp` (feature "ssh"): small scripts at the front of the CLI's PATH
 * that start `myrel-runner ssh-shim`. `ssh <alias> <command>` becomes a call to Myrel's ssh_run tool,
 * so it is put to the computer's owner on a card and runs with Myrel's key for that server, never the
 * person's own. Anything else (a session without a command, forwarding, file transfer) is refused.
 * git's own SSH (git-upload-pack and the like) goes to the real ssh, as it would without Myrel.
 *
 * MYREL_SSH_SHIM names a file only this user can read, in the run's private folder, holding the
 * thread's MCP address and the run's token (which the CLI's MCP config holds too).
 */
export const SHIM_VAR = "MYREL_SSH_SHIM";
export const SHIM_TOOLS = ["ssh", "scp", "sftp"] as const;

/** How long the shim waits for Myrel: the person's answer (10 minutes) and the command (5). */
const CALL_TIMEOUT_MS = 16 * 60 * 1000;

/** Writes the scripts into `<runDir>/ssh-bin` and returns the run's environment changes. */
export async function installShim(runDir: string, mcp: { url: string; token: string }, platform = process.platform): Promise<Record<string, string>> {
  const bin = join(runDir, "ssh-bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const self = selfCommand();
  for (const tool of SHIM_TOOLS) {
    if (platform === "win32") {
      const words = [self.command, ...self.args].map((w) => `"${w}"`).join(" ");
      await writeFile(join(bin, `${tool}.cmd`), `@echo off\r\n${words} ssh-shim ${tool} %*\r\n`, { mode: 0o700 });
    } else {
      const words = [self.command, ...self.args].map((w) => `'${w.replaceAll("'", "'\\''")}'`).join(" ");
      const file = join(bin, tool);
      await writeFile(file, `#!/bin/sh\nexec ${words} ssh-shim ${tool} "$@"\n`, { mode: 0o700 });
      await chmod(file, 0o700);
    }
  }
  const config = join(runDir, "ssh-shim.json");
  await writeFile(config, JSON.stringify(mcp), { mode: 0o600 });
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(platform === "win32" ? ";" : ":"), [SHIM_VAR]: config };
}

export type ShimCall =
  | { kind: "run"; host: string; command: string }
  | { kind: "passthrough" }
  | { kind: "refuse"; message: string };

/** ssh's flags that take no value and change nothing that matters here. */
const HARMLESS_FLAGS = new Set("qTn46vxCa".split(""));
/** Flags whose value Myrel replaces with the server's settings. */
const VALUE_FLAGS = new Set(["p", "l"]);
/** -o settings that are harmless here; any other is refused. */
const HARMLESS_OPTIONS = /^(?:BatchMode|ConnectTimeout|ServerAliveInterval|ServerAliveCountMax|LogLevel|StrictHostKeyChecking|UserKnownHostsFile|ConnectionAttempts)=/i;

/** Exactly what git sends, a repository path and nothing a shell would read as another command. */
const GIT_TRANSPORT = /^(?:git[- ](?:upload-pack|receive-pack|upload-archive) '[^'\n]*'|git-lfs-(?:authenticate|transfer) '?[\w./~-]+'? (?:upload|download))$/;

const FILE_TRANSFER =
  "Copying files over SSH (scp, sftp, rsync) is not available to Myrel's agents yet. Run a command on the server with ssh_run instead (e.g. cat a file to read it).";

/** What an agent's `ssh …` asks for. */
export function parseSsh(args: string[]): ShimCall {
  // git's transport for a repository over SSH (with its own -o SendEnv=GIT_PROTOCOL): not Myrel's business.
  if (args.length > 1 && GIT_TRANSPORT.test(args[args.length - 1]!)) return { kind: "passthrough" };
  let i = 0;
  let user: string | undefined;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    const flags = arg.slice(1);
    for (let j = 0; j < flags.length; j++) {
      const f = flags[j]!;
      if (HARMLESS_FLAGS.has(f)) continue;
      if (VALUE_FLAGS.has(f) || f === "o") {
        const value = flags.slice(j + 1) || args[++i];
        if (value === undefined) return { kind: "refuse", message: `ssh: -${f} needs a value.` };
        if (f === "l") user = value;
        if (f === "o" && !HARMLESS_OPTIONS.test(value)) {
          return { kind: "refuse", message: `ssh -o ${value.split("=")[0]} is not available to Myrel's agents: Myrel sets up the connection itself.` };
        }
        break;
      }
      if (f === "s") return { kind: "refuse", message: FILE_TRANSFER };
      if ("LRDW".includes(f)) return { kind: "refuse", message: "Port forwarding over SSH is not available to Myrel's agents." };
      if (f === "A") return { kind: "refuse", message: "Agent forwarding is not available to Myrel's agents." };
      if ("tN".includes(f)) return { kind: "refuse", message: "Interactive SSH sessions are not available to Myrel's agents: run one command at a time, e.g. `ssh <host> uptime`." };
      return { kind: "refuse", message: `ssh -${f} is not available to Myrel's agents. Use \`ssh <host> <command>\`, or Myrel's ssh_run tool.` };
    }
  }
  const destination = args[i];
  if (!destination) return { kind: "refuse", message: "Usage: ssh <host> <command> (a host from the project's SSH settings)." };
  const words = args.slice(i + 1);
  const command = words.join(" ").trim();
  if (/^(?:rsync\s+--server|scp\s+-[\w ]*[tf]\b|sftp-server|internal-sftp)/.test(command)) return { kind: "refuse", message: FILE_TRANSFER };
  if (!command) return { kind: "refuse", message: "Interactive SSH sessions are not available to Myrel's agents: run one command at a time, e.g. `ssh <host> uptime`." };
  // ssh://user@host:port, user@host
  const bare = destination.replace(/^ssh:\/\//, "").replace(/:\d+$/, "");
  const at = bare.lastIndexOf("@");
  const host = at >= 0 ? bare.slice(at + 1) : bare;
  const who = at >= 0 ? bare.slice(0, at) : user;
  return { kind: "run", host: who ? `${who}@${host}` : host, command };
}

/** `myrel-runner ssh-shim <tool> …`: started by the run's ssh, scp or sftp, never by people. Returns the exit code. */
export async function runShim(tool: string | undefined, args: string[], io = { out: process.stdout, err: process.stderr }): Promise<number> {
  const call: ShimCall = tool === "ssh" ? parseSsh(args) : { kind: "refuse", message: FILE_TRANSFER };
  if (call.kind === "refuse") {
    io.err.write(`${call.message}\n`);
    return 255;
  }
  if (call.kind === "passthrough") return realSsh(args);
  const config = process.env[SHIM_VAR] ? await readJson<{ url: string; token: string }>(process.env[SHIM_VAR]!).catch(() => undefined) : undefined;
  if (!config) {
    io.err.write("SSH from this run goes through Myrel, but the run's settings are gone. Use Myrel's ssh_run tool.\n");
    return 255;
  }
  const answer = await callTool(config, { host: call.host, command: call.command, reason: "Asked from the shell (ssh)." });
  if (!answer.ok) {
    io.err.write(`${answer.text}\n`);
    return 255;
  }
  try {
    const result = JSON.parse(answer.text) as { exit_code: number | null; stdout?: string; stderr?: string };
    if (result.stdout) io.out.write(result.stdout);
    if (result.stderr) io.err.write(result.stderr);
    return typeof result.exit_code === "number" ? result.exit_code : 255;
  } catch {
    io.err.write(`${answer.text}\n`);
    return 255;
  }
}

/** Calls ssh_run on the thread's MCP endpoint and returns its text (ok false: refused or failed). */
function callTool(config: { url: string; token: string }, args: { host: string; command: string; reason: string }): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ssh_run", arguments: args } });
    const request = config.url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = request(
      config.url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${config.token}`, "content-length": Buffer.byteLength(body) },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 2_000_000) text += chunk;
        });
        res.on("end", () => resolve(toolText(res.statusCode, text)));
        res.on("error", () => resolve({ ok: false, text: "Lost the connection to Myrel." }));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ ok: false, text: "Could not reach Myrel to ask about this SSH command." }));
    req.end(body);
  });
}

function toolText(status: number | undefined, text: string): { ok: boolean; text: string } {
  if (status !== 200) return { ok: false, text: status === 401 ? "This run's turn has ended; SSH through Myrel is closed." : `Myrel answered ${status}.` };
  try {
    const answer = JSON.parse(text) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
    if (answer.error) return { ok: false, text: answer.error.message ?? "Myrel refused the call." };
    const first = answer.result?.content?.[0]?.text ?? "";
    return { ok: !answer.result?.isError, text: first };
  } catch {
    return { ok: false, text: "Myrel's answer could not be read." };
  }
}

/** git's SSH: the first ssh on PATH after the run's own scripts. */
function realSsh(args: string[]): Promise<number> {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const path = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((p) => !p.endsWith(`${process.platform === "win32" ? "\\" : "/"}ssh-bin`))
    .join(delimiter);
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit", env: { ...process.env, [pathKey]: path } });
    child.once("error", () => resolve(255));
    child.once("close", (code) => resolve(code ?? 255));
  });
}
