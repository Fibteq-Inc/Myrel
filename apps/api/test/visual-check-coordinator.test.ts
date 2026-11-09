import { formatVisualCheck, type Thread, type VisualCheckCard } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { COORDINATOR_SYSTEM, checkSummary, coordinatorPrompt, type FinishedThread } from "../src/agents/coordinator";
import { changeRisk, uncheckedNote } from "../src/checks/risk";
import { agentProject, api, closeRunners, signUp, until } from "./fake-agent";
import { fakeGithub } from "./fake-github";

afterEach(() => closeRunners());

describe("which checks a change calls for", () => {
  it("tells files people see from the rest, and flows worth walking", () => {
    const risk = changeRisk([
      "apps/web/src/components/LoginForm.tsx",
      "apps/web/src/components/AuthorCard.tsx",
      "apps/web/src/components/button.ts",
      "apps/web/src/styles.css",
      "src/pages/sign-in.vue",
      "game/scenes/level.tscn",
      "apps/api/src/routes/projects.ts",
      "apps/api/src/agents/thread-agent.ts",
      "apps/web/src/components/__tests__/LoginForm.test.tsx",
      "apps/web/src/components/Button.stories.tsx",
      "README.md",
      "packages/i18n/src/locales/tr.ts",
    ]);
    expect(risk.seen).toEqual([
      "apps/web/src/components/LoginForm.tsx",
      "apps/web/src/components/AuthorCard.tsx",
      "apps/web/src/components/button.ts",
      "apps/web/src/styles.css",
      "src/pages/sign-in.vue",
      "game/scenes/level.tscn",
    ]);
    expect(risk.flows).toEqual(["apps/web/src/components/LoginForm.tsx", "src/pages/sign-in.vue"]);
    expect(risk.copy).toEqual(["packages/i18n/src/locales/tr.ts"]);
  });

  it("reminds only when something people see changed, and asks to walk a flow", () => {
    expect(uncheckedNote([{ pr: "acme/app#1", risk: changeRisk(["src/server.ts", "docs/setup.md"]) }])).toBeNull();
    const note = uncheckedNote([
      { pr: "acme/app#1", risk: changeRisk(["src/server.ts"]) },
      { pr: "acme/app#2", risk: changeRisk(["src/pages/checkout.tsx", "src/app.css"]) },
    ])!;
    expect(note).toContain("acme/app#2 changes what people see (src/pages/checkout.tsx, src/app.css)");
    expect(note).not.toContain("acme/app#1");
    expect(note).toContain("request_visual_check");
    expect(note).toContain("list that flow's steps");
    expect(uncheckedNote([{ pr: "acme/app#3", risk: changeRisk(["locales/en.json"]) }])).toContain("only the words people read");
  });
});

describe("the coordinator", () => {
  const card = (over: Partial<VisualCheckCard>): VisualCheckCard => ({
    id: "chk_1",
    round: 2,
    status: "failed",
    evaluatorThreadId: null,
    folder: "checks/chk_1/2",
    blocking: [{ n: 1, screen: "home@390-light", problem: "Cut off.", evidence: "home-390-light.png" }],
    sheets: [],
    diffs: [],
    ...over,
  });

  it("reads how a finished thread's visual check ended", () => {
    expect(checkSummary(card({}))).toBe("round 2 needs fixes (1 finding)");
    expect(checkSummary(card({ acceptedBy: "İsmail" }))).toBe("round 2 needs fixes (1 finding), accepted as it is by İsmail");
    expect(checkSummary(card({ status: "passed", round: 1, blocking: [] }))).toBe("round 1 passed");
    expect(checkSummary(card({ status: "not_checked", note: "No browser." }))).toBe("round 2 could not check: No browser.");

    const thread = { id: "thr_1", title: "Pricing page", updatedAt: "2026-11-09T08:00:00.000Z", resolved: true } as Thread;
    const prompt = coordinatorPrompt({
      projectName: "Myrel",
      names: {},
      chat: [],
      threads: [thread],
      routines: [],
      inbox: [{ kind: "finished", threadId: thread.id }],
      finished: [{ thread, last: null, mentions: [], check: card({}) }],
      knowledge: { instructions: "", memoryIndex: "", memory: [], files: [], moreFiles: 0 },
      now: new Date(),
      defaultTimezone: "UTC",
    });
    expect(prompt).toContain(`- Thread [thr_1] "Pricing page" finished at 2026-11-09T08:00:00.000Z\n  Visual check: round 2 needs fixes (1 finding)`);
    expect(COORDINATOR_SYSTEM).toContain("while a standing goal runs count it as work left");
  });
});

async function connectGithub(token: string) {
  const start = await api(`/api/github/connect?returnTo=${encodeURIComponent("/")}`, { token, redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await api(`/api/github/callback?code=good-code&installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`, { token, redirect: "manual" });
}

describe("resolving work that changed what people see", () => {
  it("is held once when no visual check ran, and goes through the second time", { timeout: 30_000 }, async () => {
    const token = await signUp();
    await connectGithub(token);
    const n = 700_000 + Math.floor(Math.random() * 1e5);
    const url = `https://github.com/acme/app/pull/${n}`;
    fakeGithub.pulls[`acme/app#${n}`] = {
      number: n,
      html_url: url,
      title: "Login page",
      state: "open",
      draft: false,
      merged: false,
      head: { sha: `sha-${n}`, ref: "myrel/login" },
      base: { ref: "main" },
      mergeable: true,
      changed_files: 2,
    };
    fakeGithub.pullFiles[`acme/app#${n}`] = [
      { filename: "apps/web/src/routes/login.tsx", status: "modified", additions: 10, deletions: 2 },
      { filename: "apps/api/src/auth.ts", status: "modified", additions: 3, deletions: 1 },
    ];
    const out: string[] = [];
    const { project } = await agentProject(
      token,
      async (turn, index) => {
        if (index !== 0) return;
        out.push((await turn.call("track_pull_request", { url })).text);
        out.push((await turn.call("resolve_thread")).text);
        out.push((await turn.call("resolve_thread")).text);
      },
      { features: ["folders", "cancel", "agent", "agent-clis", "skills"] },
    );
    await api(`/api/projects/${project.id}/repos`, { method: "POST", token, body: JSON.stringify({ installationId: 42, repoId: 7 }) });
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body: JSON.stringify({ visualCheck: true }) });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Giriş sayfası" });
    const thread = await projectAgent.createThread(root.id, "Giriş sayfası");
    await (await getAgentByName(env.THREAD_AGENT, thread.id)).start({ projectId: project.id, threadId: thread.id, brief: "Build the login page." });

    await until(() => out.length === 3, "the calls");
    expect(out[0]).toContain("Following");
    expect(out[1]).toContain(`Not resolved yet: acme/app#${n} changes what people see (apps/web/src/routes/login.tsx)`);
    expect(out[1]).toContain("list that flow's steps");
    expect(out[2]).not.toContain("Not resolved");
    await until(async () => (await projectAgent.getThread(thread.id))?.resolved === true, "the thread to resolve");

    // The coordinator sees the thread's last check round with it.
    const finished = () =>
      runInDurableObject(projectAgent as unknown as DurableObjectStub, (instance) =>
        (instance as unknown as { finishedThreads(inbox: unknown[]): FinishedThread[] }).finishedThreads([{ kind: "finished", threadId: thread.id }]),
      );
    expect((await finished())[0]?.check).toBeNull();
    const round: VisualCheckCard = { id: "chk_x", round: 1, status: "passed", evaluatorThreadId: null, folder: "checks/chk_x/1", blocking: [], sheets: [], diffs: [] };
    await projectAgent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "thread-agent", body: formatVisualCheck(round) });
    await projectAgent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "thread-agent", body: formatVisualCheck({ ...round, round: 2, status: "failed", acceptedBy: "İsmail" }) });
    await projectAgent.updateThread(thread.id, { resolved: true });
    expect((await finished())[0]?.check).toMatchObject({ round: 2, status: "failed", acceptedBy: "İsmail" });
  });
});
