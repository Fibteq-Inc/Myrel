---
title: Choose a coding CLI
description: Which CLIs Myrel can use on your computer, and how to pick one for a task.
---

On your computer, tasks run through a coding CLI you already have.

| CLI | Command | Can ask you mid-task | Notes |
|---|---|---|---|
| Claude Code | `claude` | Yes | Asks before opening other folders or running commands it isn't allowed to |
| Codex CLI | `codex` | Yes | Asks before a command or file its sandbox doesn't allow (for example `git push`). Needs a Codex with `codex app-server` |
| Antigravity CLI | `agy` | No | A step that needs approval ends the run, which then says what stopped it |
| OpenCode | `opencode` | No | Doesn't run shell commands below **Full access** |
| Hermes Agent | `hermes` | No | Needs `hermes pm install --extra acp` once |
| Cursor CLI | `cursor-agent` | No | Below **Full access**, commands run in Cursor's sandbox, without network |
| Muse Code | `muse` | No | Below **Full access**, it writes only in the project's main folder |
| Kimi Code | `kimi` | No | Doesn't run shell commands below **Full access** |

Install the CLI and sign in to it before you pair the computer. CLIs that can't ask mid-task stay inside the project's folders, so add any folder they need under **Also allowed** ([Folders](/computer/folders/)).

## The project's default

When you give a project its folder, you pick its **Coding CLI**. Every task uses it unless you choose otherwise.

## Pick a CLI for one ask

The CLI button under **Give Myrel a task** shows which CLI the next ask will use.

![The CLI picker under the composer](../../../assets/screenshots/cli-picker.png)

- **Project default** uses the project's CLI.
- Tick one CLI to use it for this ask.
- Tick several and Myrel picks the one that fits the task, skipping one that is at its limit. The thread then says which one it picked and why.

## Change it for a thread

In a thread, one button under the message box sums up how it works, for example **Claude Code · Opus · High**. It opens **How this thread works**, with everything in one place:

- **Works on**: the project's default computer, another of your computers in the project, or **Cloud**.
- **CLI**: the project's default or one of the CLIs installed there.
- **Model** and **Effort**: for a CLI that lists its models. **Project default** uses the project's choice for that CLI; effort offers only the levels the model takes.

The panel stays open while you pick, so you can switch the CLI and then pick its model. Changes apply from the thread's next turn.

Only the person whose computer the thread works on can change these; others see the same button read-only. In the cloud, any member can pick the CLI and the project's model runs.

## More than one Claude Code account

If you have two Claude Code logins, for example a personal one and one from work, the computer can keep both and each thread picks one. Add the second on the computer:

```sh
npx myrel-runner claude add "Work"
npx myrel-runner claude rename default "Personal"
```

`claude add` opens Claude Code's own sign-in in a folder of its own (`~/.myrel-runner/claude/work`). The login stays in that folder: neither the runner nor Myrel reads or keeps it. `rename default` names the login you already had. `npx myrel-runner claude list` shows each account and whether it is signed in, `claude login "Work"` signs in again, and `claude remove "Work"` forgets one.

Then:

- **How this thread works** lists **Claude Code · Personal** and **Claude Code · Work** under **CLI**, each with how much of its 5-hour limit is used.
- **Project settings › Models on the computer** sets which account the project's threads use by default.
- **Devices** shows each account's limits on its own.

A thread that switches accounts starts a new Claude Code session, with the thread's history. A new account has none of your `~/.claude` settings or plugins. If an account is removed from the computer, the thread's next turn runs with Claude Code's own login and says so. Use accounts that are all yours: Claude's terms don't allow sharing a login with someone else. Needs runner 0.34.0 or newer.

## Usage limits

For Claude Code and Codex, **Devices** shows how much of the 5-hour and weekly limits you have used, for each Claude Code account on its own. The CLI picker marks a CLI **near its limit** or **at its limit**.
