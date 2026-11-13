---
title: Issues
description: How Myrel reads the issues of a connected repository and opens new ones for you.
---

Ask in the project chat or a thread, for example "open an issue for each of these". Myrel opens them on a connected repository through the Myrel app, so nobody needs a GitHub sign-in on the computer doing the work.

Each issue starts with who asked for it and a link back to the thread, and it is assigned to you when you connected your GitHub account. Only labels the repository already has are applied.

## Reading issues in Myrel

The project's **Issues** tab lists the issues of its connected repositories, live from GitHub. Open one to read its description and comments right there, on the web, the desktop app and your phone, or use **Open on GitHub** to go to GitHub in a new tab.

Reading an issue here tells no agent anything. An image in an issue shows as a link, so its host cannot see who read it, and text GitHub hides from readers, such as an HTML comment, is shown. **Work on it** puts a request naming the issue in the composer for you to send.

## Changing issues

Ask in the thread, for example "comment on #12 with what we found" or "close #12, the pull request fixed it". Myrel can comment on an issue, change its title, description, labels and assignees, close it or reopen it. It can also link an open pull request to an issue by adding "Closes #12" to the pull request's description, so merging it into the default branch closes the issue.

## When Myrel asks first

Everyone who can see the repository can read an issue, and Myrel cannot delete one. When you ask for these changes, Myrel makes them right away. A card shows you the exact text first when:

- the thread read text from outside the project, such as a stranger's issue or a connector's answer
- the turn works for nobody, because no member of the project asked for it
- the thread would go past 30 of these changes
- the change touches what someone without access to the repository wrote: their issue, or their pull request's description. A comment does not count

Only the person the thread works for, or the project's owner or an admin, can answer the card.

Myrel refuses text that contains what looks like a token or a private key, and text with an @mention, which would notify that person on GitHub.

## What Myrel cannot do yet

Myrel does not delete issues, lock them or comment on pull requests.
