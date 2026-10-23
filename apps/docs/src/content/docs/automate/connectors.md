---
title: Connectors
description: Connect services like Sentry or your database so Myrel can use them.
---

Connectors give Myrel tools from other services, through MCP servers. With a Sentry connector it can read your errors; with a Postgres connector it can query your database.

## Your connectors and project connectors

- **Settings** → **Connectors** (**Your connectors**): connectors you can use in any of your projects.
- **Project settings** → **Connectors**: connectors for one project. Your own connectors are turned on per project here.

## Add a connector

- **Ready to connect** lists services you can add in one step.
- **Browse connectors** searches the public MCP Registry.
- **Add connector** adds any MCP server by hand:
  - **Type**: a remote server (its URL) or a command
  - **Sign-in method**: OAuth or headers
  - **Where it runs**: in the cloud, on your computer, or both

A connector shows **Connected**, **Needs sign-in** (choose **Sign in**) or **Can't connect**.

## When Myrel needs one

If a task needs a service the project hasn't connected, Myrel suggests one with a **Connect a service** card. Choose **Connect** to add it, or **Not now**.
