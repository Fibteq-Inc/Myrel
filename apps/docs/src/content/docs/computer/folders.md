---
title: Folders and where tasks run
description: Decide which folders a project may use, and whether tasks run on your computer or in the cloud.
---

## The project's folders

**Project settings** → **Folders**:

- **Main folder**: where the agent works, on which computer and with which CLI.
- **Also allowed**: other folders it may open, for example a shared library next to your project. Choose **Add a folder**.

Only owners and admins can change these.

## Where tasks run

**Project settings** → **General** → **Run tasks**:

| Option | When to use it |
|---|---|
| **Automatic** | On your computer when the project has a folder and the computer is online; otherwise in the cloud |
| **Always on the computer** | The work needs your local files or tools; tasks wait until the computer is online |
| **Always in the cloud** | Nothing local is needed; tasks run in a cloud sandbox |

Under each reply, **Your computer** or **Cloud** shows where it actually ran.

## Git repositories

When the folder is a git repository, each thread works in its own copy (a git worktree) on a branch named `myrel/thr-…`. Threads running at the same time never change the same files, and your own checkout stays as you left it. You can turn this off in the [runner settings](/computer/runner/) with **Each thread in its own copy**.
