# myrel-runner

Connects your computer to a Myrel server, so a project can work in one of your
local folders with the coding CLI you already use: Claude Code, Codex CLI,
Antigravity CLI, OpenCode, Hermes Agent, Cursor CLI or Muse Code.

- It opens an **outbound** WebSocket to the server. No port is opened, and it works behind NAT.
- The server sends a task (a folder, a CLI and a prompt). The runner starts the CLI in that folder, streams its
  progress back and returns its final answer.
- The CLI runs with **your own login on your computer**. myrel-runner never reads, sends or stores your Claude,
  OpenAI or Google credentials. The only secret it keeps is its own Myrel runner token, in
  `~/.myrel-runner/config.json` (readable by you only).
- It only works in folders you shared, from Myrel > Devices or with `myrel-runner share`. A path from the server that is not one of them
  (after resolving symlinks) is refused.

## Use

Requires Node 22+ and at least one of `claude`, `codex`, `agy` (Antigravity CLI), `opencode`, `hermes` (Hermes Agent), `cursor-agent` (Cursor CLI) or `muse` (Muse Code) on your `PATH`, already signed in.

```sh
npx myrel-runner pair ABCD-1234 --server https://myrel.example.com   # code from Myrel > Devices
npx myrel-runner service install                                      # runs now and at every login
npx myrel-runner@latest update                                        # later: update and restart it (waits for running tasks)
```

Then add folders in Myrel > Devices with **Add folder**: it browses this computer's folders through the runner
(folder names only, never files) and shares the one you pick. The home folder itself and the disk root cannot be
shared. From a terminal, `myrel-runner share [folder]` and `myrel-runner unshare <folder>` do the same.

Other commands: `myrel-runner status`, `myrel-runner logout`, and `myrel-runner start` to run it in a terminal
instead of in the background (Ctrl+C stops it).

### In the background

`myrel-runner service install` copies the runner to `~/.myrel-runner/bin` (so it keeps working after npx clears its
cache) and registers it to start at login:

| OS | How | Logs |
|---|---|---|
| macOS | launchd agent `~/Library/LaunchAgents/io.fibteq.myrel-runner.plist` | `~/.myrel-runner/runner.log` |
| Linux | systemd user service `myrel-runner.service` | `journalctl --user -u myrel-runner` |
| Windows | `myrel-runner.vbs` in the Startup folder | `~/.myrel-runner/runner.log` |

It keeps the `PATH` of the terminal you install it from, which is where it finds `claude`, `codex` and `agy`.
On macOS and Linux it restarts after a crash, but not after a clean stop (the computer was removed in Myrel, or
`myrel-runner start` was run somewhere else with the same pairing). `myrel-runner update` installs the newest version
from npm and restarts the background runner on it once its running tasks finish (at most 10 minutes; `--now` restarts
right away). `service install` again also restarts it; `service status` shows its state and `service uninstall`
removes it. On Linux it starts when you log in; to start at boot without logging in, run `loginctl enable-linger`.

### Updating and settings from Myrel

From runner 0.14.0 the background runner can be updated and set up from **Myrel > Devices**, without a terminal:

- **Update** shows when npm has a newer version. The runner waits for its running tasks (at most 10 minutes; **Update
  now** stops them, and Myrel continues them), downloads the package from npm, checks it against npm's integrity
  hash, runs the new copy once (`--version`) and only then puts it in place of `~/.myrel-runner/bin/myrel-runner.mjs`,
  keeping the old one as `myrel-runner.prev.mjs`. It then exits with code 75, so launchd or systemd starts the new
  copy (on Windows it starts the Startup entry itself). If the new version is refused by the server, or does not
  connect within 2 minutes while the server is reachable, it puts the previous copy back and restarts on it; the card
  says so. The state across the restart is in `~/.myrel-runner/update.json`.
- **Settings**: the access level, worktrees and **Update by itself** (auto-update: looks for a newer version every
  6 hours and installs it when no task is running). They are saved in `config.json` on the computer.
  `myrel-runner settings` shows and changes the same ones here, and `myrel-runner settings remote off` stops Myrel from
  changing them (only this computer can turn it back on).

A runner started with `myrel-runner start` in a terminal cannot restart itself, so the card shows the command
instead; the desktop app's runner updates with the app. Runners before 0.14.0 need `npx myrel-runner@latest update`
once.

If the runner shuts down while a task is running (an update or a restart of the service), it notes the task in
`~/.myrel-runner/interrupted.json` and tells the server when it reconnects. From runner 0.12.0, Myrel then continues
that turn on its own a few times, with growing waits, and says so in the thread instead of reporting a failure.

### Threads working at the same time

When a shared folder is a git repository, each thread works in its own
[git worktree](https://git-scm.com/docs/git-worktree) on its own branch, `myrel/thr-…`, made from the repository's
current commit on the thread's first task. Two threads can then work in the same project at once without changing
each other's files or switching each other's branch, and your own checkout is left alone. Each task's result says
which branch and folder the work is in; merge or open a PR from that branch as usual.

Worktrees live in `~/.myrel-runner/worktrees`. They start without your uncommitted changes and without ignored files
such as `node_modules` or `.env`, so a task may need to install dependencies first. A worktree that has not been used
for a day, has no uncommitted changes and whose branch is merged into your checkout's branch is removed
automatically, with its branch. `myrel-runner worktrees` lists them, `worktrees prune` cleans up now,
`worktrees remove <path or branch>` removes one, and `worktrees off` makes threads work in the folder itself again.
Read-only tasks (`--access read`) always run in the folder itself.

### What the CLI may do

`myrel-runner start --access <level>`, or for the background runner `myrel-runner service install --access <level>` or
`myrel-runner update --access <level>` (both restart it). The level is saved for next time:

| level | Claude Code | Codex | Antigravity CLI | OpenCode | Cursor CLI | Muse Code |
|---|---|---|---|---|---|---|
| `read` | `--permission-mode plan` | `--sandbox read-only` | `--mode plan` | edit and bash denied | `--mode ask` | `--approval-mode never --disable-write --disable-shell` |
| `edit` (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` | edit allowed, bash denied | `--sandbox enabled` | `--approval-mode never --trust-workspace` |
| `auto` | `--permission-mode auto` | `--sandbox workspace-write` | `--mode accept-edits` | edit allowed, bash denied | `--sandbox enabled` | `--approval-mode never --trust-workspace` |
| `full` | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--dangerously-skip-permissions` | edit and bash allowed, `--auto` | `--force --sandbox disabled` | `--yolo` |

With `auto`, Claude Code's auto mode decides which steps are safe to run (tests, git commit, builds) and runs them;
the ones it would ask about come to you as a card in the thread. Your Claude account must have auto mode; Codex and
Antigravity CLI cannot ask mid-run, so for them `auto` is the same as `edit` (Antigravity's own auto mode needs its
terminal sandbox and is missing on business accounts).

Antigravity CLI is stricter than Codex below `full`: there is no sandbox where its commands run on their own. A
command, a web page or a file outside the folders needs approval, which it cannot ask for when Myrel runs it, and
being declined ends the whole run with no answer. So with `read`, `edit` and `auto` it is told to keep to the files
and Myrel's tools, and a run that still stops says which permission stopped it. Give it `full` to let it run
commands, or allow single ones under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` (e.g.
`command(git)`).

OpenCode has no sandbox for commands either, so below `full` its bash tool is denied: OpenCode then does not
offer it at all, and the run goes on with files and Myrel's tools. Anything else that would ask (for example a
permission you set to `ask` yourself) is declined and the run goes on too
(`experimental.continue_loop_on_deny`). With `full`, `--auto` approves what would ask, but rules you set to `deny`
still hold.

Hermes Agent runs as an ACP server (`hermes acp`), whose session takes an edit mode: `default` (asks before
edits) with `read`, `accept_edits` with `edit` and `auto`, `dont_ask` with `full`. What it asks permission for
(dangerous commands, sensitive files, edits with `read`) is declined below `full` and allowed with `full`. Its
terminal cannot be switched off for one run (toolsets come from its global config), so below `full` it is told not
to run commands that change anything; this is an instruction, not a sandbox.

Cursor CLI (`cursor-agent -p`) is closest to Codex. With `edit` and `auto`, its sandbox keeps edits and commands in
the workspace and gives commands no network; what would need approval (a file outside, a command it cannot sandbox)
is declined and the run goes on. `--force` would also take commands out of the sandbox, so only `full` uses it. With
`read` it runs in ask mode, which reads and answers but changes nothing (plan mode would leave out Myrel's tools).

Muse Code (`muse exec --json`) is close to Codex too. With approval mode `never` nothing waits for an answer: with
`edit` and `auto` its sandbox keeps writes in the workspace (and `/tmp`), a write outside fails and the run goes on,
and commands reach the network through its proxy. `--trust-workspace` loads the folder's own rules and skills for
that run only. With `read` its write and shell tools are taken away (its `:read-only` profile would wait forever on
a command's approval). `full` is `--yolo`: no approval, no sandbox. Muse Code has no `--add-dir`, so below `full` it
writes only in the project's main folder.

With `edit`, the CLI can change files in the folder but cannot run commands that would need your approval. Use
`full` only for folders and projects you trust: it lets the CLI run any command without asking.

### Project folders and asking first

A project can list other folders besides its main one (Project settings > Folders). They must be shared on this
computer too; the CLI gets them with `--add-dir`.

When Claude Code runs as a thread's agent, its permission prompts go to Myrel (`--permission-prompt-tool
mcp__myrel__approve_access`). If a step reaches a file outside the project's folders, Myrel asks you in the thread
(Allow once, Add to project, Don't allow) and the step waits for your answer. A command or web request the access
level does not allow on its own (with `edit`: `git commit`, `git push`, tests) is asked about the same way (Run it,
Allow commands this turn, Don't run), so there is no need to restart the runner with `--access full` for one task. A
file change inside the folders with `read` is declined as before. With `full`, Claude Code then runs with
`acceptEdits` and commands and web tools pre-allowed instead of `bypassPermissions`, so only files outside the folders
are asked about. Codex, Antigravity CLI, OpenCode, Hermes Agent, Cursor CLI and Muse Code cannot ask mid-run, so they stay inside the folders (OpenCode gets them as
`external_directory` allow rules).

Tasks in the same Myrel thread continue the same Claude Code session (`--resume`), so follow-ups keep context.

### Your CLI as the thread's agent

When a project works in one of your folders, your CLI does not just run tasks: it is the thread's agent. Each turn of
a thread is one run of the CLI (Claude Code resumes the thread's previous session), with Myrel's tools (reply, plan,
decisions, artifacts, memory, routines) added over MCP:

| CLI | How the MCP server is added |
|---|---|
| Claude Code | `--mcp-config <file>`, allowed with `--allowedTools mcp__myrel` |
| Codex CLI | `-c mcp_servers.myrel.url=…` and `-c mcp_servers.myrel.bearer_token_env_var="MYREL_MCP_TOKEN"` |
| Antigravity CLI | `myrel-runner mcp-bridge` in `~/.gemini/config/mcp_config.json`, allowed with `mcp(myrel/*)` in `~/.gemini/antigravity-cli/settings.json` |
| OpenCode | `mcp.myrel` (remote, `Authorization: Bearer {env:MYREL_MCP_TOKEN}`) in `OPENCODE_CONFIG_CONTENT`, allowed with `myrel_*` |
| Hermes Agent | `mcpServers` of ACP's `session/new` (or `session/resume`), the token in its `Authorization` header |
| Cursor CLI | `mcp.json` of a plugin folder of the run (`--plugin-dir`, `--approve-mcps`), allowed with `Mcp(plugin-myrel-myrel:*)` in a `cli-config.json` of the run (`CURSOR_CONFIG_DIR`) |
| Muse Code | `-c 'mcpServers.myrel={"url":…,"headers":{"Authorization":"${MYREL_MCP_AUTH}"}}'`, run with `--approval-mode never` |

The MCP endpoint is `<server>/api/agent-mcp/<thread>` and its token is valid only for that turn. Config files holding
it are readable only by you and deleted when the run ends; Codex gets it in its environment instead. The whole turn
uses your own CLI login. Needs myrel-runner 0.4.0 or later for Claude Code, 0.5.0 or later for Codex, 0.13.0 or later
for Antigravity CLI, 0.15.0 or later for OpenCode, 0.16.0 or later for Hermes Agent, 0.17.0 or later for Cursor CLI, 0.19.0 or later for Muse Code.

Antigravity CLI takes MCP servers only from its global config, never for one run. So the runner adds one fixed
server there, the bridge, and an allow rule for its tools; the rest of both files stays as it is. Each run hands the
bridge its thread's endpoint, token and connectors in a private file (`MYREL_MCP_BRIDGE`), deleted after the run, so
the global config never holds a token. When you start `agy` yourself, the bridge has no run and offers no tools.
Connectors' tools show up there as `<connector>__<tool>`. Sign in to `agy` once yourself; runs reuse that login.
OpenCode takes a whole config for one run in `OPENCODE_CONFIG_CONTENT`, so nothing is written to your
`~/.config/opencode`: the run's servers, connectors, permission rules and skills folder (`skills.paths`) go there,
merged over your own config, and the token stays in `MYREL_MCP_TOKEN`. Your model and provider logins are your own.
opencode 2 runs `opencode run` through its background service, which would ignore that config, so the runner adds
`--standalone` when `opencode --version` says 2 or later. Connectors' tools show up as `<connector>_<tool>`.

Hermes Agent's `hermes chat` runs every turn in a shared background gateway that takes MCP servers only from
`~/.hermes/config.yaml`, so the runner uses its ACP server instead (`hermes acp`, which needs
`hermes pm install --extra acp` once). Each run is one ACP session: initialize, `session/new` or `session/resume`
(the thread's previous session) with the run's MCP servers, `session/set_mode`, then `session/prompt`; the runner
ends the connection when the prompt is answered. The token travels only over that pipe. Hermes shows the run's
servers to the model behind its `tool_search`, as `mcp__editor_<server>_<id>__<tool>`. Detection checks that
`hermes --version` says Hermes Agent (another `hermes` is the React Native JavaScript engine).

Cursor CLI takes MCP servers only from `mcp.json` files (`~/.cursor/mcp.json`, the project's `.cursor/mcp.json`) and
from plugins. So each run gets a plugin folder named `myrel` (`--plugin-dir`) whose `mcp.json` holds Myrel's server
and the connectors; Cursor names them `plugin-myrel-<server>`. Headless, a tool that would ask is declined, so the run
also gets its own config folder (`CURSOR_CONFIG_DIR`): your `cli-config.json` (model, rules) with allow rules for
those servers added, and a link to your chats folder so the thread's next turn resumes the chat (`--resume`). Nothing
is written to your `~/.cursor`; both folders and the token in them are deleted after the run. The skills' folder
gets a `.cursor-plugin` manifest and goes in as a second plugin. The runner looks for `cursor-agent` rather than
`agent`, the other name Cursor's installer links. Sign in once with `cursor-agent login`. Your own servers in
`~/.cursor/mcp.json` load too, approved like the run's (`--approve-mcps` cannot pick).

Muse Code takes one `-c mcpServers.<name>=<json>` per server for a run (it refuses the whole map at once, and an HTTP
server with a `type`), so nothing is written to your `~/.config/muse/settings.json`. A secret goes in `-c` only as a
whole `${VAR}`, so the token's `Authorization` header and connectors' environment values stay in the run's
environment. `muse exec` does not read stdin: the prompt goes in a file only you can read (`--prompt-file`), deleted
after the run. The thread's next turn continues the session with `--session-id`. Muse Code has no command that lists
its models, so the runner reads the catalog it keeps in `~/.local/share/muse/model-catalog` (visible models and their
effort tiers); a picked model and effort go in as `--model` and `--effort`, otherwise your settings decide. Your own
MCP servers come from your settings too. Skills: the prompt names the run's skills folder, where Muse Code reads them.
Detection checks that `muse --version` says Muse Code. Sign in once with `muse login`.

Projects without a local folder are worked in the cloud by OpenCode, in the thread's own sandbox.

### For apps that run it (the desktop app)

- `MYREL_SERVER` and `MYREL_RUNNER_TOKEN` override the saved pairing, and an env token is never written to disk.
  From runner 0.12.1 the token is also removed from the environment of every CLI and command the runner starts.
  An app that already has the user's session can pair without a code: `POST /api/runners/pairing` (as the user)
  returns a code, and `POST /api/runner/pair` trades it for the runner token.
- `MYREL_RUNNER_HOME` moves the config folder.
- `myrel-runner start --json` prints one status object per line (`connecting`, `online`, `offline`, `task`,
  `stopped`); `myrel-runner status --json` prints the config without the token.
- The build is a single JavaScript file with no native dependencies (`dist/cli.js`), so it can be packed into one
  binary with Node SEA or `bun build --compile`.

## Packages

The CLI is published as [`@fibteq/myrel-runner`](https://www.npmjs.com/package/@fibteq/myrel-runner).
[`myrel-runner`](https://www.npmjs.com/package/myrel-runner) (in `packages/myrel-runner-alias`) is a short name that
depends on it, so `npx myrel-runner` works. `npx @fibteq/myrel-runner` runs the same CLI.

`startRunner()` and `pair()` are exported too, for the desktop app to bundle the runner instead of shelling out to it.

## From this repository

```sh
pnpm install
pnpm --filter @fibteq/myrel-runner build
node packages/myrel-runner/dist/cli.js --help
```

## Releasing

1. Bump `version` in `package.json` here and in `packages/myrel-runner-alias/package.json`, and `RUNNER_VERSION`
   in `src/runner.ts` (a test checks they match). Bump `RUNNER_PROTOCOL_VERSION` in `@myrel/protocol` only when the
   wire format changes; the server refuses runners on another protocol version and tells them to update.
2. Merge it. The [Release myrel-runner](../../.github/workflows/release-runner.yml) workflow then tests, builds and
   publishes both packages whose version is not on npm yet (it can also be run by hand from the Actions tab).
   It uses npm trusted publishing: once, on npmjs.com, open each package's **Settings > Trusted publishing**, choose
   GitHub Actions and enter `Fibteq-Inc`, `myrel` and `release-runner.yml`.

By hand instead (needs an npm account in the `fibteq` npm organization), runner first, then the short name, with
`pnpm` (it replaces `workspace:` versions and uses the built files from `publishConfig`):

```sh
npm login
pnpm --filter @fibteq/myrel-runner publish --access public
pnpm --filter myrel-runner publish --access public
```

`prepublishOnly` builds and tests the runner before it is published. Check the contents first with
`pnpm --filter @fibteq/myrel-runner pack` if in doubt.
