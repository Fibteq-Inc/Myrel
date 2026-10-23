import {
  CLI_NAMES,
  type CliId,
  type Message,
  type MessageRelay,
  type Routine,
  type RunnerCli,
  type Thread,
  type ThreadCli,
  ThreadCloseReason,
  threadLink,
} from "@myrel/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeHost, type KnowledgeSnapshot, knowledgeTools, renderKnowledge } from "./knowledge";
import { authorLabel, renderMessage, renderThread } from "./render";
import { renderRoutine, ROUTINE_GUIDE } from "./routine-tools";

/** Something the coordinator has not seen yet. */
export type InboxItem =
  | { kind: "message"; messageId: string }
  /** actor: who the asking thread works for; a thread the coordinator opens on it works for them too. */
  | { kind: "request"; threadId: string; request: "permission" | "routing" | "handoff"; reason: string; actor?: string | null }
  /** A thread agent's choice card, waiting for the coordinator to answer it or pass it to people. */
  | { kind: "question"; threadId: string; questionId: string; question: string }
  /** A routine ran and posted its prompt in the project chat as messageId. */
  | { kind: "routine"; messageId: string; routineId: string; name: string }
  /** Someone wrote in a thread (a person's decision, or the thread agent's reply) while other threads are open. */
  | { kind: "thread"; threadId: string; messageId: string }
  /** A thread was resolved (by its agent, a person, or its pull requests settling) while other threads are open. */
  | { kind: "finished"; threadId: string };

/** Items the coordinator only looks at for links between threads; a turn with nothing else may only relay. */
export function onlyObserving(inbox: InboxItem[]): boolean {
  return inbox.length > 0 && inbox.every((i) => i.kind === "thread" || i.kind === "finished");
}

/** A thread that just finished, with how it ended and what the coordinator told open threads about it. */
export type FinishedThread = {
  thread: Thread;
  /** Its newest message with words in it: the agent's last reply, or the line saying its pull request merged. */
  last: Message | null;
  /** Briefs and notes in open threads that name it, newest last. */
  mentions: { threadId: string; note: string; createdAt: string }[];
};

/** A note the coordinator passed from one thread's work to another thread. */
export type Relay = { fromThreadId: string; toThreadId: string; note: string; createdAt: string };

/** The project operations the coordinator's tools act through. */
export type CoordinatorHost = {
  getMessage(id: string): Message | null;
  getThread(id: string): Thread | null;
  threadForRoot(messageId: string): Thread | null;
  /** relay: the note this line announces, which people can open under it. */
  post(body: string, relay?: MessageRelay): Message;
  react(messageId: string, emoji: string): void;
  startThread(input: {
    rootMessageId: string;
    title: string;
    brief: string;
    ack?: string;
    projectAck?: string;
    /** The CLI it runs with on the person's computer; absent: the project folder's. */
    cli?: ThreadCli;
  }): Promise<Thread>;
  /** A recent thread the same person opened with the same ask, if this message repeats one. */
  findDuplicate(messageId: string): Thread | null;
  /** Closes a thread opened by mistake. Throws when it already holds work only a person may set aside. */
  closeThread(threadId: string, input: { reason: ThreadCloseReason; duplicateOf?: string; note?: string }): Promise<Thread>;
  /** follow_up forwards a person's follow-up; reply answers the thread's request. */
  messageThread(threadId: string, note: string, kind: "follow_up" | "reply"): Promise<void>;
  /** Tell an open thread what another thread's work means for it. Throws when the relay would repeat or bounce. */
  relay(fromThreadId: string, toThreadId: string, note: string): Promise<void>;
  /** Answers a thread agent's choice card from what the project knows; it never reaches people. Throws when it is not open. */
  answerQuestion(questionId: string, answer: string, source: string): Promise<void>;
  /** Passes a thread agent's choice card to people, with an optional line of context. Throws when it is not open. */
  askPerson(questionId: string, note?: string): Promise<void>;
};

export const COORDINATOR_SYSTEM = `You are Myrel, the coordinator of a shared project chat. People post requests here; focused work happens in threads, each handled by its own thread agent. To people, you and every thread agent are one assistant called Myrel.

Your only job is routing. You never research, answer substantive questions, write content or do the work yourself, even when it looks quick. You decide where each message goes, and you keep the project chat calm.

For each new message in the project chat:
- A new ask (work, research, writing, a question that needs thought): call start_thread on that message. Give it a short title in the person's own words (a few words, not a sentence), a brief for the thread agent (the whole ask in your own words, every part of it: when one message asks for the same work in several places, such as two repositories or two apps, name each of them and never drop one; plus any context from the chat it needs, and the reasonable default you picked where the ask is unclear), a project_ack and an ack.
  - project_ack is the one line the person sees right under their message in the project chat, with the thread card under it. It only says, in a few natural words, that you got it and are starting ("Got it, starting now", "On it"). Word it differently each time, to fit the ask; it does not repeat the request or preview the work.
  - ack is the thread's opening line, saying what is being done first.
  - Do not also call post_message for it; project_ack is that post.
- A follow-up about an existing thread: call message_thread with the person's words and what they want, and a project_ack: one short line saying it went to that thread, with the thread written as a link people can tap to open it: [thread title](#thread_id), for example "Passed this on to the [Calculator](#thr_…) thread". A change to something a thread made or worked on ("make the calculator blue", "add a test to that fix") is a follow-up to that thread, even when the thread is resolved: message_thread reopens it, and that thread already has the files and the history. Start a new thread only for work no existing thread covers.
- The same ask sent again (a resend while the first thread is still starting, a double tap): it is not new work. start_thread refuses it and names the thread that already has it; send it there with message_thread as a follow-up, unless the person clearly wants the work done a second time.
- A thread you opened by mistake (a duplicate of another thread, or work another thread already covers, or an ask the person took back): call close_thread with the reason and one short line for the person, linking the thread that carries the work. Closing deletes nothing and writing in the thread reopens it. You may only close a thread that has made nothing yet (no pull request, artifact or routine, no messages from people); close_thread refuses the rest, and then the person decides.
- A question about the project itself that the chat and thread list already answer (what threads exist, what one is waiting on): answer it with post_message, briefly.
- A greeting or FYI with nothing to do: one short post_message, or a react.
- Thanks or a sign-off: react with an emoji and nothing else.
- People talking among themselves: do nothing.

Picking a CLI: a person can offer CLIs from their computer with their ask, shown under the message. When it offers several, start_thread needs cli (one of them) and cli_reason: one short sentence in the person's language saying why, which people see in the thread. Pick the one that suits the work and can work right now: skip a CLI whose limits are used up or nearly so (see "The computer's CLIs"), and otherwise prefer the first one offered. With one CLI offered, or none, leave cli out.

Several unrelated asks in one message: start a thread on that message for the first ask, with a project_ack. For each other ask, post one line naming it with post_message, then start a thread on that post (no project_ack needed; your post is the receipt).

${ROUTINE_GUIDE} A routine that targets the project chat posts its prompt there as a ⏰ notice when it runs; treat that notice as a new ask and start a thread on it. Creating, pausing and deleting routines is part of routing, so you do it yourself.

Requests from thread agents (permission, routing, handoff) arrive in your inbox. Answer each with message_thread: grant or refuse it, point the thread elsewhere, or, when only a person can decide (anything irreversible, spending, deleting, sending outside the project), tell the thread to ask the person in its thread. You never approve irreversible steps on a person's behalf.

Questions from thread agents: a thread agent's choice card comes to you before it reaches people, so people are only asked what the project does not already settle. Handle every one, with exactly one of:
- answer_question, only when something you can point to settles it: the project instructions, a memory note, a decision a person made in the project chat or in a thread (shown in what you see), or which thread owns a piece of work. Give the answer (usually one of the options, in the person's language) and the source in a few words, such as "proje talimatı", "memory: contact-address" or "İsmail'in Hermes thread'indeki seçimi". People see both in the thread.
- ask_person, for everything else: anything irreversible, spending, deleting or sending outside the project; taste and product choices nobody has made yet (design, names, prices, scope); and anything you are not sure of. Never guess, and never pick an option only because the agent recommends it. Add a note only when you know something that helps the person choose, such as a related earlier decision, in one sentence in their language.
When a person answers such a card in a way that sets a rule for the project ("always open a PR", "keep replies in Turkish"), save the rule in memory, so the same question is answered next time without them.

Keeping threads in step: threads work in parallel, and what one thread starts, decides or delivers can change another thread's work. Examples: a new feature that another thread has to account for (a thread for a new kind of connector means the thread on plan limits must count it), a rename or a new server address, a renamed shared package, a decision a person made in one thread that another thread is waiting for, two threads about to change the same file. When you see such a link, call relay_to_thread to tell the affected thread in one or two sentences what changed and what it means for its work; when two threads would change the same file, say which thread owns it. Check for links whenever you start a thread (does an open thread need to know about this new work?) and whenever "Thread updates" lists new messages from inside threads. Relay only when it changes the recipient's work: most updates need nothing, and then you call no tools. Never send a note listed under "Notes already relayed" again, and never pass a thread's answer to your note back to the thread it came from. A decision people made in a thread that the whole project should keep (a name, a price, a rule) also goes in memory. Thread updates never get a post in the project chat: people already saw them in the thread.

Threads finishing: a thread cannot see other threads, so when you tell one to wait for another thread ("write the guide once those threads are done"), you are the one who tells it when that happens. "Threads that just finished" lists every thread resolved since your last turn, also those resolved without a message (a merged pull request, a person closing it), with the briefs and notes that mention it in open threads. For each one, check whether an open thread waits on it or needs its result (a note or brief says so, or its plan or last messages do) and tell that thread with relay_to_thread that the work is finished and what it delivered. Never leave a thread waiting on work that is already done. When nothing waits on it, call no tools for it.

${KNOWLEDGE_GUIDE}
You only route, so you can list files but not read or write them; that is thread work. You do write memory when people tell you how they want the project to run (who to involve, what to keep quiet about, decisions). A thread's brief should mention the instructions, memory or files that matter for its work.

Language: everything people read (posts, thread titles, acks) is in the language of the message you are handling. When it is too short to tell (an emoji, "ok"), use the language of the chat so far. These instructions being in English never sets the language. Write the brief in the person's language too, so the thread agent continues in it.

People can open every brief and note you send a thread, folded under one line in the project chat and in the thread, to check what you passed on. Write them so a person reads them well too: full sentences, no ids beyond thread links.

Style: plain, warm, short sentences. No em dashes. Never show ids to people; ids are only for tool calls and inside a thread link [thread title](#thread_id), which people see as the title and can tap. Use a thread link whenever you name a thread in the project chat. Call a thread "thread" in every language (in Turkish "thread", never "dal" or "konu"). When there is nothing to do, call no tools.`;

export function coordinatorPrompt(input: {
  projectName: string;
  names: Record<string, string>;
  chat: Message[];
  threads: Thread[];
  routines: Routine[];
  inbox: InboxItem[];
  /** New messages inside threads, for the thread items in the inbox. */
  threadUpdates?: { thread: Thread; message: Message }[];
  /** Threads resolved since the last turn, for the finished items in the inbox. */
  finished?: FinishedThread[];
  relays?: Relay[];
  knowledge: KnowledgeSnapshot;
  now: Date;
  defaultTimezone: string;
  /** The CLIs on the computer of the project's local folder, for picking among offered ones. */
  computerClis?: RunnerCli[];
}): string {
  const newIds = new Set(input.inbox.flatMap((i) => (i.kind === "message" || i.kind === "routine" ? [i.messageId] : [])));
  const threadByRoot = new Map(input.threads.map((t) => [t.rootMessageId, t]));
  const chat = input.chat.map((m) => {
    const line = renderMessage(m, input.names, { isNew: newIds.has(m.id) });
    const thread = threadByRoot.get(m.id);
    if (thread) return `${line}\n    ↳ thread [${thread.id}] "${thread.title}"`;
    const offered = m.clis ?? [];
    if (!newIds.has(m.id) || offered.length === 0) return line;
    return offered.length === 1
      ? `${line}\n    ↳ runs with ${cliName(offered[0]!)} (picked by the person)`
      : `${line}\n    ↳ CLIs offered: ${offered.map((c) => `${cliName(c)} [${c}]`).join(", ")}; pick one with start_thread's cli and cli_reason`;
  });
  const choosing = input.chat.some((m) => newIds.has(m.id) && (m.clis?.length ?? 0) > 1);
  const requests = input.inbox.flatMap((i) =>
    i.kind === "request" ? [`- Thread [${i.threadId}] asks (${i.request}): ${i.reason}`] : [],
  );
  const titles = new Map(input.threads.map((t) => [t.id, t.title]));
  const questionItems = input.inbox.flatMap((i) => (i.kind === "question" ? [i] : []));
  const questions = questionItems.map(
    (q) => `- Question [${q.questionId}] from thread [${q.threadId}] "${titles.get(q.threadId) ?? ""}":\n${indent(q.question)}`,
  );
  const ran = input.inbox.flatMap((i) =>
    i.kind === "routine" ? [`- Routine [${i.routineId}] "${i.name}" ran and posted [${i.messageId}]`] : [],
  );
  const updates = (input.threadUpdates ?? []).map(
    ({ thread, message }) =>
      `- Thread [${thread.id}] "${thread.title}" · ${authorLabel(message, input.names)} · ${message.createdAt}\n${indent(clip(message.body, UPDATE_MAX))}`,
  );
  const finished = (input.finished ?? []).map(({ thread, last, mentions }) =>
    [
      `- Thread [${thread.id}] "${thread.title}" finished at ${thread.updatedAt}`,
      last ? `  Last message (${authorLabel(last, input.names)}):\n${indent(clip(last.body, UPDATE_MAX))}` : "",
      mentions.length
        ? `  Mentioned in open threads:\n${mentions.map((m) => `    - in [${m.threadId}] "${titles.get(m.threadId) ?? ""}" · ${m.createdAt}: ${clip(m.note.replace(/\s+/g, " "), MENTION_MAX)}`).join("\n")}`
        : "  No brief or note in an open thread mentions it; still check the open threads' plans.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const relays = (input.relays ?? []).map(
    (r) => `- ${r.createdAt}: "${titles.get(r.fromThreadId) ?? r.fromThreadId}" → "${titles.get(r.toThreadId) ?? r.toThreadId}": ${r.note}`,
  );
  const onlyThreadUpdates = onlyObserving(input.inbox);
  // Named again at the end, so a person's ask is not lost among thread updates in the same turn.
  const newChat = input.chat.filter((m) => newIds.has(m.id)).map((m) => m.id);
  const asked = questionItems.length
    ? ` Each question from a thread agent needs answer_question or ask_person: ${questionItems.map((q) => `[${q.questionId}]`).join(", ")}.`
    : "";

  return [
    `Project: ${input.projectName}\nCurrent time: ${input.now.toISOString()} (default time zone ${input.defaultTimezone})`,
    renderKnowledge(input.knowledge),
    `## Threads (open ones with their current plan)\n${input.threads.map(renderThreadWithPlan).join("\n") || "(none yet)"}`,
    `## Routines\n${input.routines.map(renderRoutine).join("\n") || "(none)"}`,
    choosing ? `## The computer's CLIs\n${(input.computerClis ?? []).map(renderCli).join("\n") || "(not reported)"}` : "",
    `## Project chat, oldest first (messages marked NEW arrived since your last turn)\n${chat.join("\n\n") || "(empty)"}`,
    requests.length ? `## Requests from thread agents\n${requests.join("\n")}` : "",
    questions.length
      ? `## Questions from thread agents (answer each with answer_question when something you can point to settles it, otherwise ask_person)\n${questions.join("\n")}`
      : "",
    ran.length ? `## Routines that just ran (start a thread on each post)\n${ran.join("\n")}` : "",
    updates.length ? `## Thread updates (NEW messages inside threads; people saw them there)\n${updates.join("\n\n")}` : "",
    finished.length
      ? `## Threads that just finished (tell every open thread that waits on one, with relay_to_thread)\n${finished.join("\n\n")}`
      : "",
    relays.length ? `## Notes already relayed between threads, newest last\n${relays.join("\n")}` : "",
    onlyThreadUpdates
      ? `Nothing new in the project chat. Relay only what changes another open thread's work${finished.length ? ", and tell threads waiting on a finished one that it is done" : ""}; otherwise call no tools.`
      : newChat.length
        ? `Handle everything new now with your tools. Each NEW project chat message needs its own handling, even when thread updates or requests arrived with it: ${newChat.map((id) => `[${id}]`).join(", ")}.${asked}`
        : `Handle everything new now with your tools.${asked}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** How much of a thread message the coordinator reads; enough to spot a decision or a result. */
const UPDATE_MAX = 1200;
/** How much of a brief or note naming a finished thread the coordinator reads. */
const MENTION_MAX = 600;
/** How much of an open thread's plan the coordinator reads. */
const PLAN_MAX = 300;

function renderThreadWithPlan(t: Thread): string {
  const line = renderThread(t);
  return !t.resolved && t.statusText ? `${line}\n${indent(clip(t.statusText, PLAN_MAX))}` : line;
}

function cliName(id: string): string {
  return CLI_NAMES[id as CliId] ?? id;
}

/** A CLI on the computer with its version and how much of its limits is used, as it last reported. */
export function renderCli(c: RunnerCli): string {
  const windows = (c.limits?.windows ?? [])
    .filter((w) => w.usedPercent !== null)
    .map((w) => `${w.kind} ${Math.round(w.usedPercent!)}% used${w.resetsAt ? ` (resets ${w.resetsAt})` : ""}`);
  const status = c.limits?.status === "limited" ? "LIMITED, refuses work until a reset" : c.limits?.status === "warning" ? "near its limit" : null;
  const limits = [status, ...windows].filter(Boolean).join("; ");
  return `- ${cliName(c.id)} [${c.id}]${c.version ? ` ${c.version}` : ""}: ${limits || "no limits reported"}`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/**
 * The coordinator's tools. A turn that only has thread updates to look at gets just
 * relay_to_thread and memory: it must not post in the project chat or start threads.
 */
export function coordinatorTools(
  host: CoordinatorHost,
  knowledge: KnowledgeHost,
  opts: { onlyThreadUpdates?: boolean } = {},
): Tool[] {
  const relay = tool({
    name: "relay_to_thread",
    description:
      "Tell an open thread's agent what another thread's new work, result or decision means for it. Only when it changes the recipient's work.",
    input: z.object({
      from_thread_id: z.string().describe("The thread whose work or decision this is about."),
      to_thread_id: z.string().describe("The open thread whose work it changes."),
      note: z
        .string()
        .min(1)
        .max(2000)
        .describe("One or two sentences: what changed and what it means for the recipient's work."),
    }),
    run: async ({ from_thread_id, to_thread_id, note }) => {
      await host.relay(from_thread_id, to_thread_id, note);
      return "Relayed.";
    },
  });
  // Routing needs memory and a view of the files, not file contents.
  const memory = knowledgeTools(knowledge).filter((t) => t.name.startsWith("memory_") || t.name === "list_files");
  if (opts.onlyThreadUpdates) return [...memory, relay];
  return [
    ...memory,
    relay,
    tool({
      name: "post_message",
      description: "Post a short message in the project chat, visible to every member.",
      input: z.object({ text: z.string().min(1).max(4000) }),
      run: ({ text }) => {
        const m = host.post(text);
        return `Posted ${m.id}.`;
      },
    }),
    tool({
      name: "start_thread",
      description:
        "Open a thread on a project-chat message and hand the work to a new thread agent. Use for every new ask.",
      input: z.object({
        message_id: z.string().describe("The project-chat message the thread hangs under, usually the person's ask."),
        title: z.string().min(1).max(80).describe("A few words naming what the thread is about."),
        instructions: z.string().min(1).max(8000).describe("The brief for the thread agent."),
        ack: z.string().max(400).optional().describe("One line posted as the thread's opening message."),
        allow_duplicate: z
          .boolean()
          .optional()
          .describe("Only when the person clearly asks for the same work again, as a separate thread."),
        project_ack: z
          .string()
          .max(200)
          .optional()
          .describe(
            "One short line posted in the project chat under the person's message, saying you got it and are starting. Required when the message is a person's.",
          ),
        cli: z.string().max(40).optional().describe("Only when the message offers several CLIs: the id of the one the thread runs with."),
        cli_reason: z
          .string()
          .max(300)
          .optional()
          .describe("With cli: one short sentence in the person's language on why this CLI, shown in the thread."),
      }),
      run: async ({ message_id, title, instructions, ack, project_ack, allow_duplicate, cli, cli_reason }) => {
        const root = host.getMessage(message_id);
        if (!root || root.threadId) throw new Error(`${message_id} is not a project-chat message.`);
        const existing = host.threadForRoot(message_id);
        if (existing) throw new Error(`That message already has thread ${existing.id}; use message_thread.`);
        const original = allow_duplicate ? null : host.findDuplicate(message_id);
        if (original) {
          throw new Error(
            `This repeats the ask behind thread ${original.id} "${original.title}" from a few minutes ago. Send it there with message_thread and a project_ack linking that thread; pass allow_duplicate only if the person wants the work done again.`,
          );
        }
        // A person's ask always gets a visible "on it" line, not just a card.
        const projectAck = project_ack?.trim() || undefined;
        if (root.authorKind === "user" && !projectAck) {
          throw new Error("Add project_ack: one short line telling the person you got their message and are starting.");
        }
        const threadCli = pickCli(root.clis ?? [], cli, cli_reason);
        const thread = await host.startThread({
          rootMessageId: message_id,
          title,
          brief: instructions,
          ack,
          projectAck,
          ...(threadCli && { cli: threadCli }),
        });
        return `Started thread ${thread.id}.`;
      },
    }),
    tool({
      name: "close_thread",
      description:
        "Close a thread you opened by mistake: a duplicate of another thread, work another thread covers, or an ask the person took back. Nothing is deleted, and writing in it reopens it.",
      input: z.object({
        thread_id: z.string(),
        reason: ThreadCloseReason.describe(
          "duplicate: the same ask as another thread. misrouted: another thread covers it. cancelled: the person took it back.",
        ),
        duplicate_of: z.string().optional().describe("The thread that carries the work, for duplicate and misrouted."),
        note: z
          .string()
          .min(1)
          .max(300)
          .describe(
            "One short line for the person, posted in the project chat and in the closed thread, e.g. \"Same ask as [Test PR](#thr_…); I kept that one.\"",
          ),
      }),
      run: async ({ thread_id, reason, duplicate_of, note }) => {
        const thread = await host.closeThread(thread_id, { reason, duplicateOf: duplicate_of, note });
        const original = duplicate_of ? host.getThread(duplicate_of) : null;
        // People should be one tap from the thread that carries the work.
        host.post(!original || note.includes(`(#${original.id})`) ? note : `${note} ${threadLink(original)}`);
        return `Closed ${thread.id}.`;
      },
    }),
    tool({
      name: "message_thread",
      description:
        "Send a note to a thread's agent: forward a follow-up, or answer its request. People can open the note under a one-line marker in the thread (and under project_ack).",
      input: z.object({
        thread_id: z.string(),
        note: z.string().min(1).max(8000),
        project_ack: z
          .string()
          .max(200)
          .optional()
          .describe(
            "When forwarding a person's follow-up: one short line posted in the project chat saying it went to that thread. Leave out when answering a thread's request.",
          ),
      }),
      run: async ({ thread_id, note, project_ack }) => {
        const thread = host.getThread(thread_id);
        if (!thread) throw new Error(`No thread ${thread_id}.`);
        const ack = project_ack?.trim();
        await host.messageThread(thread_id, note, ack ? "follow_up" : "reply");
        // People should be one tap from the thread their message went to, even when the model forgot the link.
        if (ack) {
          host.post(ack.includes(`(#${thread.id})`) ? ack : `${ack} ${threadLink(thread)}`, {
            kind: "follow_up",
            threadId: thread.id,
            note,
          });
        }
        return "Delivered.";
      },
    }),
    tool({
      name: "answer_question",
      description:
        "Answer a thread agent's question (from \"Questions from thread agents\") yourself, only when the project instructions, memory or a decision people already made settle it. People see your answer and its source in the thread.",
      input: z.object({
        question_id: z.string(),
        answer: z.string().min(1).max(300).describe("The answer, usually one of the options' labels, in the person's language."),
        source: z
          .string()
          .min(1)
          .max(200)
          .describe("Where it comes from, in a few words people can check: an instruction, a memory note, a person's earlier decision."),
      }),
      run: async ({ question_id, answer, source }) => {
        await host.answerQuestion(question_id, answer, source);
        return "Answered; the thread carries on with it.";
      },
    }),
    tool({
      name: "ask_person",
      description: "Pass a thread agent's question (from \"Questions from thread agents\") to people as its card in the thread.",
      input: z.object({
        question_id: z.string(),
        note: z
          .string()
          .max(300)
          .optional()
          .describe("Only when it helps the person choose: one sentence, in their language, such as a related earlier decision."),
      }),
      run: async ({ question_id, note }) => {
        await host.askPerson(question_id, note);
        return "Passed to the person.";
      },
    }),
    tool({
      name: "react",
      description: "Add an emoji reaction to a message, e.g. 👍 for thanks or an acknowledgement.",
      input: z.object({ message_id: z.string(), emoji: z.string().min(1).max(16) }),
      run: ({ message_id, emoji }) => {
        if (!host.getMessage(message_id)) throw new Error(`No message ${message_id}.`);
        host.react(message_id, emoji);
        return "Reacted.";
      },
    }),
  ];
}

/**
 * The CLI a new thread runs with, from the ones its ask offered: the only one, or the coordinator's
 * pick among several (which needs a reason people can read). None offered: the project folder's.
 */
export function pickCli(offered: string[], cli: string | undefined, reason: string | undefined): ThreadCli | null {
  if (offered.length === 0) return null;
  if (offered.length === 1) return { id: offered[0]!, options: offered, by: "person", reason: null };
  if (!cli || !offered.includes(cli)) {
    throw new Error(`This ask offers several CLIs (${offered.join(", ")}). Pass cli with one of them, and cli_reason.`);
  }
  const why = reason?.trim();
  if (!why) throw new Error("Add cli_reason: one short sentence, in the person's language, on why this CLI.");
  return { id: cli, options: offered, by: "coordinator", reason: why };
}
