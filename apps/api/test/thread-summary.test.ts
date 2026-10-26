import { createId, formatPlan, type MessageStats } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stats = (inputTokens: number, costMicros: number | null): MessageStats => ({
  model: "m",
  durationMs: 1000,
  calls: 1,
  inputTokens,
  cachedInputTokens: 0,
  outputTokens: 10,
  costMicros,
  runtime: "cloud",
});

describe("thread summary", () => {
  it("keeps a thread's replies, usage and plan card as its messages come and change", async () => {
    const agent = await getAgentByName(env.PROJECT_AGENT, createId("project"));
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "do it" });
    const thread = await agent.createThread(root.id, "Work");
    expect(thread.summary).toEqual({ replies: 0, usage: null, planMessageId: null });

    const plan = await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: formatPlan("Work\n✱ one") });
    await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: "Starting.", stats: stats(90, 500) });
    const reply = await agent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: "u", body: "ok" });
    expect((await agent.getThread(thread.id))!.summary).toEqual({
      replies: 2,
      usage: { tokens: 100, durationMs: 1000, costMicros: 500 },
      planMessageId: plan.id,
    });

    // Usage reported after the message was sent counts too; an unknown price makes the cost unknown.
    await agent.setMessageStats(reply.id, stats(40, null));
    expect((await agent.getThread(thread.id))!.summary?.usage).toEqual({ tokens: 150, durationMs: 2000, costMicros: null });

    // The project chat's own messages are not part of any thread.
    await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "elsewhere" });
    const [listed] = await agent.listThreads();
    expect(listed!.summary?.replies).toBe(2);
  });
});
