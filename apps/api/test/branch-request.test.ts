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

describe("branch card", () => {
  it("closes the thread's own pull request without asking and deletes its branch on a tap, without a turn", { timeout: 30_000 }, async () => {
    const token = await signUp();
    await connectGithub(token);
    const results: string[] = [];
    const prompts: string[] = [];
    const { project, close } = await agentProject(token, async (turn, index) => {
      prompts.push(turn.prompt);
      if (index !== 0) return;
      const opened = (await turn.call("open_pull_request", { repo: "acme/app", head: "myrel/try-a", title: "Try A" })).text;
      const url = opened.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)![0];
      results.push((await turn.call("close_pull_request", { url, reason: "B yolu seçildi.", delete_branch: true })).text);
    });
    await api(`/api/projects/${project.id}/repos`, { method: "POST", token, body: JSON.stringify({ installationId: 42, repoId: 7 }) });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Deneme PR'ını kapatır mısın?" });
    const thread = await projectAgent.createThread(root.id, "Deneme");
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Close the try." });
    const messages = async () => (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === thread.id);

    await until(() => results.length === 1, "the close");
    expect(results[0]).toContain("is closed without merging");
    expect(results[0]).toContain("A card asks the person");
    const card = (await messages()).find((m) => m.authorKind === "agent" && m.body.includes("```decision"));
    expect(card!.body).toContain("`myrel/try-a` dalı da silinsin mi?");
    expect(fakeGithub.branches["acme/app#myrel/try-a"]?.deleted).toBeUndefined();
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the turn to end");

    const m = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body: "Dalı sil" });
    await threadAgent.wake({ kind: "message", messageId: m.id, body: m.body, authorId: me, seq: m.seq });
    await until(async () => (await messages()).some((x) => x.authorKind === "system" && x.body === "`myrel/try-a` dalı GitHub'da silindi."), "the line");
    expect(fakeGithub.branches["acme/app#myrel/try-a"]?.deleted).toBe(true);
    // Answering the card started no turn.
    expect(prompts).toHaveLength(1);
    close();
  });
});
