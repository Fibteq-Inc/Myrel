import type { ConnectorOffer } from "@myrel/protocol";
import { z } from "zod";
import type { KnownState } from "../connectors/suggest";
import { type Tool, tool } from "../llm";

/**
 * The thread agent's tools for offering a connector it lacks: search the catalog, then put up to
 * three offers to the person as a card in the thread (see connector-suggestion.ts in protocol).
 * Connecting one writes a line in the thread for the person, which starts a new turn that has it.
 */
export type SuggestionHost = {
  search(q: string): Promise<ConnectorOffer[]>;
  find(ids: string[]): Promise<ConnectorOffer[]>;
  /** What the project and the person already have, by address. */
  known(): Promise<Map<string, KnownState>>;
  /** Offers the person turned down in this thread, by id and address. */
  declined(): Set<string>;
  /** Posts the card; returns false when one is already waiting for an answer. */
  post(reason: string, offers: ConnectorOffer[]): Promise<boolean>;
};

const KNOWN_TEXT: Record<KnownState, string> = {
  on: "already connected: its tools are yours this turn",
  off_in_project: "the person has it, but it is off in this project (offering it turns it on)",
  needs_sign_in: "added, but its sign-in expired (offering it asks the person to sign in again)",
};

export function suggestionTools(host: SuggestionHost): Tool[] {
  return [
    tool({
      name: "search_connectors",
      description:
        "Searches the connectors people can add (remote MCP servers from Myrel's catalog) for a service the work needs, e.g. \"cloudflare\" or \"linear\". Returns ids for suggest_connectors.",
      input: z.object({ query: z.string().trim().min(1).max(100).describe("The service or what it is for, in English.") }),
      run: async ({ query }) => {
        const [offers, known] = await Promise.all([host.search(query), host.known()]);
        if (!offers.length) return `No connector in the catalog matches "${query}". Try the service's own name, or carry on without one.`;
        const declined = host.declined();
        return offers
          .map((o) => {
            const notes = [
              o.featured && "Fibteq's own",
              o.auth === "headers" && `needs ${o.headerHint?.name ?? "a key"}`,
              known.get(o.url) && KNOWN_TEXT[known.get(o.url)!],
              (declined.has(o.id) || declined.has(o.url)) && "the person turned it down in this thread: do not offer it",
            ].filter(Boolean);
            return `- ${o.id}: ${o.name}. ${o.description}${notes.length ? ` (${notes.join("; ")})` : ""}`;
          })
          .join("\n");
      },
    }),
    tool({
      name: "suggest_connectors",
      description:
        "Offers the person one to three connectors from search_connectors as a card in the thread; they connect one with a click. Then reply briefly with what it is for and end your turn: a new turn starts with its tools once it is connected.",
      input: z.object({
        ids: z.array(z.string().min(1).max(200)).min(1).max(3).describe("Ids from search_connectors, best first."),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .describe("One sentence, in the person's language, on what you would do with it, e.g. \"Cloudflare'de DNS kaydını senin yerine eklemek için\"."),
      }),
      run: async ({ ids, reason }) => {
        const declined = host.declined();
        const [found, known] = await Promise.all([host.find([...new Set(ids)]), host.known()]);
        if (!found.length) return "None of those ids is in the catalog. Use ids exactly as search_connectors gives them.";
        const turnedDown = found.filter((o) => declined.has(o.id) || declined.has(o.url));
        const on = found.filter((o) => known.get(o.url) === "on");
        const offers = found.filter((o) => !turnedDown.includes(o) && !on.includes(o));
        if (!offers.length) {
          if (on.length) return `${on.map((o) => o.name).join(", ")} is already connected: use its tools. If you do not see them, its connection may need a new turn; say so in your reply.`;
          return `The person turned down ${turnedDown.map((o) => o.name).join(", ")} in this thread. Do not offer it again; carry on without it, or say what they would need to do by hand.`;
        }
        if (!(await host.post(reason, offers))) {
          return "A connector card is already waiting for the person's answer in this thread. Do not post another; end your turn with a short reply.";
        }
        const skipped = turnedDown.length ? ` Left out, as the person turned them down: ${turnedDown.map((o) => o.name).join(", ")}.` : "";
        return `The card is in the thread.${skipped} Now reply in a sentence or two on what the connector is for (do not list the options again), and end your turn. When the person connects it, a new turn starts with its tools; if they say not now, carry on without it.`;
      },
    }),
  ];
}
