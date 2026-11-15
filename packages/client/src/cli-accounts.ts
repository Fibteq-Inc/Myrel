import { type CliId, type CliLimits, type CliLogin, cliLogins, type CliModelDefaults, resolveAccount, type RunnerCli, type Thread } from "@myrel/protocol";

/**
 * The login a thread's `cli` runs with from its next turn, as the server picks it (resolveAccount):
 * the thread's pick, else the project's default for the CLI, when the computer has it; else the CLI's
 * own. `logins`: all of that CLI's on the computer, its own first (just its own when it has no other).
 */
export function threadLogin(
  clis: RunnerCli[] | undefined,
  defaults: CliModelDefaults,
  thread: Pick<Thread, "cli">,
  cli: string,
): { logins: CliLogin[]; login: CliLogin | undefined } {
  const installed = clis?.find((c) => c.id === cli);
  const logins = installed ? cliLogins(installed) : [];
  const { account } = resolveAccount({ thread: thread.cli?.id === cli ? thread.cli.account : null, project: defaults[cli as CliId]?.account }, installed);
  return { logins, login: logins.find((l) => l.account === (account ?? null)) };
}

/** How much of a login's 5-hour window is used, rounded; null when its CLI has not said yet. */
export function sessionUse(limits: CliLimits | undefined): number | null {
  const used = limits?.windows.find((w) => w.kind === "session")?.usedPercent;
  return used === null || used === undefined ? null : Math.round(used);
}
