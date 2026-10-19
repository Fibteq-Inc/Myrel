#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CLI_NAMES } from "@altair/protocol";
import { detectClis } from "./clis";
import { type Access, configPath, loadConfig, saveConfig, shareFolder, unshareFolder } from "./config";
import { pair, RUNNER_VERSION, startRunner } from "./runner";

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
  altair-runner start [--access read|edit|full] [--json]
                                 Connect and run tasks until stopped (Ctrl+C)
  altair-runner logout           Forget the pairing on this computer

--access sets what the CLI may do without asking: read (look only),
edit (change files; the default) or full (also run any command).
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
      console.log(`Paired with ${config.server}. Next: \`altair-runner share\` in a project folder, then \`altair-runner start\`.`);
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
      const clis = await detectClis();
      if (values.json) {
        const { token, ...rest } = config;
        return console.log(JSON.stringify({ ...rest, paired: Boolean(token && config.server), clis }));
      }
      console.log(`Server:  ${config.server ?? "(not paired)"}`);
      console.log(`Config:  ${configPath()}`);
      console.log(`Access:  ${config.access}`);
      console.log(`Folders: ${config.folders.map((f) => `\n  ${f.path}`).join("") || "none"}`);
      console.log(`CLIs:    ${clis.map((c) => `\n  ${CLI_NAMES[c.id]} ${c.version ?? ""}`).join("") || "none found"}`);
      return;
    }
    case "start": {
      if (values.access) {
        if (!["read", "edit", "full"].includes(values.access)) throw new Error("--access must be read, edit or full");
        const config = await loadConfig();
        config.access = values.access as Access;
        await saveConfig(config);
      }
      const runner = await startRunner(
        values.json
          ? { log: () => {}, onStatus: (status) => console.log(JSON.stringify(status)) }
          : {},
      );
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => runner.stop());
      await runner.done;
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

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
