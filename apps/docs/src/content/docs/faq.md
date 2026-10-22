---
title: FAQ
description: Common questions about using Myrel.
---

### Where does an agent run, in the cloud or on my computer?

It depends on Project settings → General → **Run tasks**. Under each agent reply, **How this reply was made** shows where that reply ran. See [Using your computer](/guides/using-your-computer/).

### What does "Estimated cost" mean?

It is the model usage of that reply at list prices. The **Usage** tab shows totals by day, model, project and thread. Turns on your own computer use your CLI's login and show no cost.

### Can I use my own model key?

Yes. Add it under Settings → **Model keys** (Fireworks, Anthropic or OpenAI) and pick it in Project settings → **Model and key**. On the hosted service, projects with their own key do not count toward plan limits.

### A thread is "Waiting for you". What does it want?

It asked you a question, showed a decision card or presented a draft. Open the thread and answer or pick an option.

### Can I delete a thread?

No. A thread can be resolved or closed, and both can be reopened. Nothing is deleted.

### Why didn't I get a verification email?

Check your spam folder, then use **Send again** in the banner. Some self-hosted servers do not send email at all; then there is no verification step.

### My computer shows offline.

Make sure the runner is running (`npx myrel-runner status`) and installed as a background service. In the desktop app, check Devices → **This computer**. More in the [myrel-runner README](https://github.com/Fibteq-Inc/myrel/blob/main/packages/myrel-runner/README.md).

### Is there a mobile app?

Yes, for iOS and Android, with push notifications. Desktop apps for macOS, Windows and Linux are on the [Releases page](https://github.com/Fibteq-Inc/myrel/releases).

### I run my own server and something is broken.

See [Troubleshooting in the self-hosting guide](https://github.com/Fibteq-Inc/myrel/blob/main/docs/self-hosting.md#troubleshooting). For bugs, open an issue; for security problems, follow the [security policy](https://github.com/Fibteq-Inc/myrel/blob/main/SECURITY.md).
