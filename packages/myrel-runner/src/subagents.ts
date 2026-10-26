import type { LineAgent } from "@myrel/protocol";
import type { ParseState } from "./clis";

/** A subagent the thread's agent started this run (Claude Code's Agent tool, a Codex spawned agent). */
export type SubAgent = {
  label: string;
  started: number;
  /** Runs on after the tool that started it returned (Claude Code's run_in_background): it ends with its notification. */
  background?: boolean;
  done?: boolean;
};

/** A subagent starting or ending: a line of its own, sent as soon as it is seen. */
export type AgentNote = { text: string; agent: LineAgent; ms?: number };

const MAX_AGENTS = 100;

/** The latest step, from the agent itself or (agentId) one of its subagents. */
export function step(state: ParseState, text: string, agentId?: string): void {
  state.progress = text;
  const agent = agentId && tag(state, agentId);
  if (agent) state.progressAgent = agent;
  else delete state.progressAgent;
}

/** Notes a subagent starting, with what it is for. Seen twice (a later event naming it again), it starts once. */
export function startAgent(state: ParseState, id: string, label: string, purpose = "", opts: { background?: boolean } = {}): void {
  const agents = (state.agents ??= new Map());
  if (agents.has(id) || agents.size >= MAX_AGENTS) return;
  const name = label.trim().slice(0, 100) || `Agent ${agents.size + 1}`;
  agents.set(id, { label: name, started: Date.now(), ...(opts.background && { background: true }) });
  (state.agentNotes ??= []).push({ text: firstLine(purpose), agent: { id, label: name, state: "started" } });
}

/** Notes a subagent ending, with the start of its answer and how long it ran. Only its first ending counts. */
export function endAgent(state: ParseState, id: string, ok: boolean, answer = ""): void {
  const agent = state.agents?.get(id);
  if (!agent || agent.done) return;
  agent.done = true;
  const note = { text: answer.trim().slice(0, 2000), agent: { id, label: agent.label, state: ok ? "done" : "failed" }, ms: Date.now() - agent.started } as const;
  (state.agentNotes ??= []).push(note);
}

/** The tag for a subagent's lines; one not seen starting yet is started now, unnamed. */
function tag(state: ParseState, id: string): LineAgent | undefined {
  if (!state.agents?.has(id)) startAgent(state, id, "");
  const agent = state.agents?.get(id);
  return agent && { id, label: agent.label };
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}
