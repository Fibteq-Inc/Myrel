# altair-runner

Connects your computer to an Altair server, so a project can work in one of your
local folders with the coding CLI you already use: Claude Code, Codex CLI or
Gemini CLI.

- It opens an **outbound** WebSocket to the server. No port is opened, and it works behind NAT.
- The server sends a task (a folder, a CLI and a prompt). The runner starts the CLI in that folder, streams its
  progress back and returns its final answer.
- The CLI runs with **your own login on your computer**. altair-runner never reads, sends or stores your Claude,
  OpenAI or Google credentials. The only secret it keeps is its own Altair runner token, in
  `~/.altair-runner/config.json` (readable by you only).
- It only works in folders you shared with `altair-runner share`. A path from the server that is not one of them
  (after resolving symlinks) is refused.

## Use

Requires Node 22+ and at least one of `claude`, `codex` or `gemini` on your `PATH`, already signed in.

```sh
altair-runner pair ABCD-1234 --server https://altair.example.com   # code from Altair > Devices
cd ~/code/my-project && altair-runner share                        # repeat for each folder
altair-runner start                                                # leave it running
```

Other commands: `altair-runner status`, `altair-runner unshare <folder>`, `altair-runner logout`.
Folders shared while `start` is running show up in Altair within a few seconds.

### What the CLI may do

`altair-runner start --access <level>` (saved for next time):

| level | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| `read` | `--permission-mode plan` | `--sandbox read-only` | `--approval-mode default` |
| `edit` (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--approval-mode auto_edit` |
| `full` | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--approval-mode yolo` |

With `edit`, the CLI can change files in the folder but cannot run commands that would need your approval. Use
`full` only for folders and projects you trust: it lets the CLI run any command without asking.

Tasks in the same Altair thread continue the same Claude Code session (`--resume`), so follow-ups keep context.

### For apps that run it (the desktop app)

- `ALTAIR_SERVER` and `ALTAIR_RUNNER_TOKEN` override the saved pairing, and an env token is never written to disk.
  An app that already has the user's session can pair without a code: `POST /api/runners/pairing` (as the user)
  returns a code, and `POST /api/runner/pair` trades it for the runner token.
- `ALTAIR_RUNNER_HOME` moves the config folder.
- `altair-runner start --json` prints one status object per line (`connecting`, `online`, `offline`, `task`,
  `stopped`); `altair-runner status --json` prints the config without the token.
- The build is a single JavaScript file with no native dependencies (`dist/cli.js`), so it can be packed into one
  binary with Node SEA or `bun build --compile`.

## From this repository

Until the package is published to npm, build and run it from a checkout:

```sh
pnpm install
pnpm --filter altair-runner build
node packages/altair-runner/dist/cli.js --help
```

`startRunner()` and `pair()` are exported too, for the desktop app to bundle the runner instead of shelling out to it.
