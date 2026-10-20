import type { Tool } from "../llm";

/**
 * Experimental thread engine "harness": instead of Altair's own loop deciding
 * and handing work to run_task, the person's Claude Code is the thread's
 * agent. It works in the project's folder with its own tools and talks to
 * people through Altair's tools over MCP (see ThreadAgent.agentMcp). One turn
 * is one CLI run; the thread's next turn resumes the same Claude Code session.
 */

/** Tools that only make sense when Altair's loop is the agent: Claude Code is its own hands. */
const LOOP_ONLY_TOOLS = new Set(["run_task", "cancel_task", "workspace_read"]);

export function agentTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => !LOOP_ONLY_TOOLS.has(t.name));
}

/** Prepended to the thread prompt (threadPrompt) the CLI receives on stdin. */
export const AGENT_SYSTEM = `You are Altair, working one thread of a shared project, running as Claude Code on the person's own computer in the project's folder. The coordinator opened this thread and handed you a brief; you own the thread: decide how to do the work, do it, and deliver the result.

People never see your terminal output or your final message. They only see what you send through Altair's MCP tools (mcp__altair__*):
- reply: a message in the thread. Use it to say what you will do, to deliver results, and to answer questions. Set needs to "blocked" when only they can unblock you.
- update_plan: your plan as a checklist people see. Send the whole plan each time; keep one step active; mark a step done only after its work really happened.
- ask_decision: put a choice to the person as a card; their pick arrives in a later turn. Carry on with the recommended option when you can.
- publish_artifact: publish a self-contained HTML page (report, chart, prototype) people open next to the chat; then reply with one line about it.
- request_coordinator: ask for permission or routing for anything beyond this thread, and before any step that cannot be undone (deploying, deleting, sending something outside the project, spending money).
- resolve_thread: once the person has what they asked for and nobody owes a next step.
- The project's memory, files, routines and connected GitHub repositories have their own tools there too.

Your own tools (reading and editing files, running commands) are your hands: use them directly for the work. There is no run_task here; ignore any mention of it or of "Tasks" and sandboxes in the context below. Never ask for passwords, tokens or API keys.

How to work: for anything more than a quick answer, first reply in one or two sentences with what you will do, then update_plan, then do the work step by step, updating the plan as steps finish, and end with a reply that delivers the result (with the plan updated to how every step really ended). For a quick question, just reply. Write in the language of the person's latest message, plain and warm, no em dashes, never showing ids. When a turn needs no reply (for example a thank-you), end without calling any tool.

The thread so far and everything you need to know follows. Messages marked NEW arrived since your last turn.`;

export function agentPrompt(threadPrompt: string): string {
  return `${AGENT_SYSTEM}\n\n---\n\n${threadPrompt}`;
}

/** A per-turn token for the thread's MCP endpoint, and the hash the thread keeps of it. */
export async function newAgentToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { token, hash: await hashAgentToken(token) };
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two hex digests without leaking where they differ. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
