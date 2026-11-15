---
title: Visual check
description: A second agent looks at what a change does to the screen and sends back what to fix.
---

With the visual check on, work that changes what people see (a page, a component, styles, a game) is looked at by a second agent before its thread is resolved. It opens the app in a browser, takes screenshots at phone, tablet and desktop widths in light and dark, and sends what must change back to the agent that made the change.

## Turn it on

**Project settings** → **General** → **Checks** → **Visual check**, then **Save**. It is off by default. Nothing else needs setting up: the agents call the check themselves when a change affects the screen, not for backend, test or docs changes.

Each check is an extra agent run on your computer, so it uses your CLI's usage like any other task.

## What happens

1. The agent that made the change pushes its branch and asks for a check. A **Visual check** card appears in its thread.
2. Myrel opens an evaluator thread just below it in the thread list. It runs on the same computer, with another CLI than the one that made the change when the computer has one: an agent grades its own work too kindly.
3. The evaluator first runs automatic checks (blank or frozen screens, pages that scroll sideways, buttons cut off or covered, broken images, errors, accessibility problems, text that tells people how to use the screen), then looks at the screenshots itself.
4. The card shows the result, and the first agent fixes what it lists and asks for the next round.

The pull request does not wait for the check. The thread cannot be resolved while a round is running. There are two rounds per piece of work; for a third the agent asks you first.

An agent that tries to resolve a thread whose pull request changes what people see, without having asked for a check, is reminded once; when nobody sees the change it says why and resolves. For sign-in, sign-up, payment or checkout screens the reminder also asks the agent to list that flow's steps, so the evaluator walks it. When Myrel keeps working toward a goal on its own (overnight, say), a thread whose check needs fixes and that nobody accepted counts as work left, not done.

## What the work must do

The agent writes down what the work must do before it starts (its acceptance criteria) and hands them to the check. The evaluator checks each one: what shows on a screen by its screenshot, and what needs doing (signing in, adding something, paying, a form) by walking it in the browser step by step. The card lists every criterion as met or not met, and a check with one not met does not pass. The evaluator also reads the change itself, so screens the agent did not name are not missed.

## Screens that explain themselves

Agents tend to write how-to text onto the screen ("Click the + button in the top right to add a task", "Bu sayfada tüm projelerinizi görebilirsiniz") instead of designing a screen that shows the way. The check looks for such text and for help boxes that never go away, and the evaluator counts them against the work: when a screen leans on the text, it must change, and the finding says what design replaces it (an obvious main button, an empty state with one action, labels on icons, a hint at the moment it is needed). Help and docs pages, legal text and error messages that say how to recover are fine.

## The card

| Shows | What it means |
|---|---|
| **Passed** | Nothing must change |
| **Needs fixes** | The **Must fix** list says what, numbered |
| **Look not judged** | Only the automatic checks ran: the model did not prove it could see the screenshots |
| **Could not check** | The check did not run; the card says why |

Each finding in **Must fix** is framed and numbered in red on its screenshot; with findings on several screens, pick a screen above the picture. **Full result** and the contact sheets (every width and theme of a screen side by side) open in the project's files.

- **Accept anyway**: the findings need no fixing. The agent carries on without another round for them.
- **Approve as reference**: this round's screenshots become the approved look. Later checks compare against them, show what changed (**Changed: …**), and judge only the changed and new screens.

## Choose who judges

By default Myrel picks another CLI than the one that made the change, and one that is not at its usage limit. To choose yourself, tick the CLIs that may judge, each with its model and effort:

- for one project: **Project settings** → **General** → **Checks**, under the switch once it is on
- for all your projects that tick none: **Settings** → **Visual check evaluator**

For one check only, say so in the thread ("check it with Codex"). A CLI, model or effort the computer does not have is skipped, and the agent is told.

## What it can check

- Websites and web apps (Next, Nuxt, Astro, Remix, Angular, Vite and others, or plain HTML), found in the repository without any setup.
- Web games, with their animation checked frame by frame.
- Electron apps, opened as the desktop app at two window sizes.
- Expo and React Native apps through their web build, and Tauri apps through their pages in the browser.

Native iOS and Android screens and games outside a web build are not checked yet; the card says so.

## Needs a browser

The check runs Chromium on your computer. Myrel downloads it the first time. On Linux it may also need system libraries; then **Devices** and the check's card show the command to run once (it asks for your password):

```sh
sudo npx playwright@1.64.1 install-deps chromium
```

A round that could not start for this does not count toward the two.

Work done in the cloud is checked in the cloud: the sandbox has the browser. Whether the evaluator there also judges the look depends on the server's model for checks; when that model cannot read images, the automatic checks and flows still run and the card says **Look not judged**.
