import { Agent, getAgentByName } from "agents";
import { listRepoFiles, readRepoFile } from "../github/files";
import { listProjectRepos } from "../github/store";
import { meteredForTurn } from "../usage";
import { projectProvider } from "../keys";
import { runLoop } from "../llm";
import { type Author, knowledgeTools } from "./knowledge";
import { THREAD_AGENT_ID, SYSTEM_ID } from "./names";
import type { ThreadWake } from "./project-agent";
import { type CoordinatorNote, THREAD_SYSTEM, threadPrompt, threadTools } from "./thread-worker";

const BY: Author = { kind: "agent", id: THREAD_AGENT_ID };

export type ThreadStart = { projectId: string; threadId: string; brief: string };

type NoteRow = { id: number; body: string; created_at: string; seen: number };

/**
 * One instance per thread (named by thread id). Runs the thread agent: each
 * wake queues a turn that reads the thread from the ProjectAgent, calls the
 * model and acts through reply / update_status / request_coordinator.
 * Messages themselves live in the ProjectAgent; this DO keeps the brief,
 * coordinator notes and a read cursor.
 */
export class ThreadAgent extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    )`;
  }

  /** Called by the ProjectAgent when the coordinator opens this thread. */
  async start(input: ThreadStart): Promise<void> {
    this.setMeta("project_id", input.projectId);
    this.setMeta("thread_id", input.threadId);
    this.setMeta("brief", input.brief);
    await this.markDirty();
  }

  /** A person wrote in the thread, or the coordinator sent a note. */
  async wake(reason: ThreadWake): Promise<void> {
    if (reason.kind === "coordinator") {
      this.sql`INSERT INTO notes (body, created_at) VALUES (${reason.note}, ${new Date().toISOString()})`;
    }
    await this.markDirty();
  }

  private async markDirty() {
    this.setMeta("dirty", "1");
    await this.queue("threadTurn", null);
  }

  /** Queue callback. Turns run one at a time; wakes during a turn get their own turn after it. */
  async threadTurn(): Promise<void> {
    if (this.getMeta("dirty") !== "1") return;
    this.setMeta("dirty", "0");
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;

    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const ctx = await project.getThreadContext(threadId);
    if (!ctx) return;

    const llm = await projectProvider(this.env, projectId);
    if (!llm.ok) {
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: llm.reason });
      await project.updateThread(threadId, { status: "failed" });
      return;
    }

    const noteRows = this.sql<NoteRow>`SELECT * FROM notes ORDER BY id`;
    const notes: CoordinatorNote[] = noteRows.map((n) => ({ body: n.body, createdAt: n.created_at, isNew: n.seen === 0 }));
    const lastSeenSeq = Number(this.getMeta("last_seen_seq") ?? 0);
    this.sql`UPDATE notes SET seen = 1`;
    this.setMeta("last_seen_seq", String(ctx.messages.at(-1)?.seq ?? lastSeenSeq));

    // Set from tool callbacks; typed wide so TS does not narrow them to `false`.
    let resolved: boolean = false as boolean;
    let asked: boolean = false as boolean;
    await project.updateThread(threadId, { status: "working" });
    await project.setActivity(threadId, true);
    try {
      // Bill the turn to the newest person in the thread, else whoever asked in the root message.
      const requester = [...ctx.messages].reverse().find((m) => m.authorKind === "user") ?? ctx.root;
      await runLoop({
        provider: meteredForTurn(llm.provider, this.env, {
          projectId,
          threadId,
          userId: requester.authorKind === "user" ? requester.authorId : null,
          agent: "thread",
        }),
        system: THREAD_SYSTEM,
        prompt: threadPrompt({
          ...ctx,
          brief: this.getMeta("brief") ?? "",
          lastSeenSeq,
          notes,
          repos: await listProjectRepos(this.env.DB, projectId),
        }),
        tools: [
          ...threadTools({
          reply: async (text) => {
            const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: text });
            // Our own replies are not news on the next turn.
            this.setMeta("last_seen_seq", String(m.seq));
            return m;
          },
          setStatusText: async (text) => {
            await project.updateThread(threadId, { statusText: text });
          },
          requestCoordinator: async (kind, reason) => {
            asked = true;
            await project.requestCoordinator(threadId, kind, reason);
          },
          resolve: async () => {
            resolved = true;
          },
          listRepoFiles: (repo, path, ref) => listRepoFiles(this.env, projectId, repo, path, ref),
          readRepoFile: (repo, path, ref) => readRepoFile(this.env, projectId, repo, path, ref),
          }),
          ...knowledgeTools({
            memoryRead: (name) => project.getMemory(name),
            memoryWrite: (name, description, content) => project.putMemory(name, { description, content }, BY),
            memoryDelete: (name) => project.deleteMemory(name),
            listFiles: (prefix) => project.listFiles(prefix),
            readText: (path) => project.readFileText(path),
            writeText: (path, content) => project.writeFileText(path, content, BY),
          }),
        ],
        maxSteps: 16,
      });
      await project.updateThread(threadId, {
        status: resolved ? "done" : asked ? "blocked" : "review_ready",
        resolved,
      });
    } catch (err) {
      console.error("thread turn failed", err);
      await project.sendMessage({
        threadId,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: `This thread's turn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await project.updateThread(threadId, { status: "failed" });
    } finally {
      await project.setActivity(threadId, false);
    }
  }

  private getMeta(key: string): string | null {
    const [row] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }
}
