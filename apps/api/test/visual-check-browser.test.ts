import { parseVisualCheck, VISUAL_CHECK_DEPS_COMMAND } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { agentProject, api, closeRunners, signUp, until } from "./fake-agent";

afterEach(() => closeRunners());

describe("visual check on a computer without a browser", () => {
  it("is not started, a card and the agent get the one command, the round does not count, and Devices shows it", { timeout: 30_000 }, async () => {
    const token = await signUp();
    const out: string[] = [];
    const { project, runnerId } = await agentProject(
      token,
      async (turn) => {
        out.push((await turn.call("request_visual_check", { branch: "feat/x", what: "The home page." })).text);
        out.push((await turn.call("request_visual_check", { branch: "feat/x", what: "The home page." })).text);
      },
      { features: ["folders", "cancel", "agent", "agent-clis", "skills"], hello: { browser: { status: "missing-libs", missing: ["libnss3.so", "libgbm.so.1"] } } },
    );
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body: JSON.stringify({ visualCheck: true }) });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Ana sayfa" });
    const thread = await projectAgent.createThread(root.id, "Ana sayfa");
    await (await getAgentByName(env.THREAD_AGENT, thread.id)).start({ projectId: project.id, threadId: thread.id, brief: "Build the home page." });

    await until(() => out.length === 2, "the requests");
    expect(out[0]).toContain("Not started");
    expect(out[0]).toContain(VISUAL_CHECK_DEPS_COMMAND);
    expect(out[0]).toContain("libnss3.so");
    // No evaluator thread was opened.
    expect((await projectAgent.listThreads()).length).toBe(1);
    // Each try leaves a card with the command, and neither counts as a round.
    const cards = ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m) => parseVisualCheck(m.body)).filter((c) => !!c);
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c).toMatchObject({ status: "not_checked", round: 1, command: VISUAL_CHECK_DEPS_COMMAND });
      expect(c.note).toContain("libnss3.so");
    }

    const runners = (await (await api("/api/runners", { token })).json()) as { runners: { id: string; browser?: { status: string } }[] };
    expect(runners.runners.find((r) => r.id === runnerId)?.browser).toMatchObject({ status: "missing-libs" });
  });
});
