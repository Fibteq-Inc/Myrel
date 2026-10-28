import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, Timestamp } from "./models";

/**
 * SSH access for a project's agents (phase 1: on a local runner only). A server is registered in the
 * project's SSH settings with a short alias (`prod-web`); the agent asks for one command at a time with
 * `ssh_run(host, command, reason)`, the owner of the computer holding the key answers a card, and that
 * computer's runner runs it. The private key and its passphrase never leave the computer
 * (~/.myrel-runner/ssh, mode 600; the passphrase in the OS keychain where there is one): Myrel keeps
 * only what is below.
 */

export const SshHostId = z.string().regex(idPattern("sshHost"));

/** What agents call the server: lowercase letters, digits, - and _. */
export const SshAlias = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use lowercase letters, digits, - and _ (up to 40).");

/** A host name or IP address, without user or port. */
export const SshHostName = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?|\[?[0-9A-Fa-f:.]+\]?)$/, "Enter a host name or IP address.");

/** A login name on the server. Never starts with "-", so it cannot read as an ssh option. */
export const SshUser = z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/, "Enter the user name on the server.");

/** ask: every command waits for the computer owner's OK. off: registered, but agents cannot use it. */
export const SshRule = z.enum(["ask", "off"]);
export type SshRule = z.infer<typeof SshRule>;

/** A public key line as OpenSSH writes it ("ssh-ed25519 AAAA… comment"). */
export const SshPublicKey = z.string().max(16_000).regex(/^(?:ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+(?: .*)?$/);

/** "SHA256:…" as `ssh-keygen -l` prints it. */
export const SshFingerprint = z.string().max(200).regex(/^SHA256:[A-Za-z0-9+/=]+$/);

/** A server in the project's SSH settings. */
export const SshHost = z.object({
  id: SshHostId,
  projectId: ProjectId,
  alias: SshAlias,
  host: z.string(),
  port: z.number().int(),
  user: z.string(),
  /** The computer that holds the key and runs the commands. */
  runnerId: z.string(),
  runnerName: z.string(),
  /** Whether you own that computer: only its owner sets the server up and answers its cards. */
  mine: z.boolean(),
  keySource: z.enum(["new", "existing"]),
  publicKey: z.string().nullable(),
  keyFingerprint: z.string().nullable(),
  hostFingerprint: z.string().nullable(),
  rule: SshRule,
  testedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type SshHost = z.infer<typeof SshHost>;

/** One SSH command an agent asked for, in the project's SSH history. */
export const SshAuditEntry = z.object({
  id: z.string(),
  alias: z.string(),
  threadId: z.string().nullable(),
  command: z.string(),
  reason: z.string().nullable(),
  decision: z.enum(["once", "turn", "deny", "timeout", "failed"]),
  approvedBy: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  ms: z.number().int().nullable(),
  at: Timestamp,
});
export type SshAuditEntry = z.infer<typeof SshAuditEntry>;

/** GET /api/projects/:id/ssh. */
export const SshSettings = z.object({ hosts: z.array(SshHost), history: z.array(SshAuditEntry) });
export type SshSettings = z.infer<typeof SshSettings>;

/** Adds a server: a new key on the computer (default), or one of its keys in ~/.ssh (`existingKey`, its path). */
export const CreateSshHostInput = z.object({
  runnerId: z.string(),
  alias: SshAlias,
  host: SshHostName,
  port: z.number().int().min(1).max(65535).default(22),
  user: SshUser,
  existingKey: z.string().min(1).max(1024).optional(),
});
export type CreateSshHostInput = z.infer<typeof CreateSshHostInput>;

export const UpdateSshHostInput = z.object({ rule: SshRule });
export type UpdateSshHostInput = z.infer<typeof UpdateSshHostInput>;

/** Saves the server key the person confirmed by its fingerprint, then tests the connection. */
export const TrustSshHostInput = z.object({ hostKey: z.string().min(1).max(16_000) });
export type TrustSshHostInput = z.infer<typeof TrustSshHostInput>;

/** One of the server's own keys, as ssh-keyscan found it. */
export const SshHostKey = z.object({ type: z.string().max(60), key: z.string().max(16_000), fingerprint: SshFingerprint });
export type SshHostKey = z.infer<typeof SshHostKey>;

/** A key in the computer's ~/.ssh, by name and fingerprint only. */
export const SshLocalKey = z.object({ path: z.string().max(1024), name: z.string().max(255), type: z.string().max(60), fingerprint: SshFingerprint, comment: z.string().max(500) });
export type SshLocalKey = z.infer<typeof SshLocalKey>;

/** How a test or a command ended. error: why ssh itself failed, when it did. */
export const SshResult = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  /** Output past MAX_SSH_OUTPUT was cut. */
  truncated: z.boolean(),
  ms: z.number().int().nonnegative(),
  error: z.enum(["hostkey", "auth", "connect", "timeout", "nokey", "other"]).optional(),
});
export type SshResult = z.infer<typeof SshResult>;

/** Longest a command runs, and how much of its output comes back (stdout and stderr each). */
export const SSH_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_SSH_OUTPUT = 200 * 1024;

/** Which key the runner uses: the one it keeps for this project's alias. */
export const SshKeyRef = z.object({ projectId: ProjectId, alias: SshAlias });
export type SshKeyRef = z.infer<typeof SshKeyRef>;

/** Where a command goes. `hostKey`: the server key the person confirmed; the runner refuses any other. */
export const SshTarget = SshKeyRef.extend({
  host: SshHostName,
  port: z.number().int().min(1).max(65535),
  user: SshUser,
  hostKey: z.string().min(1).max(16_000),
});
export type SshTarget = z.infer<typeof SshTarget>;

/** The line to add to ~/.ssh/authorized_keys on the server: `restrict` turns off forwarding, X11 and ttys. */
export function authorizedKeysLine(publicKey: string): string {
  return `restrict ${publicKey.trim()}`;
}

/** The shell command that adds that line on the server. */
export function authorizedKeysCommand(publicKey: string): string {
  const line = authorizedKeysLine(publicKey).replaceAll("'", "");
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${line}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/**
 * Commands that delete, stop, overwrite or reboot: their card is red, "Don't run" is the suggested
 * answer, and allowing a server for the turn does not cover them. A guess on the command's text, so
 * it errs on the side of asking.
 */
const DESTRUCTIVE = [
  /(?:^|[\s;&|(`$])(?:sudo\s+)?(?:rm|rmdir|shred|unlink|mkfs(?:\.\w+)?|wipefs|fdisk|parted|dd|truncate)\b/,
  /(?:^|[\s;&|(`$])(?:sudo\s+)?(?:reboot|shutdown|halt|poweroff|init\s+[06])\b/,
  /\bsystemctl\s+(?:stop|disable|mask|kill|reboot|poweroff|halt)\b/,
  /\bservice\s+\S+\s+stop\b/,
  /\b(?:kill|pkill|killall)\b/,
  /\bdocker\s+(?:rm|rmi|kill|stop|system\s+prune|volume\s+(?:rm|prune)|compose\s+down)\b/,
  /\bkubectl\s+(?:delete|drain|scale)\b/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|push\s+(?:-f|--force))/,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\b(?:chmod|chown)\s+-R\b/,
  /\bmv\s+\S+\s+\/dev\/null\b/,
  /(?:^|[^>&0-9])>\s*\/(?:etc|boot|usr|var|bin|sbin|lib)\//,
  /\bcrontab\s+-r\b/,
  /\biptables\s+-F\b/,
  /\bufw\s+(?:disable|reset)\b/,
];

export function destructiveCommand(command: string): boolean {
  return DESTRUCTIVE.some((r) => r.test(command));
}
