// Takes the screenshots in src/assets/screenshots from a local Myrel filled with made-up data,
// so they never show a real project. The coordinator's model is a scripted fake (an
// OpenAI-compatible server on FAKE_MODEL_PORT) and the thread agent is a fake computer that
// answers each turn through Myrel's tools, the way myrel-runner and a CLI would.
//
// 1. In apps/api/.dev.vars point the model at the fake (see apps/docs/README.md), then run a
//    fresh local stack: `pnpm db:migrate:local` and `pnpm dev` from the repository root.
// 2. pnpm --filter @myrel/docs screenshots
//
// Each run signs up a new made-up user, so the local database can be reused.

import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const WEB = process.env.MYREL_WEB ?? "http://localhost:5173";
const FAKE_MODEL_PORT = Number(process.env.FAKE_MODEL_PORT ?? 9911);
const OUT = process.env.SCREENSHOTS_OUT ?? fileURLToPath(new URL("../src/assets/screenshots/", import.meta.url));
// The guide's pictures are dark; MYREL_THEME=light shoots the same screens in the light theme.
const THEME = process.env.MYREL_THEME === "light" ? "light" : "dark";
// The runner protocol version, read from its source so the fake computer stays in step.
const protocolSource = await readFile(new URL("../../../packages/protocol/src/runner.ts", import.meta.url), "utf8");
const PROTOCOL = Number(/RUNNER_PROTOCOL_VERSION = (\d+)/.exec(protocolSource)[1]);
const FOLDER = "/Users/ada/code/acme-web";

/** What the people in the screenshots ask for, and how the thread agent plays each one. */
const ASKS = [
  {
    ask: "Draft release notes for v2.3 from the merged pull requests",
    title: "Release notes v2.3",
    ack: "Drafting the v2.3 release notes.",
    projectAck: "On it, drafting the release notes.",
    async play(call) {
      await call("reply", { text: "I'll collect the merged pull requests since v2.2 and group them into notes." });
      const steps = ["Collect merged pull requests", "Group changes by area", "Write the notes"];
      await call("update_plan", { title: "Release notes v2.3", steps: steps.map((text) => ({ text, state: "done" })) });
      await call("reply", {
        text: "The draft is ready in **notes/v2.3.md**: 4 features, 7 fixes and one breaking change (the `/v1/export` endpoint is gone). Shall I post it to the release?",
        needs: "review",
      });
    },
  },
  {
    ask: "The signup page feels slow on mobile. Find out why and suggest fixes",
    title: "Slow signup page",
    ack: "Looking into why the signup page is slow on mobile.",
    projectAck: "Got it, I'm on the slow signup page.",
    async play(call) {
      await call("reply", { text: "I'll profile the signup page on a throttled mobile connection, find what blocks it and suggest fixes." });
      const steps = [
        ["Profile the page on a slow 4G phone", "done"],
        ["Find what blocks the first render", "done"],
        ["Pick a fix with you", "active"],
        ["Open a pull request", "todo"],
      ];
      await call("update_plan", { title: "Slow signup page", steps: steps.map(([text, state]) => ({ text, state })) });
      await call("reply", {
        text: "Most of the delay is the 1.2 MB country picker bundle, loaded before the form renders. The hero image is also served at full size to phones.\n\nLazy-loading the picker cuts first render from 4.1 s to 1.6 s on slow 4G.",
      });
      await call("ask_decision", {
        question: "How should I fix the country picker?",
        options: [
          { label: "Lazy-load it", consequence: "Loads only when the field is focused; smallest change, 2.5 s faster." },
          { label: "Native select", consequence: "Drops the library entirely; fastest, but loses search and flags." },
          { label: "Leave it", consequence: "Only resize the hero image; about 0.4 s faster." },
        ],
        recommended: 0,
      });
    },
  },
];

// The coordinator's model: opens a thread for each new ask, then stops.
const fakeModel = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages = [] } = JSON.parse(body || "{}");
    const prompt = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const id = /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];
    // Only the message marked NEW is the ask to route; earlier ones are in the prompt too.
    const latest = prompt.slice(prompt.lastIndexOf("· NEW"));
    const ask = ASKS.find((a) => latest.includes(a.ask));
    const done = messages.some((m) => m.role === "tool");
    const toolCalls =
      !done && id && ask
        ? [{
            id: `call_${Date.now()}`,
            type: "function",
            function: {
              name: "start_thread",
              arguments: JSON.stringify({ message_id: id, title: ask.title, instructions: ask.ask, ack: ask.ack, project_ack: ask.projectAck }),
            },
          }]
        : undefined;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "", tool_calls: toolCalls } }],
      usage: { prompt_tokens: 5200, completion_tokens: 180 },
    }));
  });
});
await new Promise((r) => fakeModel.listen(FAKE_MODEL_PORT, r));

const until = async (fn, what, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// Playwright's own Chromium when installed (`npx playwright install chromium`), else the installed Chrome.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2, colorScheme: THEME });
const page = await context.newPage();
const api = async (path, init = {}) => {
  const res = await context.request.fetch(`${WEB}${path}`, {
    method: init.method ?? "GET",
    headers: { origin: WEB, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    data: init.body,
  });
  if (!res.ok()) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
};
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}${name}.png`, ...opts });
  console.log(`saved ${name}.png`);
};

await mkdir(OUT, { recursive: true });

// A made-up person, signed in through the browser context's cookies.
const email = `ada+${Date.now()}@example.com`;
await api("/api/auth/sign-up/email", {
  method: "POST",
  body: { name: "Ada Lovelace", email, password: "correct-horse-battery-staple" },
});

// Mark the address verified in the local database, so the "Verify your email" banner stays out of the pictures.
execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "myrel", "--local", "--command", `UPDATE user SET email_verified = 1 WHERE email = '${email}'`], {
  cwd: fileURLToPath(new URL("../../api/", import.meta.url)),
  stdio: "ignore",
});

// A fake computer: paired like `myrel-runner pair`, then playing the thread agent.
const { code } = await api("/api/runners/pairing", { method: "POST" });
const paired = await api("/api/runner/pair", {
  method: "POST",
  body: { code, name: "Ada's MacBook", hostname: "adas-macbook", platform: "darwin" },
});
const ws = new WebSocket(`${WEB.replace(/^http/, "ws")}/api/runner/connect`, { headers: { authorization: `Bearer ${paired.token}` } });
const send = (frame) => ws.send(JSON.stringify(frame));
let welcomed = false;
const threadIds = new Map();
ws.addEventListener("message", async (e) => {
  const frame = JSON.parse(e.data);
  if (frame.type === "welcome") welcomed = true;
  if (frame.type !== "task.start" || !frame.agent) return;
  let rpc = 0;
  const call = async (name, args) => {
    const res = await fetch(`${WEB}${frame.agent.mcpPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${frame.agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const out = await res.json();
    if (out.result?.isError) throw new Error(`${name}: ${out.result.content[0].text}`);
  };
  const ask = ASKS.find((a) => frame.prompt.includes(a.ask));
  if (ask) threadIds.set(ask.title, frame.threadId);
  try {
    if (ask) await ask.play(call);
    send({ type: "task.done", taskId: frame.taskId, ok: true, result: "" });
  } catch (err) {
    send({ type: "task.done", taskId: frame.taskId, ok: false, result: String(err) });
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
send({
  type: "hello",
  protocol: PROTOCOL,
  version: "0.12.0",
  hostname: "adas-macbook",
  platform: "darwin",
  folders: [{ path: FOLDER, name: "acme-web" }],
  clis: [{ id: "claude", version: "2.1.0" }],
  features: ["folders", "cancel", "agent"],
  running: [],
});
await until(() => welcomed, "the runner's welcome");

const { project } = await api("/api/projects", { method: "POST", body: { name: "Acme website" } });
await until(async () => {
  try {
    await api(`/api/projects/${project.id}/workspace`, { method: "PUT", body: { runnerId: paired.runner.id, path: FOLDER, cli: "claude" } });
    return true;
  } catch {
    return false;
  }
}, "the project's folder");

// The project chat: each ask opens a thread, worked by the fake computer.
await page.goto(`${WEB}/projects/${project.id}`);
const composer = page.getByPlaceholder("Give Myrel a task");
for (const a of ASKS) {
  await composer.fill(a.ask);
  await composer.press("Enter");
  await page.getByText(a.projectAck).first().waitFor({ timeout: 30_000 });
}
await page.getByText("How should I fix the country picker?").first().waitFor({ timeout: 30_000 }).catch(() => {});
await page.reload();
await page.waitForLoadState("networkidle");
await shot("project-chat");

// The thread with its plan and decision card.
await page.goto(`${WEB}/projects/${project.id}/threads/${threadIds.get("Slow signup page")}`);
await page.getByText("How should I fix the country picker?").first().waitFor({ timeout: 30_000 });
await shot("thread");

await page.goto(`${WEB}/`);
await page.waitForLoadState("networkidle");
await shot("projects");

await page.goto(`${WEB}/devices`);
await page.waitForLoadState("networkidle");
await shot("devices");

await page.goto(`${WEB}/settings/projects/${project.id}`);
await page.waitForLoadState("networkidle");
await shot("project-settings");

ws.close();
await browser.close();
fakeModel.close();
