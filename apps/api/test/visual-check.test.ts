import { type Message, parseVisualCheck, type RunnerCli } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { pickEvaluatorCli, resolveEvaluator } from "../src/checks/loop";
import { judgeCheck, type CheckReport, type CheckVerdict } from "../src/checks/verdict";
import { builtinBundle, builtinSkill } from "../src/skills/builtin";
import { BUILTIN_SKILL_FILES } from "../src/skills/builtin.gen";
import { renderMessage } from "../src/agents/render";
import { signFileLink } from "../src/agents/knowledge";
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

  it("fails on an acceptance criterion not met, from the evaluator or a flow's expect step", async () => {
    // The evaluator's own: with its screenshot it becomes a finding, without one it is sent back.
    const said = await judgeCheck(await report(), verdict({ acceptance: [{ criterion: "Three plans show", met: false, evidence: "pricing-1440-light.png" }] }), has("pricing-1440-light.png"));
    expect(said.ok && said.check.verdict).toBe("fail");
    expect(said.ok && said.check.blocking).toEqual([{ id: "acceptance", screen: "pricing-1440-light.png", evidence: "pricing-1440-light.png", problem: "Not met: Three plans show" }]);
    const bare = await judgeCheck(await report(), verdict({ acceptance: [{ criterion: "Three plans show", met: false }] }), has());
    expect(!bare.ok && bare.problems[0]).toContain("give it the screenshot");

    // A flow's: its expect step failed and nobody dismissed it, so "met" does not stand.
    const step = { id: "expect-failed", severity: "blocking" as const, screen: "sign-in@1440-light", file: "sign-in-1440-light.png", message: "Not met: A wrong password shows an error (expected …)" };
    const flows = {
      ...(await report([step])),
      criteria: [
        { criterion: "A wrong password shows an error", screen: "sign-in", met: false, evidence: "sign-in-1440-light.png", failedOn: ["sign-in@1440-light"] },
        { criterion: "The right password signs in", screen: "sign-in", met: true, evidence: "sign-in-1440-light.png", failedOn: [] },
      ],
    };
    const r = await judgeCheck(flows, verdict({ acceptance: [{ criterion: "A wrong password shows an error", met: true }] }), has("sign-in-1440-light.png"));
    expect(r.ok && r.check.verdict).toBe("fail");
    expect(r.ok && r.check.acceptance).toEqual([
      { criterion: "A wrong password shows an error", met: false, evidence: "sign-in-1440-light.png" },
      { criterion: "The right password signs in", met: true, evidence: "sign-in-1440-light.png" },
    ]);
    // The failed step is its finding already; no second one for the same criterion.
    expect(r.ok && r.check.blocking.map((b) => b.id)).toEqual(["expect-failed"]);
    // Dismissed as a wrong step: the evaluator's word on the criterion stands.
    const dismissed = await judgeCheck(
      flows,
      verdict({ dismissed: [{ id: "expect-failed", screen: "sign-in", reason: "The selector changed name; the error shows" }], acceptance: [{ criterion: "A wrong password shows an error", met: true }] }),
      has(),
    );
    expect(dismissed.ok && dismissed.check.verdict).toBe("pass");
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

describe("evaluator setting", () => {
  const clis: RunnerCli[] = [
    { id: "claude", version: "2.1.0", models: [{ id: "opus", name: "Opus", efforts: ["low", "high"] }, { id: "sonnet", name: "Sonnet", efforts: [] }] },
    { id: "codex", version: "0.164.0", models: [{ id: "gpt-5.5", name: "GPT-5.5", efforts: ["medium", "high"] }] },
    { id: "opencode", version: "2.0.0", limits: { status: "limited", windows: [], at: "2026-11-08T20:00:00.000Z" } },
  ];
  const pick = (model: string | null = null, effort: string | null = null) => ({ model, effort });
  const base = { clis, othersAllowed: true };

  it("picks a listed CLI other than the coder's, with that CLI's model and effort", () => {
    const list = { claude: pick("opus", "high"), codex: pick("gpt-5.5", "high") };
    expect(resolveEvaluator({ ...base, project: list, account: {}, coderCli: "claude" })).toMatchObject({
      cli: "codex",
      model: { cli: "codex", model: "gpt-5.5", effort: "high" },
      source: "project",
    });
    expect(resolveEvaluator({ ...base, project: list, account: {}, coderCli: "codex" })).toMatchObject({
      cli: "claude",
      model: { cli: "claude", model: "opus", effort: "high" },
    });
  });

  it("uses the coder's own CLI when it is the only listed one, and skips one at its limit", () => {
    expect(resolveEvaluator({ ...base, project: { claude: pick() }, account: {}, coderCli: "claude" })).toMatchObject({ cli: "claude", model: null });
    expect(resolveEvaluator({ ...base, project: { opencode: pick(), claude: pick() }, account: {}, coderCli: "claude" })).toMatchObject({ cli: "claude" });
  });

  it("follows the project's list, else the person's own, else any other CLI", () => {
    expect(resolveEvaluator({ ...base, project: {}, account: { codex: pick() }, coderCli: "codex" })).toMatchObject({ cli: "codex", source: "account" });
    expect(resolveEvaluator({ ...base, project: {}, account: {}, coderCli: "claude" })).toMatchObject({ cli: "codex", source: "auto" });
    const r = resolveEvaluator({ ...base, project: { cursor: pick() }, account: { claude: pick("sonnet", "high") }, coderCli: "codex" });
    expect(r).toMatchObject({ cli: "claude", model: { cli: "claude", model: "sonnet", effort: null }, source: "account" });
    expect(r.skipped).toContain("cursor");
    expect(resolveEvaluator({ ...base, project: { claude: pick("gone") }, account: {}, coderCli: "codex" }).model).toBeNull();
    // A runner too old to run other CLIs only takes Claude Code.
    expect(resolveEvaluator({ ...base, othersAllowed: false, project: { codex: pick() }, account: {}, coderCli: "claude" })).toMatchObject({
      cli: "claude",
      source: "auto",
    });
  });

  it("puts the CLI asked for one check first, keeping only the model and effort it lists", () => {
    const project = { claude: { model: "opus", effort: "high", account: "work" } };
    expect(resolveEvaluator({ ...base, once: { cli: "claude", model: "sonnet" }, project, account: {}, coderCli: "codex" })).toEqual({
      cli: "claude",
      model: { cli: "claude", model: "sonnet", effort: null },
      account: "work",
      source: "request",
    });
    // Even the coder's own CLI, when that is what was asked for.
    expect(resolveEvaluator({ ...base, once: { cli: "codex" }, project, account: {}, coderCli: "codex" })).toMatchObject({ cli: "codex", model: null, source: "request" });
    const loose = resolveEvaluator({ ...base, once: { cli: "codex", model: "gpt-9", effort: "max" }, project, account: {}, coderCli: "claude" });
    expect(loose).toMatchObject({ cli: "codex", model: null, source: "request" });
    expect(loose.skipped).toContain("gpt-9");
    expect(loose.skipped).toContain("max");
    // A CLI not on this computer falls to the settings.
    const away = resolveEvaluator({ ...base, once: { cli: "cursor" }, project, account: {}, coderCli: "codex" });
    expect(away).toMatchObject({ cli: "claude", source: "project" });
    expect(away.skipped).toContain("cursor");
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

describe("folder links", () => {
  it("take a whole results folder in one go and list a folder's files, and nothing outside it", async () => {
    const token = await signUp();
    const created = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Links" }) });
    const { project } = (await created.json()) as { project: { id: string } };
    const base = "http://myrel.test";
    // The tests' BETTER_AUTH_SECRET is a binding of vitest.config.ts, not in the generated Env.
    const secret = env as unknown as { BETTER_AUTH_SECRET: string };
    const put = await signFileLink(secret, base, { projectId: project.id, path: "checks/chk_1/1", mode: "put-folder", by: "thread-agent" });
    const send = (name: string) => api(`${put.slice(base.length)}&name=${encodeURIComponent(name)}`, { method: "PUT", body: "png", headers: { "content-type": "image/png" } });
    expect((await send("home-390-light.png")).status).toBe(200);
    expect((await send("annotated/home-390-light.png")).status).toBe(200);
    expect((await send("../escape.png")).status).toBe(403);
    expect((await send("a/b/c.png")).status).toBe(403);
    // A plain file link does not take names.
    const single = await signFileLink(secret, base, { projectId: project.id, path: "checks/chk_1/1", mode: "put", by: "thread-agent" });
    expect((await api(`${single.slice(base.length)}&name=x.png`, { method: "PUT", body: "png" })).status).toBe(403);

    const list = await signFileLink(secret, base, { projectId: project.id, path: "checks/chk_1/1", mode: "get-folder", by: "thread-agent" });
    const res = await api(`${list.slice(base.length)}&list=1`);
    const { files } = (await res.json()) as { files: { name: string; url: string }[] };
    expect(files.map((f) => f.name).sort()).toEqual(["annotated/home-390-light.png", "home-390-light.png"]);
    expect((await api(files[0]!.url.slice(base.length))).status).toBe(200);
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
              blocking: [
                {
                  screen: "pricing@390-dark",
                  evidence: "pricing-390-dark.png",
                  problem: "The Pro card overlaps the bottom bar.",
                  expected: "The card ends above it.",
                  image: "annotated/pricing-390-dark.png",
                },
              ],
              acceptance: [{ criterion: "Three plans side by side", met: true, evidence: "pricing.sheet.png" }],
            }),
          ),
          by,
        );
        out.noEvidence = (await turn.call("submit_visual_check", { check_id: id })).text;
        await projectAgent.writeFileText(`${folder}/pricing-390-dark.png`, "png", by);
        await projectAgent.writeFileText(`${folder}/pricing.sheet.png`, "png", by);
        await projectAgent.writeFileText(`${folder}/annotated/pricing-390-dark.png`, "png", by);
        await projectAgent.writeFileText(`${folder}/pricing-390-dark.diff.png`, "png", by);
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
    // The pull request does not wait for the check (İsmail, 2026-11-08); resolving does.
    expect(out.prWhileRunning).not.toContain("Not opened");
    expect(out.resolve).toContain("Not resolved");
    // The coder's skills include Myrel's own visual-check.
    expect(coder[0]!.prompt).toContain("- visual-check:");

    // The evaluator runs on the same computer with the other CLI, and its brief names the branch.
    await until(() => out.resubmit, "the evaluator's turn");
    expect(evaluator[0]!.start.cli).toBe("codex");
    expect(evaluator[0]!.prompt).toContain("feat/pricing");
    expect(evaluator[0]!.prompt).toContain("- visual-check:");
    expect(out.evaluatorTools).toContain("submit_visual_check");
    expect(out.evaluatorTools).toContain("visual_check_links");
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
    // The finding is numbered and shown framed on its screenshot; what changed against the approved look is listed.
    expect(card!.blocking[0]).toMatchObject({ n: 1, image: `${card!.folder}/annotated/pricing-390-dark.png` });
    expect(card!.acceptance).toEqual([{ criterion: "Three plans side by side", met: true }]);
    expect(card!.diffs).toEqual([`${card!.folder}/pricing-390-dark.diff.png`]);
    // The evaluator shows under the thread it checks, with the verdict on its row.
    const evaluatorThread = await projectAgent.getThread(evaluator[0]!.threadId);
    expect(evaluatorThread).toMatchObject({ parentId: thread.id, label: "check:failed" });
    await until(() => coder.length === 2, "the coder's turn with the result");
    expect(coder[1]!.prompt).toContain("Visual check round 1 (codex / gpt-5.5): failed.");
    expect(coder[1]!.prompt).toContain("The Pro card overlaps the bottom bar.");
    expect(coder[1]!.prompt).toContain("call request_visual_check again");
    expect(renderMessage((await projectAgent.getMessagesAfter(0, 500)).messages.find((m: Message) => parseVisualCheck(m.body))!, {})).toContain(
      "(visual check card: round 1, failed",
    );

    // From the card: the person approves its screenshots as the reference look, then accepts the round as it is.
    const action = (what: string) => api(`/api/projects/${project.id}/threads/${thread.id}/visual-checks/${card!.id}/${what}`, { method: "POST", token, body: "{}" });
    expect((await action("baseline")).status).toBe(204);
    const baseline = (await projectAgent.listFiles("checks/baseline/")).map((f: { path: string }) => f.path);
    expect(baseline).toEqual(["checks/baseline/pricing-390-dark.png"]);
    expect((await action("accept")).status).toBe(204);
    await until(async () => (await cards())[0]?.acceptedBy, "the card to say who accepted");
    expect((await cards())[0]).toMatchObject({ acceptedBy: "İsmail", baselineBy: "İsmail" });
    await until(() => coder.length === 3, "the coder's turn after the person accepted");
    expect(coder[2]!.prompt).toContain("accepted visual check round 1 as it is");
    expect((await action("nonsense")).status).toBe(404);
    close();
  });

  it("starts the evaluator with the person's own setting, and the project's wins over it", { timeout: 60_000 }, async () => {
    const token = await signUp();
    const evaluators: Turn[] = [];
    const requests: string[] = [];
    let coderThread = "";
    // The first evaluator hands in only once the test has changed the project's setting.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { project } = await agentProject(
      token,
      async (turn) => {
        if (turn.threadId === coderThread) {
          requests.push((await turn.call("request_visual_check", { branch: "feat/x", what: "The home page." })).text);
          return;
        }
        evaluators.push(turn);
        if (evaluators.length === 1) await gate;
        const id = /Check id: (chk_\w+)/.exec(turn.prompt)![1]!;
        await turn.call("submit_visual_check", { check_id: id, could_not_check: "No browser here." });
      },
      { features: ["folders", "cancel", "agent", "agent-clis", "skills"], cli: "claude", clis: ["codex"] },
    );
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body: JSON.stringify({ visualCheck: true }) });
    const mine = await api("/api/account/check-models", { method: "PUT", token, body: JSON.stringify({ checkModels: { claude: { model: null, effort: null } } }) });
    expect(mine.status).toBe(200);
    const me = (await (await api("/api/account", { token })).json()) as { user: { id: string; checkModels: unknown } };
    expect(me.user.checkModels).toEqual({ claude: { model: null, effort: null } });
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me.user.id, body: "Ana sayfa" });
    const thread = await projectAgent.createThread(root.id, "Ana sayfa");
    coderThread = thread.id;
    await (await getAgentByName(env.THREAD_AGENT, thread.id)).start({ projectId: project.id, threadId: thread.id, brief: "Build the home page." });

    // The person lists only Claude Code: it judges, even though the work is Claude Code's too.
    await until(() => evaluators.length === 1, "the first evaluator");
    expect(evaluators[0]!.start.cli).toBe("claude");
    expect(evaluators[0]!.prompt).toContain("You run as Claude Code with its default model");
    expect(requests[0]).toContain("Round 1 started");

    // The project's list wins over it, and of its two Myrel takes the one that did not make the change.
    const set = await api(`/api/projects/${project.id}/settings`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ checkModels: { claude: { model: null, effort: null }, codex: { model: null, effort: null } } }),
    });
    expect(Object.keys(((await set.json()) as { settings: { checkModels: object } }).settings.checkModels)).toEqual(["claude", "codex"]);
    open();
    await until(() => evaluators.length === 2, "the second round's evaluator");
    expect(requests[1]).toContain("Round 2 started");
    expect(evaluators[1]!.start.cli).toBe("codex");
    expect((await projectAgent.getThread(evaluators[1]!.threadId))?.cli).toMatchObject({ id: "codex", reason: expect.stringContaining("project") });
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
