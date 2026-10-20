# myrel-runner

Connects your computer to a Myrel server, so a project can work in one of your
local folders with the coding CLI you already use: Claude Code, Codex CLI or
Gemini CLI.

- It opens an **outbound** WebSocket to the server. No port is opened, and it works behind NAT.
- The server sends a task (a folder, a CLI and a prompt). The runner starts the CLI in that folder, streams its
  progress back and returns its final answer.
- The CLI runs with **your own login on your computer**. myrel-runner never reads, sends or stores your Claude,
  OpenAI or Google credentials. The only secret it keeps is its own Myrel runner token, in
  `~/.myrel-runner/config.json` (readable by you only).
- It only works in folders you shared, from Myrel > Devices or with `myrel-runner share`. A path from the server that is not one of them
  (after resolving symlinks) is refused.

## Use

Requires Node 22+ and at least one of `claude`, `codex` or `gemini` on your `PATH`, already signed in.

```sh
npx myrel-runner pair ABCD-1234 --server https://myrel.example.com   # code from Myrel > Devices
npx myrel-runner service install                                      # runs now and at every login
npx myrel-runner@latest update                                        # later: update and restart it
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

It keeps the `PATH` of the terminal you install it from, which is where it finds `claude`, `codex` and `gemini`.
On macOS and Linux it restarts after a crash, but not after a clean stop (the computer was removed in Myrel, or
`myrel-runner start` was run somewhere else with the same pairing). `myrel-runner update` installs the newest version
from npm and restarts the background runner on it (`service install` again also restarts it); `service status` shows its state and
`service uninstall` removes it. On Linux it starts when you log in; to start at boot without logging in, run
`loginctl enable-linger`.

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

`myrel-runner start --access <level>` or `myrel-runner service install --access <level>` (saved for next time):

| level | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| `read` | `--permission-mode plan` | `--sandbox read-only` | `--approval-mode default` |
| `edit` (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--approval-mode auto_edit` |
| `full` | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--approval-mode yolo` |

With `edit`, the CLI can change files in the folder but cannot run commands that would need your approval. Use
`full` only for folders and projects you trust: it lets the CLI run any command without asking.

### Project folders and asking first

A project can list other folders besides its main one (Project settings > Folders). They must be shared on this
computer too; the CLI gets them with `--add-dir` (Claude Code, Codex) or `--include-directories` (Gemini CLI).

When Claude Code runs as a thread's agent, its permission prompts go to Myrel (`--permission-prompt-tool
mcp__myrel__approve_access`). If a step reaches a file outside the project's folders, Myrel asks you in the thread
(Allow once, Add to project, Don't allow) and the step waits for your answer. A prompt about something inside the
folders is about the access level above and is declined as before. With `full`, Claude Code then runs with
`acceptEdits` and commands and web tools pre-allowed instead of `bypassPermissions`, so only files outside the folders
are asked about. Codex and Gemini CLI cannot ask mid-run, so they stay inside the folders.

Tasks in the same Myrel thread continue the same Claude Code session (`--resume`), so follow-ups keep context.

### Your CLI as the thread's agent

When a project works in one of your folders, your CLI does not just run tasks: it is the thread's agent. Each turn of
a thread is one run of the CLI (Claude Code resumes the thread's previous session), with Myrel's tools (reply, plan,
decisions, artifacts, memory, routines) added over MCP:

| CLI | How the MCP server is added |
|---|---|
| Claude Code | `--mcp-config <file>`, allowed with `--allowedTools mcp__myrel` |
| Codex CLI | `-c mcp_servers.myrel.url=…` and `-c mcp_servers.myrel.bearer_token_env_var="MYREL_MCP_TOKEN"` |
| Gemini CLI | its own settings file, through `GEMINI_CLI_SYSTEM_SETTINGS_PATH` |

The MCP endpoint is `<server>/api/agent-mcp/<thread>` and its token is valid only for that turn. Config files holding
it are readable only by you and deleted when the run ends; Codex gets it in its environment instead. The whole turn
uses your own CLI login. Needs myrel-runner 0.4.0 or later for Claude Code, 0.5.0 or later for Codex and Gemini CLI.
Projects without a local folder are worked in the cloud by OpenCode, in the thread's own sandbox.

### For apps that run it (the desktop app)

- `MYREL_SERVER` and `MYREL_RUNNER_TOKEN` override the saved pairing, and an env token is never written to disk.
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
