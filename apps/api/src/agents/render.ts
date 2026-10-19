import type { Message, Thread } from "@altair/protocol";

/** How a message's author reads in a prompt. */
export function authorLabel(m: Message, names: Record<string, string>): string {
  if (m.authorKind === "user") return `${names[m.authorId] ?? "Member"} (member)`;
  if (m.authorKind === "system") return "System notice";
  return "You (Altair)";
}

export function renderMessage(m: Message, names: Record<string, string>, opts: { isNew?: boolean } = {}): string {
  const head = `[${m.id}] ${authorLabel(m, names)} · ${m.createdAt}${opts.isNew ? " · NEW" : ""}`;
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
