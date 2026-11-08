#!/usr/bin/env node
// Checks the evaluator's verdict.json against report.json and writes summary.md for the coder.
//
//   node verdict.mjs /tmp/myrel-checks/pricing/1
//
// The rules are enforced here, not left to the evaluator's good will:
// - a model that did not read the vision probe back cannot pass anything (it may not see images);
// - a deterministic blocking finding is either passed on or dismissed with a reason, never dropped;
// - every blocking finding points at a screenshot that exists;
// - functionality and craft below the bar cannot pass.
// Exit code 1 means verdict.json has to be fixed; the problems are printed.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { groupFindings } from "./shared.mjs";

const PASS_BAR = { functionality: 6, craft: 6 };
const SCORES = ["functionality", "craft", "design", "originality"];

const dir = resolve(process.argv[2] ?? ".");
const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
const verdict = JSON.parse(await readFile(join(dir, "verdict.json"), "utf8"));
const problems = [];
const notes = [];

if (!["pass", "fail", "deterministic_only"].includes(verdict.verdict)) problems.push(`"verdict" must be "pass", "fail" or "deterministic_only", not ${JSON.stringify(verdict.verdict)}.`);
verdict.evaluator ??= {};
for (const key of ["cli", "model"]) if (!verdict.evaluator[key]) problems.push(`evaluator.${key} is missing: say which CLI and model judged this.`);

// 1. The vision probe.
const answer = String(verdict.evaluator.probeAnswer ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hash = createHash("sha256").update(report.probe.salt + answer).digest("hex");
const vision = !answer ? "skipped" : hash === report.probe.sha256 ? "passed" : "failed";
verdict.evaluator.visionCheck = vision;
if (vision !== "passed") {
  if (verdict.scores) notes.push("Scores dropped: the vision probe was not read back, so the screenshots were not really seen.");
  delete verdict.scores;
  if (verdict.verdict === "pass") {
    verdict.verdict = "deterministic_only";
    notes.push(`Verdict lowered from pass to deterministic_only: vision probe ${vision}.`);
  }
} else if (verdict.verdict === "deterministic_only") {
  notes.push("The probe was read, so the screenshots could have been judged; deterministic_only kept as asked.");
}

// 2. Deterministic blocking findings are passed on or dismissed with a reason.
verdict.blocking ??= [];
verdict.dismissed ??= [];
const dismissedBy = (f) => verdict.dismissed.find((d) => d.id === f.id && (d.screen === f.screen || (d.screen && !d.screen.includes("@") && f.screen.startsWith(`${d.screen}@`))));
for (const d of verdict.dismissed) if (!d.reason?.trim()) problems.push(`dismissed ${d.id} on ${d.screen} needs a reason.`);
const reportBlocking = report.findings.filter((f) => f.severity === "blocking");
const open = reportBlocking.filter((f) => !dismissedBy(f));
for (const g of groupFindings(open)) {
  const covered = verdict.blocking.some((b) => b.id === g.id && (b.screen ?? "").split("@")[0] === g.screen);
  if (covered) continue;
  const first = open.find((f) => f.id === g.id && f.screen.startsWith(`${g.screen}@`));
  verdict.blocking.push({ id: g.id, screen: first.screen, evidence: first.file, problem: g.message, where: g.where, source: "deterministic" });
}
if (open.length && verdict.verdict !== "fail") {
  notes.push(`Verdict set to fail: ${open.length} deterministic blocking finding(s) were neither fixed nor dismissed.`);
  verdict.verdict = "fail";
}

// 3. Evidence.
for (const b of verdict.blocking) {
  if (!b.problem?.trim()) problems.push(`A blocking finding on ${b.screen ?? "?"} has no "problem".`);
  if (!b.evidence) problems.push(`Blocking finding "${b.problem ?? "?"}" has no evidence screenshot.`);
  else if (!existsSync(join(dir, b.evidence))) problems.push(`Evidence ${b.evidence} does not exist in ${dir}.`);
}
if (verdict.verdict === "fail" && !verdict.blocking.length) problems.push("A fail needs at least one blocking finding with evidence.");

// 4. Scores and the bar.
if (verdict.scores) {
  for (const k of SCORES) {
    const v = verdict.scores[k];
    if (!Number.isInteger(v) || v < 1 || v > 10) problems.push(`scores.${k} must be a whole number from 1 to 10.`);
  }
  const low = Object.entries(PASS_BAR).filter(([k, bar]) => verdict.scores[k] < bar);
  if (verdict.verdict === "pass" && low.length) {
    verdict.verdict = "fail";
    notes.push(`Verdict set to fail: ${low.map(([k, bar]) => `${k} ${verdict.scores[k]} < ${bar}`).join(", ")}.`);
    if (!verdict.blocking.length) problems.push("Scores are below the bar: add the blocking finding(s) that explain them.");
  }
} else if (vision === "passed" && verdict.verdict === "pass") {
  problems.push("A pass after reading the screenshots needs scores.");
}

if (problems.length) {
  console.error(`verdict.json needs fixing:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}

verdict.checked = { at: new Date().toISOString(), report: report.createdAt, commit: report.git?.commit, notes };
await writeFile(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);

// summary.md: what the coder (and the person) read.
const label = { pass: "PASS", fail: "FAIL", deterministic_only: "PASS (deterministic checks only, look not judged)" }[verdict.verdict];
const ev = verdict.evaluator;
const lines = [
  `# Visual check: ${label}`,
  "",
  `- Round ${verdict.round ?? 1}, commit ${report.git?.commit?.slice(0, 10) ?? "unknown"}${report.git?.dirty ? " (uncommitted changes)" : ""}`,
  `- Judged by ${ev.cli} / ${ev.model}${ev.effort ? ` (${ev.effort})` : ""}; vision probe ${vision}`,
  `- Deterministic checks: ${report.summary.shots} screenshot(s), ${report.summary.blocking} blocking, ${report.summary.warnings} warning(s)${verdict.dismissed.length ? `, ${verdict.dismissed.length} dismissed` : ""}`,
];
if (verdict.scores) lines.push(`- Scores: ${SCORES.map((k) => `${k} ${verdict.scores[k]}`).join(", ")} (pass needs functionality and craft ≥ 6)`);
if (verdict.verdict === "deterministic_only") lines.push("- The look was not judged: no model that reads images took part. Nothing here says the screens look good.");
if (verdict.blocking.length) {
  lines.push("", "## Must fix", "");
  for (const b of verdict.blocking) {
    lines.push(`- **${b.screen}**${b.where ? ` [${b.where}]` : ""}: ${b.problem}${b.expected ? ` Expected: ${b.expected}` : ""} (evidence: \`${b.evidence}\`)`);
  }
}
if (verdict.acceptance?.length) {
  lines.push("", "## Acceptance criteria", "");
  for (const a of verdict.acceptance) lines.push(`- ${a.met ? "✓" : "✗"} ${a.criterion}${a.evidence ? ` (\`${a.evidence}\`)` : ""}`);
}
if (verdict.advice?.length) {
  lines.push("", "## Advice (not blocking)", "");
  for (const a of verdict.advice) lines.push(`- ${a}`);
}
const warnings = groupFindings(report.findings.filter((f) => f.severity === "warning"));
if (warnings.length) {
  lines.push("", "## Deterministic warnings", "");
  for (const w of warnings.slice(0, 25)) lines.push(`- ${w.screen} [${w.where}] \`${w.id}\`: ${w.message}`);
  if (warnings.length > 25) lines.push(`- …and ${warnings.length - 25} more in report.json`);
}
if (verdict.dismissed.length) {
  lines.push("", "## Dismissed by the evaluator", "");
  for (const d of verdict.dismissed) lines.push(`- ${d.screen} \`${d.id}\`: ${d.reason}`);
}
if (notes.length) lines.push("", "## Rules applied", "", ...notes.map((n) => `- ${n}`));
const summary = `${lines.join("\n")}\n`;
await writeFile(join(dir, "summary.md"), summary);
process.stdout.write(summary);
