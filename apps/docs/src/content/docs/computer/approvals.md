---
title: Approve access
description: Answer when a task on your computer needs more than it is allowed.
---

Tasks on your computer stay inside the project's folders and follow the access level you set for the runner. When Claude Code needs more, it asks you in the thread with a card. Other CLIs can't ask mid-task; see [Choose a coding CLI](/computer/clis/).

## A folder outside the project

| Button | What happens |
|---|---|
| **Allow once** | The task may use the folder until it finishes this turn |
| **Add to project** | The folder joins the project's folders; tasks use it without asking |
| **Don't allow** | The task goes on without it |

## A command it may not run on its own

| Button | What happens |
|---|---|
| **Run it** | Runs this command and asks again for the next one |
| **Allow commands this turn** | Runs commands in the project's folders without asking until the turn ends |
| **Don't run** | Skips it; the task carries on without it |

## Set how much it may do on its own

**Devices** → your computer → **Settings** → **What the CLI may do on its own**. See [Update and configure the runner](/computer/runner/).
