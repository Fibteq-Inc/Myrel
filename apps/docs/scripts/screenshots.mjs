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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const WEB = process.env.MYREL_WEB ?? "http://localhost:5173";
const FAKE_MODEL_PORT = Number(process.env.FAKE_MODEL_PORT ?? 9911);
const WALK = fileURLToPath(new URL("../src/assets/walkthroughs/", import.meta.url));
const OUT = process.env.SCREENSHOTS_OUT ?? fileURLToPath(new URL("../src/assets/screenshots/", import.meta.url));
// The guide's pictures are dark; MYREL_THEME=light shoots the same screens in the light theme.
const THEME = process.env.MYREL_THEME === "light" ? "light" : "dark";
// The runner protocol version, read from its source so the fake computer stays in step.
const protocolSource = await readFile(new URL("../../../packages/protocol/src/runner.ts", import.meta.url), "utf8");
const PROTOCOL = Number(/RUNNER_PROTOCOL_VERSION = (\d+)/.exec(protocolSource)[1]);
const FOLDER = "/Users/ada/code/acme-web";
// The fake computer claims the current myrel-runner, so Devices shows no update banner.
const RUNNER_VERSION = JSON.parse(await readFile(new URL("../../../packages/myrel-runner/package.json", import.meta.url), "utf8")).version;

const RELEASE_NOTES_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acme v2.3</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1d1d24}
h1{font-size:28px;margin:0 0 4px}p.meta{color:#666;margin:0 0 28px}h2{font-size:17px;margin:28px 0 8px}li{margin:4px 0}
.tag{font-size:12px;background:#ece9ff;color:#4f45e0;border-radius:4px;padding:1px 6px;margin-right:6px}</style></head><body>
<h1>Acme v2.3</h1><p class="meta">Draft release notes, 18 pull requests</p>
<h2>New</h2><ul><li><span class="tag">Checkout</span>Pay with saved cards in one tap</li><li><span class="tag">Search</span>Results update as you type</li>
<li><span class="tag">Account</span>Download your data as CSV</li><li><span class="tag">Admin</span>Bulk invite from a spreadsheet</li></ul>
<h2>Fixed</h2><ul><li>Signup page no longer jumps when the keyboard opens</li><li>Order emails show the right currency</li><li>Dark mode contrast on buttons</li></ul>
<h2>Breaking</h2><ul><li>The <code>/v1/export</code> endpoint is removed; use <code>/v2/export</code>.</li></ul></body></html>`;

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
      await call("publish_artifact", {
        title: "Release notes v2.3",
        description: "Draft notes for the v2.3 release, grouped by area.",
        html: RELEASE_NOTES_HTML,
      });
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
const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2, colorScheme: THEME, locale: "en-US", timezoneId: "UTC" });
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
// The pictures show the hosted service's address, not this local one.
const hideLocalAddress = () =>
  page.evaluate((local) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes(local)) n.nodeValue = n.nodeValue.replaceAll(local, "https://myrel.fibteq.io");
    }
  }, WEB);
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  await hideLocalAddress();
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
  const ask = threadIds.has(frame.threadId) ? undefined : ASKS.find((a) => frame.prompt.includes(a.ask));
  if (ask) threadIds.set(ask.title, frame.threadId).set(frame.threadId, ask.title);
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
  version: RUNNER_VERSION,
  hostname: "adas-macbook",
  platform: "darwin",
  folders: [{ path: FOLDER, name: "acme-web" }],
  clis: [
    { id: "claude", version: "2.1.0" },
    { id: "codex", version: "0.52.0" },
    { id: "opencode", version: "1.4.0" },
  ],
  features: ["folders", "cancel", "agent", "settings", "update"],
  settings: { access: "auto", worktrees: true, autoUpdate: true, remote: true },
  updates: "service",
  running: [],
});
await until(() => welcomed, "the runner's welcome");

// A button or field by its accessible name, its label or its tooltip.
const byName = (name) => page.getByRole("button", { name }).or(page.getByLabel(name, { exact: true })).or(page.getByTitle(name, { exact: true })).first();

/**
 * Tours for <Walkthrough>: each step saves a screenshot and where to click on it, so the
 * highlighted spot follows the real button when the UI changes.
 */
const tours = new Map();
const step = async (tour, target) => {
  if (!tours.has(tour)) {
    tours.set(tour, []);
    await rm(`${WALK}${tour}`, { recursive: true, force: true });
    await mkdir(`${WALK}${tour}`, { recursive: true });
  }
  const list = tours.get(tour);
  await target.waitFor({ timeout: 30_000 });
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const box = await target.boundingBox();
  const { width, height } = page.viewportSize();
  const image = `${list.length + 1}.png`;
  await hideLocalAddress();
  await page.screenshot({ path: `${WALK}${tour}/${image}` });
  const pad = 6;
  const r = (v) => Math.round(v);
  list.push({ image, x: r(box.x - pad), y: r(box.y - pad), w: r(box.width + 2 * pad), h: r(box.height + 2 * pad), width, height });
  console.log(`saved ${tour}/${image}`);
};

// Quickstart: a new project, the first ask, its thread and the decision it brings back.
await page.goto(`${WEB}/`);
await page.getByPlaceholder("Project name").fill("Acme website");
await step("quickstart", page.getByRole("button", { name: "Create" }));
await page.getByRole("button", { name: "Create" }).click();
await page.waitForURL(/\/projects\/[^/]+$/);
const projectId = new URL(page.url()).pathname.split("/").pop();
await until(async () => {
  try {
    await api(`/api/projects/${projectId}/workspace`, { method: "PUT", body: { runnerId: paired.runner.id, path: FOLDER, cli: "claude" } });
    return true;
  } catch {
    return false;
  }
}, "the project's folder");
await page.reload();
const composer = page.getByPlaceholder("Give Myrel a task");
const signup = ASKS.find((a) => a.title === "Slow signup page");
const release = ASKS.find((a) => a.title === "Release notes v2.3");
await composer.fill(signup.ask);
await step("quickstart", byName("Send"));
await composer.press("Enter");
await page.getByText(signup.projectAck).first().waitFor({ timeout: 30_000 });
const card = (title) => page.locator("a, button", { hasText: title }).first();
await step("quickstart", card(signup.title));
await card(signup.title).click();
await page.getByText("How should I fix the country picker?").first().waitFor({ timeout: 30_000 });
await step("quickstart", page.getByText("Pick a fix with you").first());
await step("quickstart", page.getByRole("button", { name: /Lazy-load it/ }).first());

// Following a thread: where it stands, how a reply was made, steering it and finishing it.
await step("thread", page.getByText("Waiting for you").last());
await step("thread", page.getByText("Your computer").last());
await step("thread", page.getByPlaceholder("Reply in this thread"));
await step("thread", byName("Changes"));
await step("thread", byName("Mark resolved"));
await shot("thread");

// A second ask, for the chat, the artifact and the usage pictures.
await page.goto(`${WEB}/projects/${projectId}`);
await composer.fill(release.ask);
await composer.press("Enter");
await page.getByText(release.projectAck).first().waitFor({ timeout: 30_000 });
await until(() => threadIds.has(release.title), "the release notes thread");
await page.waitForTimeout(4000);
await page.reload();
await page.waitForLoadState("networkidle");
await shot("project-chat");

// The CLI picker under the composer, with several CLIs on the computer.
await byName("Which CLI should this ask run with?").click();
await page.getByText("Pick several and Myrel chooses").waitFor();
await shot("cli-picker");
await page.keyboard.press("Escape");

// The artifact the release notes thread published.
await page.goto(`${WEB}/projects/${projectId}/artifacts`);
await page.getByText("Release notes v2.3").first().click();
await page.waitForTimeout(2500);
await shot("artifact");

// Routines: the form for a new one.
await page.goto(`${WEB}/projects/${projectId}`);
await page.getByRole("button", { name: "Routines", exact: true }).click();
// With no routines yet the panel opens on the form; otherwise start one.
await page.getByRole("button", { name: "New", exact: true }).click({ timeout: 3000 }).catch(() => {});
await page.getByPlaceholder(/Name, e\.g\./).fill("Morning digest");
await page.getByPlaceholder("What should Myrel do each time?").fill("Summarize yesterday's merged pull requests and open threads.");
await shot("routines");
await page.keyboard.press("Escape");

// Connecting a computer: pairing, sharing a folder and the project's folder.
await page.goto(`${WEB}/devices`);
await step("computer", byName("Connect a computer"));
await byName("Connect a computer").click();
await step("computer", byName("Copy command"));
await page.keyboard.press("Escape");
await page.goto(`${WEB}/devices`);
await step("computer", byName("Add folder"));
await page.goto(`${WEB}/projects/${projectId}`);
await step("computer", page.getByRole("button", { name: /acme-web/ }).first());

await page.goto(`${WEB}/devices`);
await page.waitForLoadState("networkidle");
await shot("devices");
await page.getByRole("button", { name: /^Settings of / }).click();
await page.getByText("What the CLI may do on its own").waitFor();
await shot("runner-settings");

await page.goto(`${WEB}/`);
await page.waitForLoadState("networkidle");
await shot("projects");

await page.goto(`${WEB}/settings/projects/${projectId}`);
await page.waitForLoadState("networkidle");
await shot("project-settings");

await page.goto(`${WEB}/settings`);
await page.getByText("Appearance").first().scrollIntoViewIfNeeded();
await shot("settings-account");

await page.goto(`${WEB}/usage`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);
await shot("usage");

for (const [tour, list] of tours) await writeFile(`${WALK}${tour}/targets.json`, `${JSON.stringify(list, null, 2)}\n`);

ws.close();
await browser.close();
fakeModel.close();
