import { type Message, parseConnectorSuggestion, parsePlanUpdate, parseResearch, parseVisualCheck, planChecklist, type Thread } from "@myrel/protocol";

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
  // A visual check's card: its findings reach the thread as a note, so the state is enough here.
  const check = parseVisualCheck(m.body);
  if (check) {
    const by = check.evaluator ? `, judged by ${check.evaluator.cli} / ${check.evaluator.model}` : "";
    return `${head}\n${indent(`(visual check card: round ${check.round}, ${check.status}${by}${check.summary ? `, result in ${check.summary}` : ""})`)}`;
  }
  // A research's card: its report reaches the thread as a note when it ends, so the state is enough here.
  const research = parseResearch(m.body);
  if (research) {
    const end = research.partial ? ` (${research.partial})` : "";
    const cents = (c: number) => (c / 100).toFixed(2);
    return `${head}\n${indent(`(research card "${research.title}": ${research.status}${end}, ${cents(research.spentCents)} of ${cents(research.budgetCents)} USD${research.report ? `, report in ${research.report}` : ""})`)}`;
  }
  // The note itself is in the prompt already (the brief, or the coordinator's notes).
  if (m.relay) return `${head}\n${indent(`${m.body}\n(marker for a coordinator note people can open)`)}`;
  const files = (m.attachments ?? []).map((a) => `📎 attached: ${a.path} (${a.contentType}, ${a.size} bytes)`);
  // A tap on one of several cards answers that card only, so the prompt names it.
  const body = m.pick ? `(picked on the card "${m.pick.question ?? ""}" in [${m.pick.messageId}]) ${m.body}` : m.body;
  return `${head}\n${indent([body, ...files].filter(Boolean).join("\n"))}`;
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
