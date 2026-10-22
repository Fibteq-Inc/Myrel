---
title: GitHub integration
description: Connect repositories so agents open pull requests and follow them.
---

Connect a repository and agents can clone it, work on a branch and open pull requests. The thread then follows the pull request for you.

## Connect a repository

1. Project settings → **GitHub** → **Connect GitHub**.
2. Install the Myrel GitHub App on your account or organization and choose which repositories it may use.
3. Back in Myrel, use **Add repository** to add them to the project.

If the app is already installed, use **Already installed? Sign in with GitHub**. **Add an account or repositories** changes what the app can see, and **Disconnect** removes a repository from the project.

On a self-hosted server an admin has to set up a GitHub App first; until then the page says "GitHub is not set up on this server yet". The setup is in the [self-hosting guide](https://github.com/Fibteq-Inc/myrel/blob/main/docs/self-hosting.md#github-app).

## What agents do

Ask for a change in the project chat. The agent works on its own branch, pushes it and opens a pull request through the GitHub App. The thread's **Pull request** tab shows its state: Open, Draft, Merged or Closed, CI running, passed or failed, Approved, Changes requested and Has conflicts.

## What wakes the thread

The agent picks the work up again when:

- CI fails
- someone requests changes or comments
- the pull request starts to conflict with its base branch
- it is merged or closed

For failing CI, requested changes or conflicts it pushes a fix to the same branch. Review comments come from GitHub, so for anything beyond the pull request's scope the agent checks with you first.

## Agents on your computer

When a thread runs on [your computer](/guides/using-your-computer/), git commands use your own git login, and the pull request is still opened through the Myrel GitHub App.
