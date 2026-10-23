---
title: Routines
description: Run a prompt on a schedule, like a recurring ask.
---

A routine wakes Myrel on a schedule with a prompt: a morning summary, a weekly report, a check next Tuesday.

![The form for a new routine](../../../assets/screenshots/routines.png)

## Create a routine

1. In the project, choose **Routines** (the alarm clock icon at the top right).
2. Choose **New**.
3. Give it a name and write what Myrel should do each time.
4. Under **Repeat**, choose Every weekday, Every day, Every week, Every hour, Once or Custom (cron), then the day and time.
5. Under **Where it runs**, choose where each run goes:
   - **Post in the project chat**: Myrel opens a new thread each time.
   - **Continue in** a thread: each run continues that thread.
6. Check the next run shown under the form and choose **Create routine**.

## Or just ask

Write it in the chat: "every weekday at 9, summarize open threads" or "next Monday at 10, check whether the deploy finished". Myrel sets up the routine and tells you when it first runs.

## Manage routines

Each routine in the list shows when it runs next and when it last ran. **Run now** runs it right away, **Pause** and **Resume** stop and restart it, and **Delete** removes it.
