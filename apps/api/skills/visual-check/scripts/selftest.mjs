#!/usr/bin/env node
// Runs the checks on the pages in ../fixtures and asserts what they must find, then checks the
// verdict rules. Run it after changing the scripts, or to see whether this computer's browser works:
//
//   node selftest.mjs

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "visual-check-selftest-"));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const config = {
  serve: fixtures,
  viewports: [390, 1280],
  themes: ["light", "dark"],
  screens: [
    { name: "clean", path: "/clean.html" },
    { name: "broken", path: "/broken.html" },
    { name: "blank", path: "/blank.html" },
    { name: "explains", path: "/explains.html" },
    { name: "game", path: "/game.html", motion: true, actions: [{ step: 4000 }], frames: 3, expectMotion: true, axe: false },
    { name: "frozen", path: "/game.html?bug=frozen", motion: true, actions: [{ step: 4000 }], frames: 3, expectMotion: true, axe: false },
  ],
};
await writeFile(join(out, "checks.json"), JSON.stringify(config));
execFileSync(process.execPath, [join(here, "capture.mjs"), "--config", join(out, "checks.json"), "--out", out], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, VISUAL_CHECK_PROBE_CODE: "K7FQX" },
});
const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
const on = (screen, sev) => new Set(report.findings.filter((f) => f.screen.startsWith(`${screen}@`) && (!sev || f.severity === sev)).map((f) => f.id));

check(report.shots.length === 24, "24 screenshots (6 screens × 2 widths × 2 themes)");
check(on("clean").size === 0, `clean page has no findings (${[...on("clean")].join(", ") || "none"})`);
const broken = on("broken", "blocking");
for (const id of ["overflow-x", "covered-control", "cut-off-control", "broken-image", "exception", "axe:button-name"]) check(broken.has(id), `broken page: ${id} is blocking`);
const brokenWarn = on("broken", "warning");
for (const id of ["axe:color-contrast", "clipped-text", "overlapping-text", "small-target", "console-error"]) check(brokenWarn.has(id), `broken page: ${id} is a warning`);
check(!report.findings.some((f) => f.id === "overflow-x" && f.screen === "broken@1280-light"), "no sideways scroll at 1280px");
check(!report.findings.some((f) => f.id === "cut-off-control" && f.screen.startsWith("broken@1280")), "no cut-off control at 1280px");
check(on("blank", "blocking").has("blank"), "blank page is blank");
check(on("blank", "blocking").has("http-error"), "blank page: missing script is blocking");
check(on("game", "blocking").size === 0, `running game has no blocking findings (${[...on("game", "blocking")].join(", ") || "none"})`);
const game = report.shots.find((s) => s.id === "game@390-dark");
check(game?.gameState?.phase === "play" && game.gameState.stars > 0, "game state is read through the hook");
check(game?.frames?.diffs.every((d) => d > 0), "game frames differ");
check(on("frozen", "blocking").has("frozen"), "frozen game is caught");
check(report.sheets.length === 6, "one contact sheet per screen");
const explains = report.findings.filter((f) => f.id === "explains-ui" && f.screen.startsWith("explains@"));
check(explains.length === 2 && explains.every((f) => f.severity === "warning" && f.screen.endsWith("-light")), "explains-ui: a warning per width, in the first theme only");
const said = (explains[0]?.details?.items ?? []).map((i) => `${i.kind}:${i.target}`);
for (const want of ["layout:p#intro", "help-box:div#tip", "how-to:p#tr"]) check(said.includes(want), `explains-ui finds ${want} (${said.join(", ") || "nothing"})`);
check(!said.some((s) => s.includes("help-article") || s.includes("empty")), "explains-ui skips the help article and the empty state");
check(explains[0]?.details?.items.find((i) => i.kind === "how-to")?.text === "Bu sayfada tüm görevlerinizi görebilirsiniz.", "explains-ui quotes the whole sentence");
check((explains[0]?.boxes ?? []).length === 3, "explains-ui frames what it found");
check(!on("explains").has("overlapping-text"), "text wrapping after a bold word does not count as overlapping");

// Verdict rules.
const verdict = (v) => writeFile(join(out, "verdict.json"), JSON.stringify(v));
const runVerdict = () => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(here, "verdict.mjs"), out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};
const base = { evaluator: { cli: "selftest", model: "none" }, scores: { functionality: 8, craft: 8, design: 7, originality: 6 } };
await verdict({ ...base, verdict: "pass", evaluator: { ...base.evaluator, probeAnswer: "WRONG" } });
let r = runVerdict();
let v = JSON.parse(await readFile(join(out, "verdict.json"), "utf8"));
check(r.code === 0 && v.verdict === "fail" && !v.scores, "wrong probe answer: scores dropped, deterministic blockers force fail");
check(v.blocking.some((b) => b.id === "frozen" && b.source === "deterministic"), "deterministic blockers are passed on");

await verdict({ ...base, verdict: "pass", evaluator: { ...base.evaluator, probeAnswer: "k7f qx" } });
r = runVerdict();
v = JSON.parse(await readFile(join(out, "verdict.json"), "utf8"));
check(v.evaluator.visionCheck === "passed", "probe read back (case and spaces ignored)");
check(v.verdict === "fail", "a pass is refused while deterministic blockers are open");

const dismissAll = [...new Set(report.findings.filter((f) => f.severity === "blocking").map((f) => `${f.id}|${f.screen.split("@")[0]}`))].map((k) => {
  const [id, screen] = k.split("|");
  return { id, screen, reason: "selftest" };
});
await verdict({ ...base, verdict: "pass", evaluator: { ...base.evaluator, probeAnswer: "K7FQX" }, dismissed: dismissAll });
r = runVerdict();
v = JSON.parse(await readFile(join(out, "verdict.json"), "utf8"));
check(r.code === 0 && v.verdict === "pass", "pass once every blocker is dismissed with a reason");

await verdict({ ...base, verdict: "pass", evaluator: { ...base.evaluator, probeAnswer: "K7FQX" }, dismissed: dismissAll, scores: { ...base.scores, craft: 4 } });
r = runVerdict();
check(r.code === 1, "low craft score without a blocking finding is sent back");

await verdict({ verdict: "fail", evaluator: { ...base.evaluator, probeAnswer: "K7FQX" }, scores: base.scores, dismissed: dismissAll, blocking: [{ screen: "clean@390-light", problem: "x", evidence: "nope.png" }] });
r = runVerdict();
check(r.code === 1 && /does not exist/.test(r.out), "missing evidence file is sent back");

await verdict({ verdict: "deterministic_only", evaluator: { cli: "selftest", model: "text-only" }, dismissed: dismissAll });
r = runVerdict();
check(r.code === 0 && /look not judged/.test(r.out), "deterministic_only says the look was not judged");

// Findings are framed on their screenshots: the deterministic one from its element's box, the
// evaluator's from the box it gave.
await verdict({
  verdict: "fail",
  evaluator: { ...base.evaluator, probeAnswer: "K7FQX" },
  scores: base.scores,
  dismissed: dismissAll.filter((d) => !(d.id === "covered-control" && d.screen === "broken")),
  blocking: [{ screen: "clean@390-light", evidence: "clean-390-light.png", problem: "The Pro card is cramped.", box: { x: 16, y: 300, w: 358, h: 120 } }],
});
r = runVerdict();
v = JSON.parse(await readFile(join(out, "verdict.json"), "utf8"));
check(r.code === 0 && v.blocking[0].image === "annotated/clean-390-light.png" && v.blocking[0].n === 1, "the evaluator's finding is framed on its screenshot");
const covered = v.blocking.find((b) => b.id === "covered-control");
check(covered?.image === `annotated/${covered?.evidence}` && covered?.boxes?.length > 0, "a deterministic finding is framed from its element's box");
check(/^1\. \*\*clean@390-light/m.test(await readFile(join(out, "summary.md"), "utf8")), "summary numbers the findings like the frames");

// Against approved screenshots: the same page is unchanged, another page under its name is changed.
const again = join(out, "again");
await writeFile(join(out, "again.json"), JSON.stringify({
  serve: fixtures,
  viewports: [390],
  themes: ["light"],
  baseline: out,
  screens: [{ name: "clean", path: "/clean.html" }, { name: "game", path: "/broken.html", axe: false }],
}));
execFileSync(process.execPath, [join(here, "capture.mjs"), "--config", join(out, "again.json"), "--out", again], { stdio: ["ignore", "ignore", "inherit"] });
const second = JSON.parse(await readFile(join(again, "report.json"), "utf8"));
check(!second.findings.some((f) => f.id === "changed" && f.screen === "clean@390-light"), "an unchanged screen matches its approved screenshot");
check(second.findings.some((f) => f.id === "changed" && f.screen === "game@390-light"), "a changed screen is reported against its approved screenshot");
check(second.summary.baseline?.changed === 1 && second.summary.baseline?.unchanged === 1, "the report counts changed and unchanged screens");

console.log(failed ? `\n${failed} check(s) failed. Output in ${out}` : `\nAll checks passed. Output in ${out}`);
process.exit(failed ? 1 : 0);
