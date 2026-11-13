import type { Message } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { researchBudgetAnswer, researchPath, researchStartAnswer, usd } from "../src/research/research";
import { agentProject, api, mcp, signUp, until } from "./fake-agent";

/**
 * A tiny Claude Managed Agents for tests: agents, environments and sessions in memory, the
 * requests recorded. A session's state is what the test sets next (status, stop reason, spend).
 */
const fakeClaude = {
  requests: [] as { method: string; path: string; body: Record<string, unknown> | undefined; key: string | null }[],
  agents: [] as Record<string, unknown>[],
  environments: [] as Record<string, unknown>[],
  session: null as null | {
    id: string;
    status: "running" | "idle" | "terminated";
    stop: string;
    spent: string;
    budget: string;
    report: string | null;
    metadata: Record<string, string>;
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.anthropic.com" || !/^\/v1\/(agents|environments|sessions)/.test(url.pathname)) return realFetch(input, init);
  const method = init?.method ?? request?.method ?? "GET";
  const raw = init?.body ?? (request ? await request.text() : undefined);
  const body = raw ? (JSON.parse(raw as string) as Record<string, unknown>) : undefined;
  const key = new Headers(init?.headers ?? request?.headers).get("x-api-key");
  fakeClaude.requests.push({ method, path: `${url.pathname}${url.search}`, body, key });
  const page = (data: unknown[]) => Response.json({ data, next_page: null });
  if (url.pathname === "/v1/agents") {
    if (method === "GET") return page(fakeClaude.agents);
    const agent = { id: `agent_${fakeClaude.agents.length + 1}`, version: 1, archived_at: null, ...body };
    fakeClaude.agents.push(agent);
    return Response.json(agent);
  }
  if (url.pathname === "/v1/environments") {
    if (method === "GET") return page(fakeClaude.environments);
    const environment = { id: `env_${fakeClaude.environments.length + 1}`, archived_at: null, ...body };
    fakeClaude.environments.push(environment);
    return Response.json(environment);
  }
  if (url.pathname === "/v1/sessions" && method === "POST") {
    const budget = (body!.budget as { max_list_cost: { amount: string } }).max_list_cost.amount;
    fakeClaude.session = { id: "sesn_1", status: "running", stop: "end_turn", spent: "0", budget, report: null, metadata: body!.metadata as Record<string, string> };
    return Response.json({ id: "sesn_1", status: "running" });
  }
  const s = fakeClaude.session!;
  const usage = { list_cost: { amount: s.spent, currency: "USD" } };
  if (url.pathname === "/v1/sessions/sesn_1") {
    if (method === "POST") s.budget = (body!.budget as { max_list_cost: { amount: string } }).max_list_cost.amount;
    return Response.json({ id: s.id, status: s.status, usage, budget: { type: "limit", max_list_cost: { amount: s.budget, currency: "USD" } } });
  }
  if (url.pathname === "/v1/sessions/sesn_1/events") {
    const types = url.searchParams.getAll("types[]").concat(url.searchParams.getAll("types"));
    if (types.includes("session.status_idle")) {
      return page([{ id: "sevt_idle", type: "session.status_idle", processed_at: "", stop_reason: { type: s.stop }, stop_details: null }]);
    }
    if (types.includes("agent.message")) {
      return page(s.report ? [{ id: "sevt_msg", type: "agent.message", processed_at: "", content: [{ type: "text", text: s.report }] }] : []);
    }
    return page([]);
  }
  return Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 });
}) as typeof fetch;

async function addAnthropicKey(token: string) {
  const res = await api("/api/account/keys", {
    method: "POST",
    token,
    body: JSON.stringify({ provider: "anthropic", label: "API kredisi", key: "sk-ant-api03-test-key", scope: "user" }),
  });
  expect(res.status).toBeLessThan(300);
}

describe("research", () => {
  it("matches the cards' labels in either language and names the report's file", () => {
    expect(usd(1000, "tr")).toBe("10,00 USD");
    expect(researchStartAnswer("Araştırmayı başlat", 1000)).toBe("start");
    expect(researchStartAnswer("Start the research", 1000)).toBe("start");
    expect(researchStartAnswer("Başlatma", 1000)).toBe("skip");
    expect(researchBudgetAnswer("10,00 USD ekle", 1000)).toBe("raise");
    expect(researchBudgetAnswer("Add 5.00 USD", 500)).toBe("raise");
    expect(researchBudgetAnswer("Olanla bitir", 1000)).toBe("finish");
    expect(researchPath("Rakip fiyatları: Özet & Şartlar", new Date("2026-11-13T10:00:00Z"), "tr")).toBe("arastirmalar/2026-11-13-rakip-fiyatlari-ozet-sartlar.md");
  });

  it("asks first, runs on the approver's own key with a budget, and wakes the thread with the report", { timeout: 60_000 }, async () => {
    const token = await signUp();
    const prompts: string[] = [];
    const results: string[] = [];
    const listed: string[][] = [];
    const started = new Set<string>();
    const { project, close } = await agentProject(token, async (turn) => {
      prompts.push(turn.prompt);
      const tools = (await (await mcp(turn.start, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
      listed.push(tools.result.tools.map((t) => t.name));
      // The first turn of each thread asks for the research.
      if (started.has(turn.threadId)) return;
      started.add(turn.threadId);
      try {
        const out = await turn.call("start_research", {
          title: "Rakip fiyatları",
          question: "Türkiye'de ekip sohbet uygulamalarının 2026 fiyatlarını ve ücretsiz plan sınırlarını karşılaştır.",
          why: "Fiyatlandırma sayfası için güncel rakamlar lazım.",
        });
        results.push(`${out.isError ? "error: " : ""}${out.text}`);
      } catch (err) {
        // A tool that is not offered is an MCP error, not a result.
        results.push(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const messages = async (threadId: string) => (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === threadId);

    // Without anyone's Anthropic key, the tool is not offered.
    const root0 = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Rakipleri araştırır mısın?" });
    const thread0 = await projectAgent.createThread(root0.id, "Rakipler");
    await (await getAgentByName(env.THREAD_AGENT, thread0.id)).start({ projectId: project.id, threadId: thread0.id, brief: "Research competitors." });
    await until(() => results.length === 1, "the first turn");
    expect(listed[0]).not.toContain("start_research");
    expect(results[0]).toMatch(/^error: /);
    await until(async () => (await projectAgent.getThread(thread0.id))?.status !== "working", "the first turn to end");

    await addAnthropicKey(token);
    prompts.length = 0;
    results.length = 0;
    listed.length = 0;
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Rakip fiyatlarını araştırır mısın?" });
    const thread = await projectAgent.createThread(root.id, "Fiyatlar");
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Research competitor prices." });

    await until(() => results.length === 1, "the research call");
    expect(listed[0]).toContain("start_research");
    expect(results[0]).toContain("A card asks people");
    const card = (await messages(thread.id)).find((m) => m.authorKind === "agent" && m.body.includes("```decision"));
    expect(card!.body).toContain("Araştırmayı başlat");
    expect(card!.body).toContain("> Türkiye'de ekip sohbet uygulamalarının 2026 fiyatlarını");
    expect(card!.body).toContain("10,00 USD");
    // Nothing went to Anthropic before someone said so.
    expect(fakeClaude.requests).toHaveLength(0);
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the turn to end");

    // The tap starts it on the tapper's own key, without a turn.
    const tap = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body: "Araştırmayı başlat" });
    await threadAgent.wake({ kind: "message", messageId: tap.id, body: tap.body, authorId: me, seq: tap.seq });
    await until(() => fakeClaude.session, "the session");
    const created = fakeClaude.requests.find((r) => r.method === "POST" && r.path === "/v1/sessions")!;
    expect(created.key).toBe("sk-ant-api03-test-key");
    expect(created.body!.budget).toEqual({ type: "limit", max_list_cost: { amount: "1000", currency: "USD" } });
    expect(JSON.stringify(created.body!.initial_events)).toContain("ücretsiz plan sınırlarını");
    const agentMade = fakeClaude.requests.find((r) => r.method === "POST" && r.path === "/v1/agents")!;
    expect(JSON.stringify(agentMade.body!.tools)).toContain('"web_search"');
    expect(prompts).toHaveLength(1);
    const line = await until(async () => (await messages(thread.id)).find((m) => m.authorKind === "system" && m.body.startsWith("Claude araştırıyor")), "the status line");
    expect(line.body).toContain("0,00 USD / 10,00 USD");
    const researchId = fakeClaude.session!.metadata.myrel_research!;

    // It reaches its budget: a card asks whether to go on, and the approver adds as much again.
    fakeClaude.session!.status = "idle";
    fakeClaude.session!.stop = "budget_reached";
    fakeClaude.session!.spent = "1003";
    await threadAgent.researchPoll({ id: researchId });
    const budgetCard = await until(async () => (await messages(thread.id)).find((m) => m.body.includes("bütçesine ulaştı")), "the budget card");
    expect(budgetCard.body).toContain("10,00 USD ekle");
    const raise = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body: "10,00 USD ekle" });
    await threadAgent.wake({ kind: "message", messageId: raise.id, body: raise.body, authorId: me, seq: raise.seq });
    await until(() => fakeClaude.session!.budget === "2000", "the budget raised");

    // It finishes: the report goes to the project files and wakes the thread.
    fakeClaude.session!.stop = "end_turn";
    fakeClaude.session!.spent = "1450";
    fakeClaude.session!.report = "## Kısa cevap\n\nSlack ve Teams ücretli; [kaynak](https://example.com/pricing).";
    await threadAgent.researchPoll({ id: researchId });
    await until(() => prompts.length === 2, "the turn with the report");
    expect(prompts[1]).toContain('source="claude-research"');
    expect(prompts[1]).toContain("Slack ve Teams ücretli");
    const done = await until(async () => (await messages(thread.id)).find((m) => m.id === line.id && m.body.startsWith("Araştırma bitti")), "the line edited");
    const path = done.body.match(/\]\(([^)]+\.md)\)/)![1]!;
    expect(path).toMatch(/^arastirmalar\/\d{4}-\d\d-\d\d-rakip-fiyatlari\.md$/);
    expect(done.body).toContain("14,50 USD");
    const file = await projectAgent.readFileText(path);
    expect(file.text).toContain("Slack ve Teams ücretli");
    expect(file.text).toContain("> Türkiye'de ekip sohbet");
    close();
  });
});
