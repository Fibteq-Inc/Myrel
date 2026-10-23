---
title: Pull requests and CI
description: How Myrel opens pull requests and follows them for you.
---

Ask for a change in the project chat, for example "add a dark mode toggle to the settings page and open a pull request". Myrel works on its own branch, pushes it and opens a pull request.

## Follow the pull request

The thread's **Pull request** tab shows:

- its state: Open, Draft, Merged or Closed
- checks: CI running, CI passed or CI failed
- reviews: Approved or Changes requested
- **Has conflicts** when it no longer merges cleanly

## What wakes the thread

The thread picks the work up again by itself when:

| On GitHub | What Myrel does |
|---|---|
| CI fails | Fixes it and pushes to the same branch |
| Someone requests changes | Makes the changes and pushes |
| Someone comments or asks a question | Answers in the thread |
| The pull request conflicts with its base branch | Brings the base branch in and resolves the conflicts |
| It is merged or closed | Says so and finishes the thread |

Review comments come from GitHub, not from you, so for anything beyond the pull request's scope Myrel checks with you first.

## Tasks on your computer

When the thread runs on [your computer](/computer/connect/), git uses your own login and the pull request is still opened through the Myrel app.
