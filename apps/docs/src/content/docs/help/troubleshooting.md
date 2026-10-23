---
title: Troubleshooting
description: What to do when something doesn't work as expected.
---

### I didn't get the verification email

Check your spam folder, then choose **Send again** in the banner at the top. Until you verify, you can't accept invitations or use the cloud sandbox.

### My computer shows Offline

- Check the runner is running: `npx myrel-runner status`.
- If you started it in a terminal, it stops when you close the terminal. Install it as a background service: `npx myrel-runner service install`.
- In the desktop app, open **Devices** → **This computer** and choose **Start**.

### "No Claude Code, Codex, Antigravity CLI, OpenCode or Hermes Agent found"

The runner didn't find a supported CLI. Install one, sign in to it in a terminal, and restart the runner. See [Choose a coding CLI](/computer/clis/).

### A task on my computer stopped because it wasn't allowed to do something

CLIs other than Claude Code can't ask mid-task. Add the folder it needs under **Also allowed**, or raise **What the CLI may do on its own** in the [runner settings](/computer/runner/). With Antigravity CLI, the run's last message says which permission stopped it.

### A thread is stuck on Waiting for you

It asked something or showed a draft. Open it, answer the card or reply in the thread.

### A thread failed

Open it to read the error, then reply to try again. If it keeps failing, start a new ask with more context.

### The update didn't work

If a new runner version doesn't start, the computer goes back to the previous version and the **Devices** card says why. Choose **Try again**, or run `npx myrel-runner@latest update` on the computer.

### Still stuck?

Open an issue on [GitHub](https://github.com/Fibteq-Inc/myrel/issues). For a security problem, follow the [security policy](https://github.com/Fibteq-Inc/myrel/blob/main/SECURITY.md) instead.
