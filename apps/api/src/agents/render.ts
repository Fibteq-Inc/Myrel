import { type Message, planChecklist, type Thread } from "@altair/protocol";

/** How a message's author reads in a prompt. */
export function authorLabel(m: Message, names: Record<string, string>): string {
  if (m.authorKind === "user") return `${names[m.authorId] ?? "Member"} (member)`;
  if (m.authorKind === "system") return m.authorId === "routine" ? "Routine run" : "System notice";
  return "You (Myrel)";
}

export function renderMessage(m: Message, names: Record<string, string>, opts: { isNew?: boolean } = {}): string {
  const head = `[${m.id}] ${authorLabel(m, names)} · ${m.createdAt}${opts.isNew ? " · NEW" : ""}`;
  // A plan card's steps are in the prompt's own plan section; its title is enough here.
  const plan = planChecklist(m.body);
  if (plan !== null) return `${head}\n${indent(`(plan card: ${plan.split("\n", 1)[0]})`)}`;
  const files = (m.attachments ?? []).map((a) => `📎 attached: ${a.path} (${a.contentType}, ${a.size} bytes)`);
  return `${head}\n${indent([m.body, ...files].filter(Boolean).join("\n"))}`;
}

export function renderThread(t: Thread): string {
  const state = t.resolved ? "resolved" : t.status;
  return `- [${t.id}] "${t.title}" · ${state} · started on ${t.rootMessageId}`;
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
