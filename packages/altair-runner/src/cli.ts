#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLI_NAMES } from "@altair/protocol";
import { detectClis } from "./clis";
import { type Access, configPath, loadConfig, saveConfig, shareFolder, unshareFolder } from "./config";
import { checkPairing, pair, RUNNER_VERSION, startRunner } from "./runner";
import { installService, type ServiceInfo, serviceStatus, uninstallService } from "./service";
import { isNewer, latestVersion, runVersion } from "./update";

const HELP = `altair-runner ${RUNNER_VERSION}
Connects this computer to Altair, so projects can work in folders you share
using your own Claude Code, Codex or Gemini CLI. Your CLI logins never leave
this computer.

Usage:
  altair-runner pair <code> --server <url> [--name <name>]
                                 Pair with your account (code from Altair > Devices)
  altair-runner share [folder]   Share a folder (default: the current one)
  altair-runner unshare <folder> Stop sharing a folder
  altair-runner status           Show the server, shared folders and installed CLIs
  altair-runner service install  Run in the background now and at every login
  altair-runner service uninstall
                                 Stop the background runner and remove it from login
  altair-runner service status   Show whether the background runner is installed and running
  altair-runner start [--access read|edit|full] [--json]
                                 Connect and run tasks in this terminal until stopped (Ctrl+C)
  altair-runner update           Update to the newest version and restart the background runner
  altair-runner logout           Forget the pairing on this computer

--access sets what the CLI may do without asking: read (look only),
edit (change files; the default) or full (also run any command). It is saved,
so the background runner uses it too.
--json prints one JSON status object per line instead of messages.

Environment: ALTAIR_SERVER and ALTAIR_RUNNER_TOKEN override the saved pairing;
ALTAIR_RUNNER_HOME moves the config folder (default ~/.altair-runner).
`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      name: { type: "string" },
      access: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, arg] = positionals;
  if (values.version) return console.log(RUNNER_VERSION);
  if (values.help || !command) return console.log(HELP);

  switch (command) {
    case "pair": {
      const server = values.server ?? (await loadConfig()).server;
      if (!arg || !server) throw new Error("Usage: altair-runner pair <code> --server <url>");
      const config = await pair({ server, code: arg, name: values.name });
      console.log(`Paired with ${config.server}.`);
      console.log("Next: `altair-runner service install` to keep it running in the background, then add folders in Altair > Devices.");
      return;
    }
    case "share": {
      const config = await loadConfig();
      const added = shareFolder(config, arg ?? process.cwd());
      await saveConfig(config);
      console.log(added ? `Shared ${config.folders.at(-1)!.path}` : "That folder is already shared.");
      return;
    }
    case "unshare": {
      if (!arg) throw new Error("Usage: altair-runner unshare <folder>");
      const config = await loadConfig();
      const removed = unshareFolder(config, arg);
      await saveConfig(config);
      console.log(removed ? "Stopped sharing it." : "That folder was not shared.");
      return;
    }
    case "status": {
      const config = await loadConfig();
      const [clis, pairing] = await Promise.all([detectClis(), checkPairing(config)]);
      if (values.json) {
        const { token, ...rest } = config;
        return console.log(JSON.stringify({ ...rest, paired: Boolean(token && config.server), pairing, clis }));
      }
      const pairingText = { ok: "", invalid: " (not paired any more: run altair-runner pair)", unknown: " (could not reach it)" };
      console.log(`Server:  ${config.server ? `${config.server}${pairingText[pairing]}` : "(not paired)"}`);
      console.log(`Config:  ${configPath()}`);
      console.log(`Access:  ${config.access}`);
      console.log(`Folders: ${config.folders.map((f) => `\n  ${f.path}`).join("") || "none"}`);
      console.log(`CLIs:    ${clis.map((c) => `\n  ${CLI_NAMES[c.id]} ${c.version ?? ""}`).join("") || "none found"}`);
      return;
    }
    case "start": {
      if (values.access) await saveAccess(values.access);
      const runner = await startRunner(
        values.json
          ? { log: () => {}, onStatus: (status) => console.log(JSON.stringify(status)) }
          : {},
      );
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => runner.stop());
      await runner.done;
      // A clean exit: the background service restarts the runner only after a crash.
      process.exit(0);
    }
    case "service": {
      if (arg === "install") {
        const config = await loadConfig();
        if (!config.server || !config.token) throw new Error("Pair this computer first: altair-runner pair <code> --server <url>");
        if ((await checkPairing(config)) === "invalid") {
          throw new Error(
            `${config.server} does not know this computer any more. Get a new code in Altair > Devices and run \`altair-runner pair <code> --server ${config.server}\` first.`,
          );
        }
        if (values.access) await saveAccess(values.access);
        printService(await installService(fileURLToPath(import.meta.url)), values.json);
        return;
      }
      if (arg === "uninstall") return printService(await uninstallService(), values.json);
      if (arg === "status" || !arg) return printService(await serviceStatus(), values.json);
      throw new Error("Usage: altair-runner service install|uninstall|status");
    }
    case "update": {
      // Set when an older version handed the update over to this one.
      const handedOver = process.env.ALTAIR_RUNNER_UPDATING;
      const latest = handedOver ? null : await latestVersion();
      if (!handedOver && !latest) console.log("Could not reach npm to look for a newer version.");
      if (latest && isNewer(latest, RUNNER_VERSION)) {
        console.log(`Updating altair-runner ${RUNNER_VERSION} to ${latest}…`);
        process.exitCode = await runVersion(latest, argv);
        return;
      }
      if (!handedOver && latest) console.log(`altair-runner ${RUNNER_VERSION} is the newest version.`);
      if (!(await serviceStatus().catch(() => null))?.installed) {
        console.log("The background runner is not installed, so there is nothing to restart. Install it with `altair-runner service install`.");
        return;
      }
      if (values.access) await saveAccess(values.access);
      // Replaces the background runner's copy with this version and restarts it.
      const info = await installService(fileURLToPath(import.meta.url));
      console.log(`Restarted the background runner on ${RUNNER_VERSION}.`);
      printService(info, values.json);
      return;
    }
    case "logout": {
      const config = await loadConfig();
      delete config.token;
      delete config.runnerId;
      await saveConfig(config);
      console.log("Forgot this computer's pairing. Remove it in Altair > Devices too.");
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run altair-runner --help.`);
  }
}

async function saveAccess(access: string) {
  if (!["read", "edit", "full"].includes(access)) throw new Error("--access must be read, edit or full");
  const config = await loadConfig();
  config.access = access as Access;
  await saveConfig(config);
}

function printService(info: ServiceInfo, json?: boolean) {
  if (json) return console.log(JSON.stringify(info));
  if (!info.installed) return console.log("The background runner is not installed. Install it with `altair-runner service install`.");
  const state = info.running === null ? "installed" : info.running ? "running" : "installed, not running";
  console.log(`Background runner: ${state}. It starts at every login.`);
  console.log(`Service: ${info.file}`);
  console.log(`Logs:    ${info.log}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
