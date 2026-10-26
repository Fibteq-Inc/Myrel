import { type Message, parseConnectorSuggestion, parsePlanUpdate, planChecklist, type Thread } from "@myrel/protocol";

/** How a message's author reads in a prompt. */
export function authorLabel(m: Message, names: Record<string, string>): string {
  if (m.authorKind === "user") return `${names[m.authorId] ?? "Member"} (member)`;
  if (m.authorKind === "system") return m.authorId === "routine" ? "Routine run" : "System notice";
  return "You (Myrel)";
}

export function renderMessage(m: Message, names: Record<string, string>, opts: { isNew?: boolean } = {}): string {
  const edited = m.editedAt ? ` · edited ${m.editedAt}` : "";
  const head = `[${m.id}] ${authorLabel(m, names)} · ${m.createdAt}${edited}${opts.isNew ? " · NEW" : ""}`;
  // A plan card's steps are in the prompt's own plan section; its title is enough here.
  const plan = planChecklist(m.body);
  if (plan !== null) return `${head}\n${indent(`(plan card: ${plan.split("\n", 1)[0]})`)}`;
  if (parsePlanUpdate(m.body)) return `${head}\n${indent("(plan update note)")}`;
  const card = parseConnectorSuggestion(m.body);
  if (card) {
    const names = card.offers.map((o) => o.name).join(", ");
    const state =
      card.state === "connected"
        ? `connected ${card.offers.find((o) => o.id === card.connected)?.name ?? ""}`
        : card.state === "dismissed"
          ? "the person said not now"
          : "waiting for the person";
    const what = card.signIn ? `sign-in-again card for ${names}, whose sign-in ended` : `connector card offering ${names}`;
    return `${head}\n${indent(`(${what}: ${state})`)}`;
  }
  // The note itself is in the prompt already (the brief, or the coordinator's notes).
  if (m.relay) return `${head}\n${indent(`${m.body}\n(marker for a coordinator note people can open)`)}`;
  const files = (m.attachments ?? []).map((a) => `📎 attached: ${a.path} (${a.contentType}, ${a.size} bytes)`);
  return `${head}\n${indent([m.body, ...files].filter(Boolean).join("\n"))}`;
}

export function renderThread(t: Thread): string {
  const state = t.closeReason
    ? `closed (${t.closeReason}${t.duplicateOf ? ` of ${t.duplicateOf}` : ""})`
    : t.resolved
      ? "resolved"
      : t.status;
  return `- [${t.id}] "${t.title}" · ${state} · started on ${t.rootMessageId}`;
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
