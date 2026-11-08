import { z } from "zod";

/**
 * The visual check's rules, enforced on the server when an evaluator submits (the same rules as
 * skills/visual-check/scripts/verdict.mjs, which the evaluator runs first): a model that did not
 * read the vision probe back passes nothing; deterministic blocking findings are passed on or
 * dismissed with a reason; every blocking finding names a screenshot; functionality and craft
 * below the bar do not pass.
 */

export const PASS_BAR = { functionality: 6, craft: 6 } as const;

/** The parts of capture.mjs's report.json the rules read. */
export const CheckReport = z.object({
  probe: z.object({ salt: z.string(), sha256: z.string() }),
  summary: z.object({ shots: z.number(), blocking: z.number(), warnings: z.number() }),
  git: z.object({ commit: z.string().optional() }).partial().optional(),
  findings: z
    .array(z.object({ id: z.string(), severity: z.enum(["blocking", "warning"]), screen: z.string(), file: z.string(), message: z.string() }))
    .max(5000),
});
export type CheckReport = z.infer<typeof CheckReport>;

const Score = z.number().int().min(1).max(10);

/** The evaluator's verdict.json (see skills/visual-check/rubric.md). */
export const CheckVerdict = z.object({
  verdict: z.enum(["pass", "fail", "deterministic_only"]),
  evaluator: z.object({
    cli: z.string().min(1).max(60),
    model: z.string().min(1).max(120),
    effort: z.string().max(30).optional(),
    probeAnswer: z.string().max(40).optional(),
  }),
  scores: z.object({ functionality: Score, craft: Score, design: Score, originality: Score }).optional(),
  blocking: z
    .array(
      z.object({
        id: z.string().max(80).optional(),
        screen: z.string().max(200),
        evidence: z.string().max(300),
        problem: z.string().min(1).max(2000),
        expected: z.string().max(1000).optional(),
        /** The screenshot with the findings marked (verdict.mjs writes it). */
        image: z.string().max(300).optional(),
      }),
    )
    .max(50)
    .default([]),
  dismissed: z.array(z.object({ id: z.string(), screen: z.string(), reason: z.string().min(1).max(1000) })).max(200).default([]),
  acceptance: z.array(z.object({ criterion: z.string().max(500), met: z.boolean(), evidence: z.string().max(300).optional() })).max(30).default([]),
  advice: z.array(z.string().max(1000)).max(20).default([]),
});
export type CheckVerdict = z.infer<typeof CheckVerdict>;

export type VisionCheck = "passed" | "failed" | "skipped";

export type JudgedCheck = {
  verdict: CheckVerdict["verdict"];
  vision: VisionCheck;
  evaluator: CheckVerdict["evaluator"];
  scores?: CheckVerdict["scores"];
  blocking: (CheckVerdict["blocking"][number] & { deterministic?: boolean })[];
  dismissed: CheckVerdict["dismissed"];
  acceptance: CheckVerdict["acceptance"];
  advice: string[];
  deterministic: { shots: number; blocking: number; warnings: number };
  /** Rules that changed what the evaluator said. */
  notes: string[];
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Applies the rules to a submitted verdict. `exists` says whether an evidence file is there.
 * Returns the problems the evaluator must fix, or the verdict as the rules let it stand.
 */
export async function judgeCheck(
  report: CheckReport,
  input: CheckVerdict,
  exists: (path: string) => Promise<boolean>,
): Promise<{ ok: false; problems: string[] } | { ok: true; check: JudgedCheck }> {
  const problems: string[] = [];
  const notes: string[] = [];
  let verdict = input.verdict;
  let scores = input.scores;

  const answer = (input.evaluator.probeAnswer ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const vision: VisionCheck = !answer ? "skipped" : (await sha256(report.probe.salt + answer)) === report.probe.sha256 ? "passed" : "failed";
  if (vision !== "passed") {
    if (scores) notes.push("Scores dropped: the vision probe was not read back, so the screenshots were not really seen.");
    scores = undefined;
    if (verdict === "pass") {
      verdict = "deterministic_only";
      notes.push(`Lowered from pass to deterministic_only: vision probe ${vision}.`);
    }
  }

  // Deterministic blockers: passed on unless dismissed with a reason.
  const dismissedBy = (f: CheckReport["findings"][number]) =>
    input.dismissed.find((d) => d.id === f.id && (d.screen === f.screen || (!d.screen.includes("@") && f.screen.startsWith(`${d.screen}@`))));
  const open = report.findings.filter((f) => f.severity === "blocking" && !dismissedBy(f));
  const blocking: JudgedCheck["blocking"] = [...input.blocking];
  const listed = new Set<string>();
  for (const f of open) {
    const screen = f.screen.split("@")[0]!;
    const key = `${screen}\0${f.id}`;
    if (listed.has(key)) continue;
    listed.add(key);
    if (blocking.some((b) => b.id === f.id && b.screen.split("@")[0] === screen)) continue;
    blocking.push({ id: f.id, screen: f.screen, evidence: f.file, problem: f.message, deterministic: true });
  }
  if (open.length && verdict !== "fail") {
    notes.push(`Set to fail: ${open.length} deterministic blocking finding(s) were neither fixed nor dismissed.`);
    verdict = "fail";
  }

  for (const b of blocking) {
    if (!(await exists(b.evidence))) problems.push(`Evidence ${b.evidence} for "${b.problem.slice(0, 80)}" is not in the check's folder: upload it.`);
  }
  if (verdict === "fail" && !blocking.length) problems.push("A fail needs at least one blocking finding with a screenshot.");

  if (scores) {
    const low = (Object.keys(PASS_BAR) as (keyof typeof PASS_BAR)[]).filter((k) => scores![k] < PASS_BAR[k]);
    if (verdict === "pass" && low.length) {
      verdict = "fail";
      notes.push(`Set to fail: ${low.map((k) => `${k} ${scores![k]} < ${PASS_BAR[k]}`).join(", ")}.`);
      if (!blocking.length) problems.push("Scores are below the bar: add the blocking finding(s) that explain them.");
    }
  } else if (vision === "passed" && verdict === "pass") {
    problems.push("A pass after reading the screenshots needs scores.");
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    check: {
      verdict,
      vision,
      evaluator: input.evaluator,
      ...(scores && { scores }),
      blocking,
      dismissed: input.dismissed,
      acceptance: input.acceptance,
      advice: input.advice,
      deterministic: report.summary,
      notes,
    },
  };
}
