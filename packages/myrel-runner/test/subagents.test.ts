import { describe, expect, it } from "vitest";
import { AppServerTurn } from "../src/app-server";
import { ADAPTERS, type ParseState } from "../src/clis";

const claude = (state: ParseState, event: object) => ADAPTERS.claude.line(JSON.stringify(event), state);

describe("Claude Code subagents", () => {
  it("tags a subagent's steps, notes its start and its answer, and keeps the turn's model", () => {
    const state: ParseState = {};
    claude(state, {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        model: "claude-opus-5-5",
        content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { subagent_type: "Explore", description: "Find the auth flow", prompt: "secret prompt" } }],
      },
    });
    expect(state.agentNotes).toEqual([{ text: "Find the auth flow", agent: { id: "tu1", label: "Explore", state: "started" } }]);
    expect(state.progress).toBeUndefined();

    claude(state, {
      type: "assistant",
      parent_tool_use_id: "tu1",
      message: { id: "m2", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: "tool_use", id: "x", name: "Grep", input: { pattern: "session" } }] },
    });
    expect(state.progress).toBe("Grep: session");
    expect(state.progressAgent).toEqual({ id: "tu1", label: "Explore" });
    expect(state.model).toBe("claude-opus-5-5");
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 2 });

    claude(state, {
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Auth lives in auth.ts" }] }] },
    });
    expect(state.agentNotes?.at(-1)).toMatchObject({
      text: "Auth lives in auth.ts",
      agent: { id: "tu1", label: "Explore", state: "done", model: "claude-haiku-5-5", tokens: 12 },
    });
    expect(state.agentNotes?.at(-1)?.ms).toBeGreaterThanOrEqual(0);

    claude(state, { type: "assistant", parent_tool_use_id: null, message: { id: "m3", content: [{ type: "text", text: "Done." }] } });
    expect(state.progress).toBe("Done.");
    expect(state.progressAgent).toBeUndefined();
  });

  it("ends a background subagent with its notification, not with the tool's result", () => {
    const state: ParseState = {};
    claude(state, {
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "tu2", name: "Task", input: { description: "Run tests", run_in_background: true } }] },
    });
    claude(state, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "Started in the background." }] } });
    expect(state.agentNotes).toHaveLength(1);
    claude(state, { type: "system", subtype: "task_notification", tool_use_id: "tu2", status: "failed", summary: "Tests failed" });
    expect(state.agentNotes?.at(-1)).toMatchObject({ text: "Tests failed", agent: { id: "tu2", label: "Agent", state: "failed" } });
  });
});

describe("Codex subagents", () => {
  function open() {
    const sent: Array<{ id?: number; method?: string }> = [];
    const state: ParseState = {};
    const t = new AppServerTurn(
      { write: (line) => sent.push(JSON.parse(line) as { id?: number; method?: string }), end: () => {} },
      { cwd: "/proj", prompt: "go", sandbox: "workspace-write", approvalPolicy: "never", clientVersion: "1" },
      state,
    );
    const feed = (m: object) => t.receive(JSON.stringify(m));
    const answer = (method: string, result: unknown) => feed({ id: sent.filter((m) => m.method === method).at(-1)!.id, result });
    t.start();
    answer("initialize", {});
    answer("thread/start", { thread: { id: "main" } });
    answer("turn/start", { turn: { id: "turn-1" } });
    const item = (threadId: string, method: string, item: object) => feed({ method, params: { threadId, turnId: "t", item } });
    return { state, feed, item };
  }

  it("notes spawned agents, tags their steps, counts their tokens and ends them from their states", () => {
    const { state, feed, item } = open();
    item("main", "item/completed", {
      type: "collabAgentToolCall",
      id: "c1",
      tool: "spawnAgent",
      senderThreadId: "main",
      receiverThreadIds: ["sub-1"],
      prompt: "Run the mobile tests\nand collect failures",
      model: "gpt-6-mini",
      agentsStates: {},
      status: "completed",
    });
    expect(state.agentNotes).toEqual([{ text: "Run the mobile tests", agent: { id: "sub-1", label: "Agent 1", state: "started" } }]);

    item("sub-1", "item/started", { type: "commandExecution", id: "e1", command: "pnpm test" });
    expect(state.progress).toBe("$ pnpm test");
    expect(state.progressAgent).toEqual({ id: "sub-1", label: "Agent 1" });
    item("sub-1", "item/completed", { type: "agentMessage", id: "m1", text: "2 failures" });
    expect(state.result).toBeUndefined();

    feed({ method: "thread/tokenUsage/updated", params: { threadId: "sub-1", tokenUsage: { last: { inputTokens: 50, outputTokens: 5 } } } });
    expect(state.usage).toEqual({ inputTokens: 50, outputTokens: 5 });

    // A subagent's turn ending does not end the agent's.
    feed({ method: "turn/completed", params: { threadId: "sub-1", turn: { id: "x", status: "failed" } } });
    expect(state.failed).toBeUndefined();

    item("main", "item/completed", {
      type: "collabAgentToolCall",
      id: "c2",
      tool: "wait",
      senderThreadId: "main",
      receiverThreadIds: ["sub-1"],
      agentsStates: { "sub-1": { status: "completed", message: "2 failures" } },
      status: "completed",
    });
    expect(state.agentNotes?.at(-1)).toMatchObject({ text: "2 failures", agent: { id: "sub-1", state: "done", model: "gpt-6-mini", tokens: 55 } });
    expect(state.agentNotes).toHaveLength(2);

    item("main", "item/started", { type: "commandExecution", id: "e2", command: "git status" });
    expect(state.progressAgent).toBeUndefined();
  });

  it("names an agent from its path when only its activity is seen", () => {
    const { state, item } = open();
    item("main", "item/completed", { type: "subAgentActivity", id: "a1", agentPath: "/root/explorer", agentThreadId: "sub-2", kind: "started" });
    item("main", "item/completed", { type: "subAgentActivity", id: "a2", agentPath: "/root/explorer", agentThreadId: "sub-2", kind: "interrupted" });
    expect(state.agentNotes?.map((n) => n.agent)).toEqual([
      { id: "sub-2", label: "explorer", state: "started" },
      { id: "sub-2", label: "explorer", state: "failed" },
    ]);
  });
});
