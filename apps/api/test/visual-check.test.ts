import { type Message, parseVisualCheck } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { pickEvaluatorCli } from "../src/checks/loop";
import { judgeCheck, type CheckReport, type CheckVerdict } from "../src/checks/verdict";
import { builtinBundle, builtinSkill } from "../src/skills/builtin";
import { BUILTIN_SKILL_FILES } from "../src/skills/builtin.gen";
import { renderMessage } from "../src/agents/render";
import { agentProject, api, closeRunners, mcp, signUp, type Turn, until } from "./fake-agent";

/** The names of the tools a turn's agent is offered. */
async function toolNames(turn: Turn): Promise<string[]> {
  const res = (await (await mcp(turn.start, { jsonrpc: "2.0", id: 99, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
  return res.result.tools.map((t) => t.name);
}

afterEach(() => closeRunners());

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function report(findings: CheckReport["findings"] = []): Promise<CheckReport> {
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  return {
    probe: { salt: "s4lt", sha256: await sha256("s4ltK7FQX") },
    summary: { shots: 6, blocking, warnings: findings.length - blocking },
    git: { commit: "abc" },
    findings,
  };
}

const verdict = (v: Partial<CheckVerdict> = {}): CheckVerdict => ({
  verdict: "pass",
  evaluator: { cli: "codex", model: "gpt-5.5", probeAnswer: "k7f qx" },
  scores: { functionality: 8, craft: 7, design: 7, originality: 6 },
  blocking: [],
  dismissed: [],
  acceptance: [],
  advice: [],
  ...v,
});

const has = (...paths: string[]) => async (p: string) => paths.includes(p);

describe("visual check rules", () => {
  it("passes a verdict that read the probe and scored above the bar", async () => {
    const r = await judgeCheck(await report(), verdict(), has());
    expect(r.ok && r.check.verdict).toBe("pass");
    expect(r.ok && r.check.vision).toBe("passed");
  });

  it("lowers a pass whose model did not read the probe and drops its scores", async () => {
    const r = await judgeCheck(await report(), verdict({ evaluator: { cli: "opencode", model: "text-only", probeAnswer: "WRONG" } }), has());
    expect(r.ok && r.check.verdict).toBe("deterministic_only");
    expect(r.ok && r.check.scores).toBeUndefined();
    expect(r.ok && r.check.notes.join(" ")).toContain("vision probe failed");
  });

  it("passes a deterministic blocker on unless it is dismissed with a reason", async () => {
    const f = { id: "overflow-x", severity: "blocking" as const, screen: "pricing@390-light", file: "pricing-390-light.png", message: "The page scrolls sideways" };
    const open = await judgeCheck(await report([f]), verdict(), has("pricing-390-light.png"));
    expect(open.ok && open.check.verdict).toBe("fail");
    expect(open.ok && open.check.blocking[0]).toMatchObject({ id: "overflow-x", deterministic: true, evidence: "pricing-390-light.png" });
    const dismissed = await judgeCheck(
      await report([f]),
      verdict({ dismissed: [{ id: "overflow-x", screen: "pricing", reason: "A cookie banner, out of scope" }] }),
      has(),
    );
    expect(dismissed.ok && dismissed.check.verdict).toBe("pass");
  });

  it("sends back findings without their screenshot and low scores without a finding", async () => {
    const missing = await judgeCheck(
      await report(),
      verdict({ verdict: "fail", blocking: [{ screen: "home@390-dark", evidence: "home-390-dark.png", problem: "The button is hidden" }] }),
      has(),
    );
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.problems[0]).toContain("home-390-dark.png");
    const low = await judgeCheck(await report(), verdict({ scores: { functionality: 8, craft: 4, design: 7, originality: 6 } }), has());
    expect(low.ok).toBe(false);
  });
});

describe("evaluator CLI", () => {
  it("picks another CLI than the coder's, skipping one at its limit, else the coder's own", () => {
    expect(pickEvaluatorCli([{ id: "claude" }, { id: "codex" }], "claude", true)).toBe("codex");
    expect(pickEvaluatorCli([{ id: "codex" }, { id: "opencode" }, { id: "claude" }], "codex", true)).toBe("claude");
    expect(pickEvaluatorCli([{ id: "claude" }, { id: "codex", limited: true }], "claude", true)).toBe("claude");
    expect(pickEvaluatorCli([{ id: "claude" }, { id: "codex" }], "codex", false)).toBe("claude");
    expect(pickEvaluatorCli([{ id: "codex" }], "codex", true)).toBe("codex");
  });
});

describe("built-in skill", () => {
  it("bundles visual-check with its scripts, SKILL.md first", () => {
    const files = BUILTIN_SKILL_FILES["visual-check"]!;
    expect(files[0]!.path).toBe("SKILL.md");
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(["rubric.md", "scripts/capture.mjs", "scripts/verdict.mjs", "scripts/detect.mjs"]));
    expect(builtinSkill("visual-check")).toMatchObject({ id: "builtin:visual-check", name: "visual-check" });
    const bundle = builtinBundle("builtin:visual-check")!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(bundle[0]!.content), (c) => c.charCodeAt(0)))).toContain("name: visual-check");
    expect(builtinBundle("skl_01")).toBeNull();
  });
});

describe("visual check loop", () => {
  it("runs a round: the coder asks, an evaluator with another CLI hands in, and the coder's card and next turn get the result", { timeout: 60_000 }, async () => {
    const token = await signUp();
    const coder: Turn[] = [];
    const evaluator: Turn[] = [];
    const out: Record<string, string> = {};
    let coderThread = "";
    const { project, close } = await agentProject(
      token,
      async (turn) => {
        if (turn.threadId === coderThread) {
          coder.push(turn);
          if (coder.length === 1) {
            out.coderTools = (await toolNames(turn)).join(",");
            out.pr = (await turn.call("open_pull_request", { repo: "acme/app", head: "feat/pricing", title: "x" })).text;
            out.request = (await turn.call("request_visual_check", { branch: "feat/pricing", what: "The pricing page at /pricing: three plans side by side." })).text;
            out.again = (await turn.call("request_visual_check", { branch: "feat/pricing", what: "again" })).text;
            out.prWhileRunning = (await turn.call("open_pull_request", { repo: "acme/app", head: "feat/pricing", title: "x" })).text;
            out.resolve = (await turn.call("resolve_thread")).text;
          }
          return;
        }
        evaluator.push(turn);
        out.evaluatorTools = (await toolNames(turn)).join(",");
        const id = /Check id: (chk_\w+)/.exec(turn.prompt)![1]!;
        const folder = /Results folder in the project files: `([^`]+)\/`/.exec(turn.prompt)![1]!;
        const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
        out.missing = (await turn.call("submit_visual_check", { check_id: id })).text;
        const by = { kind: "agent" as const, id: "thread-agent" };
        await projectAgent.writeFileText(`${folder}/report.json`, JSON.stringify(await report()), by);
        await projectAgent.writeFileText(
          `${folder}/verdict.json`,
          JSON.stringify(
            verdict({
              verdict: "fail",
              scores: { functionality: 5, craft: 6, design: 6, originality: 5 },
              blocking: [{ screen: "pricing@390-dark", evidence: "pricing-390-dark.png", problem: "The Pro card overlaps the bottom bar.", expected: "The card ends above it." }],
            }),
          ),
          by,
        );
        out.noEvidence = (await turn.call("submit_visual_check", { check_id: id })).text;
        await projectAgent.writeFileText(`${folder}/pricing-390-dark.png`, "png", by);
        await projectAgent.writeFileText(`${folder}/pricing.sheet.png`, "png", by);
        await projectAgent.writeFileText(`${folder}/summary.md`, "# Visual check: FAIL", by);
        out.submit = (await turn.call("submit_visual_check", { check_id: id })).text;
        out.resubmit = (await turn.call("submit_visual_check", { check_id: id })).text;
        await turn.call("resolve_thread");
      },
      { features: ["folders", "cancel", "agent", "agent-clis", "skills"], cli: "claude", clis: ["codex"] },
    );
    const set = await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body: JSON.stringify({ visualCheck: true }) });
    expect(((await set.json()) as { settings: { visualCheck: boolean } }).settings.visualCheck).toBe(true);

    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Fiyat sayfasını yap" });
    const thread = await projectAgent.createThread(root.id, "Fiyat sayfası");
    coderThread = thread.id;
    await (await getAgentByName(env.THREAD_AGENT, thread.id)).start({ projectId: project.id, threadId: thread.id, brief: "Build the pricing page." });

    await until(() => out.resolve, "the coder's first turn");
    expect(out.coderTools).toContain("request_visual_check");
    expect(out.coderTools).not.toContain("submit_visual_check");
    expect(out.request).toContain("Round 1 started");
    expect(out.request).toContain("Codex");
    expect(out.again).toContain("still running");
    expect(out.prWhileRunning).toContain("Not opened");
    expect(out.resolve).toContain("Not resolved");
    // The coder's skills include Myrel's own visual-check.
    expect(coder[0]!.prompt).toContain("- visual-check:");

    // The evaluator runs on the same computer with the other CLI, and its brief names the branch.
    await until(() => out.resubmit, "the evaluator's turn");
    expect(evaluator[0]!.start.cli).toBe("codex");
    expect(evaluator[0]!.prompt).toContain("feat/pricing");
    expect(evaluator[0]!.prompt).toContain("- visual-check:");
    expect(out.evaluatorTools).toContain("submit_visual_check");
    expect(out.evaluatorTools).not.toContain("request_visual_check");
    expect(out.missing).toContain("report.json is not in");
    expect(out.noEvidence).toContain("pricing-390-dark.png");
    expect(out.submit).toContain("Handed in: failed");
    expect(out.resubmit).toContain("already handed in");

    // The coder's card shows the result, and its next turn gets what to fix.
    const cards = async () =>
      (await projectAgent.getMessagesAfter(0, 500)).messages
        .filter((m: Message) => m.threadId === thread.id)
        .map((m: Message) => parseVisualCheck(m.body))
        .filter(Boolean);
    await until(async () => (await cards())[0]?.status === "failed", "the card to show the result");
    const [card] = await cards();
    expect(card).toMatchObject({ round: 1, status: "failed", evaluator: { cli: "codex", model: "gpt-5.5" }, vision: "passed" });
    expect(card!.blocking[0]).toMatchObject({ screen: "pricing@390-dark", evidence: `${card!.folder}/pricing-390-dark.png` });
    expect(card!.sheets).toEqual([`${card!.folder}/pricing.sheet.png`]);
    await until(() => coder.length === 2, "the coder's turn with the result");
    expect(coder[1]!.prompt).toContain("Visual check round 1 (codex / gpt-5.5): failed.");
    expect(coder[1]!.prompt).toContain("The Pro card overlaps the bottom bar.");
    expect(coder[1]!.prompt).toContain("call request_visual_check again");
    expect(renderMessage((await projectAgent.getMessagesAfter(0, 500)).messages.find((m: Message) => parseVisualCheck(m.body))!, {})).toContain(
      "(visual check card: round 1, failed",
    );
    close();
  });

  it("offers no visual check tool while the project's setting is off", { timeout: 30_000 }, async () => {
    const token = await signUp();
    const out: string[] = [];
    const { project, close } = await agentProject(token, async (turn) => {
      out.push((await toolNames(turn)).join(","));
      out.push(turn.prompt);
    });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Bir şey yap" });
    const thread = await projectAgent.createThread(root.id, "İş");
    await (await getAgentByName(env.THREAD_AGENT, thread.id)).start({ projectId: project.id, threadId: thread.id, brief: "Do it." });
    await until(() => out.length === 2, "the turn");
    expect(out[0]).not.toContain("visual_check");
    expect(out[1]).not.toContain("- visual-check:");
    close();
  });
});
