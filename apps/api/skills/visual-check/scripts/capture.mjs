#!/usr/bin/env node
// Captures an app's screens and runs the checks that need no model: errors, layout, accessibility
// and pixels. Writes report.json, the screenshots and one contact sheet per screen into --out.
//
//   node capture.mjs --config .myrel/checks.json --out /tmp/myrel-checks/pricing/1
//   node capture.mjs --url http://localhost:5173 --path / --path /settings
//   node capture.mjs --serve dist --path /index.html --target game
//   node capture.mjs --path / --path /pricing        (no --url/--start/--serve: the app is detected)
//
// See ../SKILL.md for the config file and ../rubric.md for what the evaluator does with the report.

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream, existsSync, openSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { AXE_VERSION, PLAYWRIGHT_VERSION, launchBrowser, loadDeps } from "./deps.mjs";
import { detectApp } from "./detect.mjs";
import { explainChecks, layoutChecks } from "./page-checks.mjs";
import { groupFindings } from "./shared.mjs";
import { contactSheet, diffImage, frameDiff, imageStats, pixelPage, pngSize, probeImage } from "./pixels.mjs";

const HELP = `Usage: node capture.mjs [--config file] [--url base | --start "cmd {port}" | --serve dir]
       [--path /p ...] [--viewports 390,768,1440] [--themes light,dark] [--target web|game|electron]
       [--baseline dir] [--out dir] [--name label] [--cwd dir] [--timeout seconds]`;

const log = (m) => console.error(`[visual-check] ${m}`);

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const out = { path: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      i++;
      if (key === "path") out.path.push(value);
      else out[key] = value;
    } else throw new Error(`Unknown argument ${a}`);
  }
  return out;
}

const HEIGHTS = (w) => (w < 600 ? 844 : w < 1100 ? 1024 : 900);

function viewport(v) {
  if (typeof v === "number") return { width: v, height: HEIGHTS(v) };
  if (typeof v === "string") {
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h || HEIGHTS(w) };
  }
  return { width: v.width, height: v.height ?? HEIGHTS(v.width) };
}

async function loadConfig(args) {
  let file = args.config;
  if (!file && existsSync(".myrel/checks.json")) file = ".myrel/checks.json";
  const config = file ? JSON.parse(await readFile(file, "utf8")) : {};
  if (args.url) config.url = args.url;
  if (args.start) config.start = args.start;
  if (args.serve) config.serve = args.serve;
  if (args.cwd) config.cwd = args.cwd;
  if (args.target) config.target = args.target;
  if (args.timeout) config.timeout = Number(args.timeout);
  if (args.viewports) config.viewports = args.viewports.split(",").map((v) => (/x/.test(v) ? v : Number(v)));
  if (args.themes) config.themes = args.themes.split(",");
  if (args.baseline) config.baseline = args.baseline;
  if (args.path.length) config.screens = args.path.map((p) => ({ name: screenName(p), path: p }));
  // Nothing said where the app is: work it out from the repository (see detect.mjs).
  if (!config.url && !config.start && !config.serve && config.target !== "electron" && !config.electron && (config.screens ?? []).every((s) => !s.url)) {
    const found = detectApp(resolve(config.cwd ?? "."));
    if (!found) throw new Error("Could not tell how to start the app: pass --url, --start or --serve, or write .myrel/checks.json.");
    if (found.warning) throw new Error(`${found.detected}: ${found.warning}`);
    Object.assign(config, found, config.target && { target: config.target });
    log(`Detected ${found.detected}`);
    if (found.note) log(found.note);
  }
  if (config.electron) config.target ??= "electron";
  config.target ??= "web";
  const game = config.target === "game";
  const desktop = config.target === "electron";
  // A desktop app has windows, not phones: two window sizes.
  config.viewports = (config.viewports ?? (game ? [390, 1280] : desktop ? ["1024x700", "1440x900"] : [390, 768, 1440])).map(viewport);
  config.themes ??= game ? ["dark"] : ["light", "dark"];
  // An Electron app opens on its own first screen; a screen's path is read against that window's address.
  config.screens ??= [desktop ? { name: "home" } : { name: "home", path: "/" }];
  if (desktop) config.electron = { main: ".", ...config.electron };
  config.timeout ??= 120;
  config.limit ??= 8;
  config.ignore ??= [];
  config.ignoreConsole = (config.ignoreConsole ?? []).map((r) => new RegExp(r, "i"));
  config.ignoreAxe ??= [];
  config.minTarget ??= 24;
  return { config, file };
}

const screenName = (p) => p.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() || "home";

// ---------------------------------------------------------------- the app under test

function freePort() {
  return new Promise((ok, fail) => {
    const s = netServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function waitForHttp(url, seconds, child) {
  const end = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`The start command exited with code ${child.exitCode} before ${url} answered.`);
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.cause?.code ?? err.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer within ${seconds} s (${last}).`);
}

/** Starts the app's own dev or preview server on a free port. */
async function startApp(config, outDir) {
  const port = await freePort();
  const cmd = config.start.replaceAll("{port}", String(port));
  const logFile = join(outDir, "server.log");
  const fd = openSync(logFile, "a");
  log(`Starting: ${cmd}`);
  const child = spawn(cmd, {
    shell: true,
    cwd: config.cwd ? resolve(config.cwd) : process.cwd(),
    env: { ...process.env, PORT: String(port), BROWSER: "none", FORCE_COLOR: "0", ...config.startEnv },
    stdio: ["ignore", fd, fd],
    detached: process.platform !== "win32",
  });
  const stop = () => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  const base = `http://localhost:${port}`;
  try {
    await waitForHttp(base + (config.ready ?? "/"), config.timeout, child);
  } catch (err) {
    stop();
    const tail = (await readFile(logFile, "utf8").catch(() => "")).split("\n").slice(-30).join("\n");
    throw new Error(`${err.message}\nLast lines of ${logFile}:\n${tail}`);
  }
  return { base, stop, logFile };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain" };

/** Serves a built folder (a static site or a web game's build) on a free port. */
async function serveDir(dir) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  const port = await freePort();
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/** The criteria of all expect steps, once each: met only when it held in every screenshot that ran it. */
function criteriaOf(shots) {
  const byCriterion = new Map();
  for (const shot of shots) {
    for (const c of shot.criteria ?? []) {
      const key = `${shot.screen}\0${c.criterion}`;
      const e = byCriterion.get(key) ?? { criterion: c.criterion, screen: shot.screen, met: true, heldOn: [], failedOn: [], evidence: shot.file };
      if (c.met) e.heldOn.push(shot.id);
      else {
        if (e.met) e.evidence = shot.file;
        e.met = false;
        e.failedOn.push(shot.id);
      }
      byCriterion.set(key, e);
    }
  }
  return [...byCriterion.values()];
}

// ---------------------------------------------------------------- one screen at one size

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * An `expect` step: what must be true at this point of a flow, checked until `timeout` ms (5000)
 * pass. Several conditions in one step must all hold. Returns what it expected and whether it held.
 */
async function expectStep(page, e) {
  const conditions = [];
  if (e.text != null) conditions.push([`the text "${e.text}" shows`, () => page.getByText(String(e.text)).first().isVisible()]);
  if (e.visible) conditions.push([`${e.visible} shows`, () => page.locator(e.visible).first().isVisible()]);
  if (e.hidden) conditions.push([`${e.hidden} does not show`, async () => !(await page.locator(e.hidden).first().isVisible())]);
  if (e.url) conditions.push([`the address matches ${e.url}`, async () => new RegExp(e.url).test(page.url())]);
  if (e.count) conditions.push([`${e.count[1]} × ${e.count[0]}`, async () => (await page.locator(e.count[0]).count()) === Number(e.count[1])]);
  if (e.value) conditions.push([`${e.value[0]} holds "${e.value[1]}"`, async () => (await page.locator(e.value[0]).first().inputValue({ timeout: 1000 })) === String(e.value[1])]);
  if (!conditions.length) throw new Error(`An expect step needs text, visible, hidden, url, count or value: ${JSON.stringify(e)}`);
  const what = conditions.map(([w]) => w).join(" and ");
  const until = Date.now() + Number(e.timeout ?? 5000);
  for (;;) {
    const held = await Promise.all(conditions.map(([, test]) => test().catch(() => false)));
    if (held.every(Boolean)) return { what, met: true };
    if (Date.now() > until) return { what: conditions.filter((_, i) => !held[i]).map(([w]) => w).join(" and "), met: false };
    await page.waitForTimeout(200);
  }
}

/** A step that did not hold: the flow stops there, and its criterion is not met. */
class Unmet extends Error {
  constructor(what, criterion) {
    super(`expected ${what}`);
    this.criterion = criterion;
  }
}

/** Runs a screen's steps in order; each expect step's result goes to `criteria`. */
async function runActions(page, actions = [], criteria = []) {
  for (const step of actions) {
    const [kind, arg] = Object.entries(step)[0] ?? [];
    switch (kind) {
      case "expect": {
        const r = await expectStep(page, arg);
        const criterion = arg.criterion ?? r.what;
        criteria.push({ criterion, met: r.met, ...(!r.met && { failed: r.what }) });
        if (!r.met) throw new Unmet(r.what, criterion);
        break;
      }
      case "click": await page.locator(arg).first().click({ timeout: 10_000 }); break;
      case "hover": await page.locator(arg).first().hover({ timeout: 10_000 }); break;
      case "fill": await page.locator(arg[0]).first().fill(String(arg[1]), { timeout: 10_000 }); break;
      case "press": await page.keyboard.press(arg); break;
      case "wait": await page.waitForTimeout(Number(arg)); break;
      case "waitFor": await page.locator(arg).first().waitFor({ timeout: 15_000 }); break;
      case "scroll":
        if (typeof arg === "number") await page.evaluate((y) => window.scrollTo(0, y), arg);
        else await page.locator(arg).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
        break;
      case "step": await page.evaluate((ms) => window.__myrelTest?.step?.(ms), Number(arg)); break;
      case "eval": await page.evaluate(arg); break;
      default: throw new Error(`Unknown action ${JSON.stringify(step)}`);
    }
  }
}

/** Waits until the page stops moving: network quiet, fonts loaded, two frames drawn. */
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }).catch(() => {});
  await page.waitForTimeout(250);
}

/**
 * The page to capture at one size and theme: a fresh browser context, or for an Electron app the
 * first window of a fresh launch, sized and themed to match.
 */
async function openPage({ browser, deps, display, config, screen, vp, theme }) {
  const scheme = theme === "dark" ? "dark" : "light";
  const reducedMotion = config.target === "game" || screen.motion ? "no-preference" : "reduce";
  const init = config.init && `window.__myrelTheme=${JSON.stringify(theme)};\n${config.init}`;
  if (config.target === "electron") {
    const e = config.electron;
    const cwd = resolve(config.cwd ?? ".");
    let executablePath = e.executablePath;
    if (!executablePath) {
      try {
        // The electron package exports the path of its binary.
        executablePath = createRequire(join(cwd, "package.json"))("electron");
      } catch {
        throw new Error(`Electron is not installed in ${cwd}: install the app's dependencies, or set electron.executablePath.`);
      }
    }
    // Checked first: Playwright's launch of a binary that cannot load its libraries ends the whole process.
    const lacking = electronLibs(executablePath);
    if (lacking) throw new Error(`Electron cannot start.${lacking}`);
    const app = await deps.electron
      .launch({
        executablePath,
        cwd,
        // A root user (a container) cannot use Chromium's sandbox.
        args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), e.main ?? ".", ...(e.args ?? [])],
        env: { ...process.env, ...display.env, ...(e.env ?? {}) },
        colorScheme: scheme,
        locale: config.locale ?? "en-US",
        timezoneId: config.timezone ?? "UTC",
        timeout: 30_000,
      })
      .catch((err) => {
        throw new Error(`Electron did not start: ${String(err?.message ?? err).split("\n")[0]}${electronLibs(executablePath)}`);
      });
    try {
      const page = await app.firstWindow({ timeout: 30_000 });
      // The app's own idea of the theme (nativeTheme) and the page's (prefers-color-scheme), and the window's size.
      await app.evaluate(({ BrowserWindow, nativeTheme }, o) => {
        nativeTheme.themeSource = o.scheme;
        BrowserWindow.getAllWindows()[0]?.setContentSize(o.width, o.height);
      }, { scheme, width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion });
      if (init) {
        await page.addInitScript({ content: init });
        await page.reload({ waitUntil: "load" });
      }
      await page.waitForFunction((w) => window.innerWidth === w, vp.width, { timeout: 5000 }).catch(() => {});
      return { page, electron: true, close: () => app.close().catch(() => {}) };
    } catch (err) {
      await app.close().catch(() => {});
      throw err;
    }
  }
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.width < 600,
    hasTouch: vp.width <= 1024,
    colorScheme: scheme,
    reducedMotion,
    locale: config.locale ?? "en-US",
    timezoneId: config.timezone ?? "UTC",
    ...(config.storageState && { storageState: config.storageState }),
  });
  if (init) await context.addInitScript({ content: init });
  return { page: await context.newPage(), close: () => context.close() };
}

/** On Linux, the system libraries Electron's binary cannot find, and the command that installs them. */
function electronLibs(binary) {
  if (process.platform !== "linux") return "";
  try {
    const missing = execFileSync("ldd", [binary], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((l) => l.includes("not found"))
      .map((l) => l.trim().split(/\s/)[0]);
    if (!missing.length) return "";
    return `\nThis computer lacks the system libraries Electron needs (${missing.join(", ")}). Someone with sudo runs once:\n  sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 xvfb`;
  } catch {
    return "";
  }
}

/**
 * An X display for Electron on a Linux computer without one (a server, a container): a private
 * Xvfb, stopped when the check ends. Elsewhere, or with DISPLAY set, the computer's own.
 */
async function ensureDisplay() {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { env: {}, stop() {} };
  for (let n = 90; n < 120; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) continue;
    const child = spawn("Xvfb", [`:${n}`, "-screen", "0", "1920x1200x24", "-nolisten", "tcp"], { stdio: "ignore" });
    const result = await new Promise((ok) => {
      child.once("error", (err) => ok(err.code === "ENOENT" ? "missing" : "failed"));
      child.once("exit", () => ok("failed"));
      setTimeout(() => ok("running"), 700);
    });
    if (result === "missing") {
      throw new Error("An Electron app needs a display, and this computer has none and no Xvfb. Someone with sudo runs once:\n  sudo apt-get install -y xvfb");
    }
    // Another X server holds this number: try the next.
    if (result === "failed") continue;
    log(`Started a virtual display :${n} for Electron`);
    // Gone with this process however it ends.
    const stop = () => child.exitCode === null && child.kill();
    process.once("exit", stop);
    return { env: { DISPLAY: `:${n}` }, stop };
  }
  throw new Error("No free X display number for Xvfb (:90 to :119).");
}

async function shoot(ctx) {
  const { pixels, axeSource, config, base, screen, vp, theme, outDir } = ctx;
  const id = `${screen.name}@${vp.width}-${theme}`;
  const file = `${screen.name}-${vp.width}-${theme}.png`;
  const findings = [];
  // Where the finding is in the screenshot (from its elements' boxes), so it can be marked there.
  const boxesOf = (details) => (details?.items ?? details?.offenders ?? []).map((i) => i.box).filter(Boolean).slice(0, 8);
  const add = (severity, kind, message, details) => {
    const boxes = boxesOf(details);
    findings.push({ id: kind, severity, screen: id, file, message, ...(boxes.length && { boxes }), ...(details && { details }) });
  };
  const game = config.target === "game";
  const opened = await openPage(ctx);
  const { page } = opened;
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/^Failed to load resource/.test(text) || config.ignoreConsole.some((r) => r.test(text))) return;
    consoleErrors.push(text.slice(0, 400));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.stack ?? err).slice(0, 600)));
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const url = res.url();
    if (/\/favicon\.ico(\?|$)/.test(url) || config.ignoreConsole.some((r) => r.test(url))) return;
    badResponses.push({ url: url.slice(0, 300), status: res.status(), type: res.request().resourceType() });
  });
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (config.ignoreConsole.some((r) => r.test(url))) return;
    failedRequests.push({ url: url.slice(0, 300), error: req.failure()?.errorText ?? "failed", type: req.resourceType() });
  });

  const shot = { id, screen: screen.name, viewport: vp, theme, file };
  // An Electron window is already open on the app's own page: a path is read against its address.
  const url = opened.electron
    ? (screen.url ?? (screen.path ? new URL(screen.path, page.url()).href : null))
    : (screen.url ?? new URL(screen.path ?? "/", base).href);
  shot.url = url ?? page.url();
  const started = Date.now();
  try {
    if (url) await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    else await page.waitForLoadState("load", { timeout: 30_000 });
  } catch (err) {
    add("blocking", "load-failed", `The page did not load: ${err.message.split("\n")[0]}`);
  }
  shot.loadMs = Date.now() - started;
  await settle(page);

  // A game's test hook: wait until it is ready, then restart it with a fixed seed.
  const hasHook = await page.evaluate(() => typeof window.__myrelTest === "object" && window.__myrelTest !== null).catch(() => false);
  if (hasHook) {
    const ready = await page
      .waitForFunction(() => !window.__myrelTest.ready || window.__myrelTest.ready(), null, { timeout: 15_000 })
      .then(() => true, () => false);
    if (!ready) add("blocking", "game-not-ready", "window.__myrelTest.ready() never became true within 15 s.");
    await page.evaluate((seed) => window.__myrelTest.seed?.(seed), config.seed ?? 1).catch((err) => add("blocking", "game-hook-error", `__myrelTest.seed() threw: ${err.message}`));
  }

  const criteria = [];
  try {
    await runActions(page, screen.actions, criteria);
  } catch (err) {
    if (err instanceof Unmet) add("blocking", "expect-failed", `Not met: ${err.criterion} (${err.message} after the screen's steps; the screenshot shows where the flow stopped).`);
    else add("blocking", "action-failed", `A scripted step failed: ${err.message.split("\n")[0]}`);
  }
  // Steps after a failed one never ran: their criteria are not met either.
  for (const step of (screen.actions ?? []).filter((a) => a.expect).slice(criteria.length)) {
    criteria.push({ criterion: step.expect.criterion ?? JSON.stringify(step.expect).slice(0, 120), met: false, failed: "not reached" });
  }
  if (criteria.length) shot.criteria = criteria;
  if (screen.waitFor) {
    await page.locator(screen.waitFor).first().waitFor({ timeout: 15_000 }).catch(() => add("blocking", "missing-element", `Expected element never appeared: ${screen.waitFor}`));
  }
  await settle(page);
  shot.title = await page.title().catch(() => "");

  const mask = (screen.mask ?? config.mask ?? []).map((sel) => page.locator(sel));
  const take = () => page.screenshot({ fullPage: !!screen.fullPage, mask, animations: game || screen.motion ? "allow" : "disabled" });
  // Apps that render after a socket or a slow request look blank for a moment: give them up to
  // 8 s before calling the screen blank, and record the wait.
  let png = await take();
  for (let waited = 0; waited < 8; waited++) {
    const st = await imageStats(pixels, png);
    if (st.dominant < 0.97) break;
    const content = await page.evaluate(() => (document.body?.innerText.trim().length ?? 0) > 0 || !!document.querySelector("canvas,img,svg,video")).catch(() => false);
    if (st.dominant < 0.998 && content) break;
    await page.waitForTimeout(1000);
    await settle(page);
    png = await take();
    shot.waitedForContent = waited + 1;
  }
  await writeFile(join(outDir, file), png);

  // Against the approved screenshot (the baseline a person approved): unchanged screens need no new look.
  if (config.baseline) {
    const approvedPath = join(resolve(config.baseline), file);
    if (existsSync(approvedPath)) {
      const approved = await readFile(approvedPath);
      const [a, b] = [pngSize(approved), pngSize(png)];
      const diff = a.width === b.width && a.height === b.height ? await frameDiff(pixels, approved, png) : 1;
      shot.baseline = { diff };
      if (diff > (config.baselineThreshold ?? 0.002)) {
        if (diff < 1) {
          shot.baseline.image = file.replace(/\.png$/, ".diff.png");
          await writeFile(join(outDir, shot.baseline.image), await diffImage(pixels, approved, png));
        }
        add("warning", "changed", `Differs from the approved screenshot: ${diff === 1 ? "its size changed" : `${(diff * 100).toFixed(1)}% of its pixels`}.`);
      }
    } else shot.baseline = { new: true };
  }

  // Frames: for games and animations, to tell a running screen from a frozen one.
  const frames = screen.frames ?? (game ? 3 : 0);
  if (frames > 1) {
    const interval = screen.frameInterval ?? 500;
    const dir = file.replace(/\.png$/, ".frames");
    await mkdir(join(outDir, dir), { recursive: true });
    const pics = [png];
    for (let i = 1; i < frames; i++) {
      if (hasHook) await page.evaluate((ms) => window.__myrelTest.step?.(ms), interval).catch(() => {});
      else await page.waitForTimeout(interval);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
      pics.push(await page.screenshot({ animations: "allow" }));
    }
    const files = [];
    for (let i = 0; i < pics.length; i++) {
      files.push(`${dir}/${i}.png`);
      await writeFile(join(outDir, dir, `${i}.png`), pics[i]);
    }
    const diffs = [];
    for (let i = 1; i < pics.length; i++) diffs.push(await frameDiff(pixels, pics[i - 1], pics[i]));
    shot.frames = { files, interval, diffs };
    const expectMotion = screen.expectMotion ?? game;
    if (expectMotion && Math.max(...diffs) < 0.0005) add("blocking", "frozen", `Nothing moved across ${frames} frames ${interval} ms apart.`, { diffs });
  }

  if (hasHook) shot.gameState = await page.evaluate(() => window.__myrelTest.state?.()).catch((err) => ({ error: err.message }));

  // Layout from the browser's own boxes.
  const layout = await page
    .evaluate(layoutChecks, { touch: vp.width <= 1024, ignore: [...config.ignore, ...(screen.ignore ?? [])], limit: config.limit, minTarget: config.minTarget, pageCoords: !!screen.fullPage })
    .catch((err) => ({ error: err.message }));
  if (layout.error) add("warning", "layout-unchecked", `Layout checks could not run: ${layout.error}`);
  else {
    shot.interactive = layout.interactive;
    if (layout.overflowX) add("blocking", "overflow-x", `The page scrolls sideways: ${layout.overflowX.scrollWidth}px of content in a ${layout.overflowX.viewport}px viewport.`, { offenders: layout.offscreen });
    else if (layout.offscreen.length) add("warning", "cut-off", `${layout.offscreen.length} element(s) run past the screen edge and are cut off.`, { offenders: layout.offscreen });
    if (layout.cutControls.length) add("blocking", "cut-off-control", `${layout.cutControls.length} control(s) are cut by the screen edge and cannot be scrolled to.`, { items: layout.cutControls });
    if (layout.covered.length) add("blocking", "covered-control", `${layout.covered.length} control(s) have something else drawn on top of them; a tap lands on the wrong element.`, { items: layout.covered });
    if (layout.overlaps.length) add("warning", "overlapping-controls", `${layout.overlaps.length} pair(s) of controls overlap.`, { items: layout.overlaps });
    if (layout.textOverlaps.length) add("warning", "overlapping-text", `${layout.textOverlaps.length} pair(s) of text runs are drawn over each other.`, { items: layout.textOverlaps });
    if (layout.clipped.length) add("warning", "clipped-text", `${layout.clipped.length} text element(s) are cut off by their box without an ellipsis.`, { items: layout.clipped });
    if (layout.smallTargets.length) add("warning", "small-target", `${layout.smallTargets.length} tap target(s) are smaller than ${config.minTarget}px.`, { items: layout.smallTargets });
    if (layout.brokenImages.length) add("blocking", "broken-image", `${layout.brokenImages.length} image(s) did not load.`, { items: layout.brokenImages });
    if (layout.failedFonts.length) add("warning", "font-failed", `Font(s) failed to load: ${layout.failedFonts.join(", ")}`);
  }

  // Text telling people how to use the screen. The words are the same in every theme: look once per width.
  if (screen.explain !== false && config.explain !== false && theme === config.themes[0]) {
    const explained = await page
      .evaluate(explainChecks, { ignore: [...config.ignore, ...(screen.ignore ?? [])], limit: config.limit, pageCoords: !!screen.fullPage })
      .catch(() => null);
    if (explained?.items.length) {
      const first = explained.items[0].text;
      add(
        "warning",
        "explains-ui",
        `${explained.items.length} piece(s) of text tell people how to use the screen ("${first.length > 80 ? `${first.slice(0, 80)}…` : first}"); a screen that needs instructions usually needs a clearer design.`,
        { items: explained.items },
      );
    }
  }

  // Accessibility with axe-core. page.evaluate is not subject to the page's CSP, a script tag would be.
  if (screen.axe !== false && config.axe !== false) {
    try {
      await page.evaluate(`${axeSource}\n;0`);
      const result = await page.evaluate(
        async ({ tags, ignore, exclude }) => {
          const r = await window.axe.run({ exclude: exclude.map((s) => [s]) }, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"], rules: Object.fromEntries(ignore.map((id) => [id, { enabled: false }])) });
          return r.violations.map((v) => ({ rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")), summary: v.nodes[0]?.failureSummary?.slice(0, 300) }));
        },
        { tags: AXE_TAGS, ignore: config.ignoreAxe, exclude: [...config.ignore, ...(screen.ignore ?? [])] },
      );
      for (const v of result) add(v.impact === "critical" ? "blocking" : "warning", `axe:${v.rule}`, `${v.help} (${v.nodes} element(s), ${v.impact})`, { targets: v.targets, summary: v.summary });
    } catch (err) {
      add("warning", "axe-unchecked", `Accessibility checks could not run: ${err.message.split("\n")[0]}`);
    }
  }

  // Pixels: a screen that is almost one colour did not render. A sparse page can be 98% background
  // too, so below "almost one colour" it also needs nothing on screen.
  shot.stats = await imageStats(pixels, png);
  const empty = !layout.error && layout.visibleText === 0 && layout.media === 0;
  if (shot.stats.dominant >= 0.998 || (shot.stats.dominant > 0.97 && empty)) {
    add("blocking", "blank", `The screen is ${Math.round(shot.stats.dominant * 1000) / 10}% one colour (${shot.stats.dominantColor})${empty ? " with no text or images on it" : ""}; it looks blank.`);
  }

  for (const e of pageErrors) add("blocking", "exception", `Uncaught exception: ${e.split("\n")[0]}`, { stack: e });
  if (consoleErrors.length) add("warning", "console-error", `${consoleErrors.length} console error(s): ${consoleErrors[0].split("\n")[0].slice(0, 160)}`, { messages: consoleErrors.slice(0, config.limit) });
  for (const r of badResponses) {
    const breaks = ["document", "script", "stylesheet", "font"].includes(r.type) || (["fetch", "xhr"].includes(r.type) && r.status >= 500);
    add(breaks ? "blocking" : "warning", "http-error", `HTTP ${r.status} for ${r.type} ${r.url}`);
  }
  for (const r of failedRequests) {
    if (r.error === "net::ERR_ABORTED" && !["document", "script", "stylesheet"].includes(r.type)) continue;
    add(["document", "script", "stylesheet"].includes(r.type) ? "blocking" : "warning", "request-failed", `${r.type} request failed (${r.error}): ${r.url}`);
  }

  await opened.close();
  return { shot, png, findings };
}

// ---------------------------------------------------------------- main

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const { config, file } = await loadConfig(args);
  const name = args.name ?? "check";
  const outDir = resolve(args.out ?? join(tmpdir(), "myrel-checks", `${screenName(name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  await mkdir(outDir, { recursive: true });
  log(`Writing to ${outDir}`);

  const deps = await loadDeps(log);
  let app = null;
  let browser = null;
  let display = { env: {}, stop() {} };
  const cleanup = async () => {
    app?.stop();
    await browser?.close().catch(() => {});
    display.stop();
  };
  process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));
  process.on("SIGTERM", () => cleanup().finally(() => process.exit(143)));
  try {
    if (config.serve) app = await serveDir(config.serve);
    else if (config.start) app = await startApp(config, outDir);
    const base = config.url ?? app?.base ?? "http://localhost/";
    if (config.url && !app) await waitForHttp(config.url, 15);
    browser = await launchBrowser(deps, log);
    const pixels = await pixelPage(browser);
    if (config.target === "electron") display = await ensureDisplay();

    const shots = [];
    const findings = [];
    const sheets = [];
    for (const screen of config.screens) {
      screen.name = screenName(screen.name ?? screen.path ?? "screen");
      const rows = [];
      // A flow can differ by width (a menu only on phones): a screen may name its own widths and themes.
      const themes = screen.themes ? config.themes.filter((t) => screen.themes.includes(t)) : config.themes;
      const viewports = screen.viewports ? config.viewports.filter((v) => screen.viewports.map(Number).includes(v.width)) : config.viewports;
      for (const theme of themes) {
        const row = [];
        for (const vp of viewports) {
          log(`${screen.name} @ ${vp.width}x${vp.height} ${theme}`);
          const r = await shoot({ browser, deps, display, pixels, axeSource: deps.axeSource, config, base, screen, vp, theme, outDir });
          shots.push(r.shot);
          findings.push(...r.findings);
          row.push({ label: `${vp.width}px ${theme}`, png: r.png });
        }
        rows.push(row);
      }
      if (rows.flat().length > 1) {
        const sheetFile = `${screen.name}.sheet.png`;
        await writeFile(join(outDir, sheetFile), await contactSheet(pixels, rows));
        sheets.push({ screen: screen.name, file: sheetFile });
      }
    }

    // The vision probe: only a model that reads the picture can give back the code.
    const alphabet = "ACDEFHJKMNPRTUVWXY3479";
    // VISUAL_CHECK_PROBE_CODE exists for selftest.mjs only.
    const code = process.env.VISUAL_CHECK_PROBE_CODE ?? Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
    const salt = randomBytes(8).toString("hex");
    await writeFile(join(outDir, "probe.png"), await probeImage(pixels, code));

    const blocking = findings.filter((f) => f.severity === "blocking");
    const warnings = findings.filter((f) => f.severity === "warning");
    const byId = {};
    for (const f of findings) byId[f.id] = (byId[f.id] ?? 0) + 1;
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      tool: { name: "visual-check", playwright: PLAYWRIGHT_VERSION, axe: AXE_VERSION, chromium: browser.version() },
      config: file ?? null,
      ...(config.detected && { detected: config.detected }),
      target: config.target,
      baseUrl: base,
      git: { commit: git(["rev-parse", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: !!git(["status", "--porcelain"]) },
      probe: { image: "probe.png", salt, sha256: createHash("sha256").update(salt + code).digest("hex") },
      summary: {
        shots: shots.length,
        blocking: blocking.length,
        warnings: warnings.length,
        byId,
        ...(config.baseline && {
          baseline: {
            unchanged: shots.filter((s) => s.baseline && !s.baseline.new && !findings.some((f) => f.id === "changed" && f.screen === s.id)).length,
            changed: findings.filter((f) => f.id === "changed").length,
            new: shots.filter((s) => s.baseline?.new).length,
          },
        }),
      },
      sheets,
      shots,
      findings: [...blocking, ...warnings],
      // Every expect step's criterion with the screenshots it held or failed on, for verdict.json's acceptance.
      criteria: criteriaOf(shots),
    };
    await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

    console.log(`Report: ${join(outDir, "report.json")}`);
    console.log(`${shots.length} screenshot(s), ${blocking.length} blocking, ${warnings.length} warning(s).`);
    for (const [severity, list] of [["BLOCKING", blocking], ["warning", warnings]]) {
      for (const g of groupFindings(list).slice(0, 20)) console.log(`  ${severity} ${g.screen} [${g.where}] ${g.id}: ${g.message}`);
    }
    for (const c of report.criteria) console.log(`  ${c.met ? "✓" : "✗"} ${c.criterion}${c.met ? "" : ` (not met on ${c.failedOn.join(", ")})`}`);
    console.log(`Contact sheets: ${sheets.map((s) => s.file).join(", ") || "none"}; vision probe: probe.png`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(`[visual-check] ${err.message}`);
  process.exit(1);
});
