import type { Message } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentProject, api, signUp, until } from "./fake-agent";
import { fakeGithub } from "./fake-github";

/** The GitHub connect round trip, the way a browser does it. */
async function connectGithub(token: string) {
  const start = await api(`/api/github/connect?returnTo=${encodeURIComponent("/")}`, { token, redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await api(`/api/github/callback?code=good-code&installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`, { token, redirect: "manual" });
}

describe("repository card", () => {
  it("asks for a repository the project has not connected, connects it on a tap and wakes the agent", { timeout: 30_000 }, async () => {
    const token = await signUp();
    const results: string[] = [];
    const prompts: string[] = [];
    const { project, close } = await agentProject(token, async (turn, index) => {
      prompts.push(turn.prompt);
      if (index === 0) {
        results.push((await turn.call("open_pull_request", { repo: "acme/app", head: "myrel/x", title: "x" })).text);
        results.push((await turn.call("request_repo_connection", { repo: "acme/app", reason: "PR'ı açabilmem için repoya erişmem gerekiyor." })).text);
        results.push((await turn.call("request_repo_connection", { repo: "acme/app", reason: "Again" })).text);
        return;
      }
      results.push((await turn.call("request_repo_connection", { repo: "acme/app", reason: "Again" })).text);
    });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Test PR'ı aç" });
    const thread = await projectAgent.createThread(root.id, "Test PR");
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Open a test PR." });
    const messages = async () => (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === thread.id);
    const cards = async () => (await messages()).filter((m) => m.authorKind === "agent" && m.body.includes("```decision"));
    const answer = async (body: string) => {
      const m = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body });
      await threadAgent.wake({ kind: "message", messageId: m.id, body, authorId: me, seq: m.seq });
    };

    await until(() => results.length >= 3, "the first turn's calls");
    expect(results[0]).toContain("request_repo_connection");
    expect(results[1]).toContain("The card is in the thread");
    expect(results[2]).toContain("already waiting");
    const [card] = await cards();
    expect(card!.body).toContain("acme/app bu projeye bağlı değil");
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the first turn to end");

    // No GitHub sign-in yet: a new card says how to give access, and no turn starts for it.
    await answer("Repoyu bağla");
    await until(async () => (await cards()).length === 2, "the card to sign in to GitHub first");
    expect((await cards())[1]!.body).toContain("/api/github/connect?returnTo=");
    expect(prompts).toHaveLength(1);

    // Signed in to GitHub: the next tap connects it, and the agent carries on with it connected.
    await connectGithub(token);
    await answer("Repoyu bağla");
    await until(() => prompts.length === 2, "the turn after connecting");
    const repos = (await (await api(`/api/projects/${project.id}/repos`, { token })).json()) as { repos: { fullName: string }[] };
    expect(repos.repos.map((r) => r.fullName)).toEqual(["acme/app"]);
    expect((await messages()).some((m) => m.authorKind === "system" && m.body === "acme/app projeye bağlandı.")).toBe(true);
    await until(() => results.length === 4, "the second turn's call");
    expect(results[3]).toContain("already connected");
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the second turn to end");
    close();
  });

  it("does not connect a repository the person cannot reach on GitHub", { timeout: 30_000 }, async () => {
    fakeGithub.userRepos = [8];
    try {
      const token = await signUp();
      await connectGithub(token);
      const { project, close } = await agentProject(token, async (turn, index) => {
        if (index === 0) await turn.call("request_repo_connection", { repo: "acme/app", reason: "PR için." });
      });
      const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
      const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
      const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "PR aç" });
      const thread = await projectAgent.createThread(root.id, "PR");
      const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
      await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Open a PR." });
      const cards = async () =>
        (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === thread.id && m.body.includes("```decision"));
      await until(async () => (await cards()).length === 1, "the card");
      await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the turn to end");
      const m = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body: "Repoyu bağla" });
      await threadAgent.wake({ kind: "message", messageId: m.id, body: m.body, authorId: me, seq: m.seq });
      await until(async () => (await cards()).length === 2, "the card about the installation");
      expect((await cards())[1]!.body).toContain("acme/app reposuna erişemiyor");
      const repos = (await (await api(`/api/projects/${project.id}/repos`, { token })).json()) as { repos: unknown[] };
      expect(repos.repos).toEqual([]);
      close();
    } finally {
      fakeGithub.userRepos = [7, 8];
    }
  });
});
