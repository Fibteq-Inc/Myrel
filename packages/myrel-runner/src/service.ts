import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { runnerHome } from "./config";

const run = promisify(execFile);

/** The launchd label and systemd unit name. */
export const SERVICE_NAME = "io.fibteq.altair-runner";
const SYSTEMD_UNIT = "altair-runner.service";

export type ServiceManager = "launchd" | "systemd" | "startup";

export type ServiceInfo = {
  manager: ServiceManager;
  /** The file that starts the runner at login. */
  file: string;
  installed: boolean;
  /** null when the system cannot tell (Windows). */
  running: boolean | null;
  /** Where its output goes. */
  log: string;
};

/**
 * Runs `myrel-runner start` in the background now and at every login: a
 * launchd agent on macOS, a systemd user service on Linux and a Startup
 * folder entry on Windows. The runner is copied into ~/.altair-runner/bin
 * first, so the service keeps working after npx clears its cache. Running it
 * again replaces the copy, e.g. after updating myrel-runner.
 *
 * `script` is the running myrel-runner CLI file (a single bundled file).
 */
export async function installService(script: string): Promise<ServiceInfo> {
  const manager = serviceManager();
  const bin = join(runnerHome(), "bin", "altair-runner.mjs");
  await mkdir(join(runnerHome(), "bin"), { recursive: true, mode: 0o700 });
  if (script !== bin) await copyFile(script, bin);
  const args = [process.execPath, bin, "start"];
  const env = serviceEnv();
  const info = await describe(manager);

  if (manager === "launchd") {
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(info.file, launchdPlist(args, env, info.log));
    await restartLaunchd(info.file);
  } else if (manager === "systemd") {
    await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    await writeFile(info.file, systemdUnit(args, env));
    try {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
      await run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    } catch (err) {
      await rm(info.file, { force: true });
      throw new Error(
        `Could not register with systemd (${(err as Error).message.split("\n").filter(Boolean).at(-1)}). Use \`myrel-runner start\` instead.`,
      );
    }
  } else {
    await writeFile(info.file, startupScript(args, info.log));
    spawn("wscript.exe", [info.file], { detached: true, stdio: "ignore" }).unref();
  }
  return serviceStatus();
}

/** Stops the background runner and removes it from login. */
/**
 * Replaces the loaded launchd agent with the one in `file`. `bootout` returns before launchd has
 * finished unloading the old one, and bootstrapping meanwhile fails with "5: Input/output error",
 * so this waits for it to go and retries a few times.
 */
async function restartLaunchd(file: string) {
  const domain = `gui/${process.getuid?.()}`;
  const loaded = () => run("launchctl", ["print", `${domain}/${SERVICE_NAME}`]).then(() => true, () => false);
  await run("launchctl", ["bootout", `${domain}/${SERVICE_NAME}`]).catch(() => {});
  for (let i = 0; i < 50 && (await loaded()); i++) await sleep(100);
  for (let attempt = 1; ; attempt++) {
    try {
      await run("launchctl", ["bootstrap", domain, file]);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(500 * attempt);
    }
  }
  // Reported as running only once launchd has started it.
  for (let i = 0; i < 30; i++) {
    const out = await run("launchctl", ["print", `${domain}/${SERVICE_NAME}`]).catch(() => null);
    if (out?.stdout.includes("state = running")) return;
    await sleep(100);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uninstallService(): Promise<ServiceInfo> {
  const manager = serviceManager();
  const info = await describe(manager);
  if (manager === "launchd") {
    await run("launchctl", ["bootout", `gui/${process.getuid?.()}/${SERVICE_NAME}`]).catch(() => {});
  } else if (manager === "systemd") {
    await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).catch(() => {});
  }
  await rm(info.file, { force: true });
  if (manager === "systemd") await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  return serviceStatus();
}

export async function serviceStatus(): Promise<ServiceInfo> {
  const info = await describe(serviceManager());
  if (!info.installed) return { ...info, running: false };
  if (info.manager === "launchd") {
    const out = await run("launchctl", ["print", `gui/${process.getuid?.()}/${SERVICE_NAME}`]).catch(() => null);
    return { ...info, running: Boolean(out?.stdout.includes("state = running")) };
  }
  if (info.manager === "systemd") {
    const out = await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).catch(() => null);
    return { ...info, running: out?.stdout.trim() === "active" };
  }
  return { ...info, running: null };
}

function serviceManager(): ServiceManager {
  const os = platform();
  if (os === "darwin") return "launchd";
  if (os === "linux") return "systemd";
  if (os === "win32") return "startup";
  throw new Error(`Running in the background is not supported on ${os} yet. Use \`myrel-runner start\`.`);
}

async function describe(manager: ServiceManager): Promise<Omit<ServiceInfo, "running">> {
  const file =
    manager === "launchd"
      ? join(homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`)
      : manager === "systemd"
        ? join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT)
        : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "altair-runner.vbs");
  const log = manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : join(runnerHome(), "runner.log");
  const installed = Boolean(await stat(file).catch(() => null));
  return { manager, file, installed, log };
}

/**
 * The environment the service runs with. Login services start with a bare
 * PATH, so the current one is kept: that is where `claude`, `codex` and
 * `gemini` were found. npx's temporary folders are dropped.
 */
function serviceEnv(): Record<string, string> {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((p) => p && !/[\\/]_npx[\\/]/.test(p))
    .join(delimiter);
  const env: Record<string, string> = { PATH: path };
  if (process.env.ALTAIR_RUNNER_HOME) env.ALTAIR_RUNNER_HOME = process.env.ALTAIR_RUNNER_HOME;
  return env;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Restarted when it crashes, but not after a clean stop (unpaired or replaced). */
export function launchdPlist(args: string[], env: Record<string, string>, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const systemdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(args: string[], env: Record<string, string>): string {
  return `[Unit]
Description=Myrel runner (connects this computer to Myrel)
After=network-online.target

[Service]
ExecStart=${args.map(systemdQuote).join(" ")}
${Object.entries(env)
  .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
  .join("\n")}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Starts the runner hidden, with its output appended to the log. */
export function startupScript(args: string[], log: string): string {
  const command = `cmd.exe /c "${args.map((a) => `"${a}"`).join(" ")} >> "${log}" 2>&1"`;
  return `' Starts myrel-runner at login. Remove with: myrel-runner service uninstall\r
CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r
`;
}
