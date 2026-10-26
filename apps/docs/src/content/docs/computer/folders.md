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

Under each reply, the name of the computer or **Cloud** shows where it actually ran.

## Several computers

A project can have a folder on more than one of your computers, for example your laptop and a build server, each paired with its own `myrel-runner`.

1. Open the folder button in the project header.
2. Pick the other computer, its folder and its CLI, then choose **Add this computer**.
3. To change which one is used first, pick it and choose **Make default**. **Disconnect** takes only that computer off the project.

Which computer a thread works on:

- **Picked for the thread**: when the project is on one of your computers, the thread's message box shows **This thread works on**. A computer picked there makes the thread wait for it, even when it is offline.
- **Cloud**: **This thread works on** also offers **Cloud**. Any member of the project can pick it, and from its next turn the thread works in the cloud, whoever writes in it. It starts there without the computer's CLI session and unfinished changes, on its own branch. Myrel can also open a thread in the cloud from the start when you ask for that, and says why at the top of the thread.
- **Where it started**: after its first turn, a thread stays on that computer, because its CLI session and unfinished changes are there.
- **Otherwise the default**: a new thread goes to the project's default computer. If that one is offline, another of your computers in the project that is online and has the thread's CLI takes over.

A thread runs only on a computer that belongs to the person it works for. When another member adds their own computer to the project, their threads run there.

## Git repositories

When the folder is a git repository, each thread works in its own copy (a git worktree) on a branch named `myrel/thr-…`. Threads running at the same time never change the same files, and your own checkout stays as you left it. You can turn this off in the [runner settings](/computer/runner/) with **Each thread in its own copy**.

### Cloning and pushing

Your computer does not need a GitHub login of its own for the project's [connected repositories](/github/connect/). For each turn, Myrel lends git on your computer a short-lived token for them, the same one cloud turns use: only those repositories, only to clone and push, and never saved to disk. It is renewed during long turns and revoked when the turn ends. Their SSH addresses (`git@github.com:…`) go over HTTPS for the turn, and every other repository keeps using your own git login. It needs myrel-runner 0.21.1 or later, and only works on your own computer for repositories the person who connected them can push to.
