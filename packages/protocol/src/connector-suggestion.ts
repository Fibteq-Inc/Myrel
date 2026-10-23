import { z } from "zod";

/**
 * A thread agent that needs a service it cannot reach offers connectors for it as a card in the
 * thread: the person connects one with a click (signing in when it asks) and the agent carries on
 * with it, or says not now. The card travels as a message body holding a fenced ```connectors
 * block of JSON; Myrel edits that message as the card is answered.
 */
export const ConnectorOffer = z.object({
  /** A catalog entry's registry name ("com.cloudflare.mcp/mcp"), or "preset:<id>" for Myrel's own. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  url: z.string().max(2000),
  /** "headers": the server needs a key, which the card asks for; "oauth": it signs in, or needs nothing. */
  auth: z.enum(["oauth", "headers"]),
  headerHint: z.object({ name: z.string(), placeholder: z.string() }).nullable().default(null),
  /** Only for Myrel's presets and the official servers (see OFFICIAL_CATALOG). */
  iconUrl: z.string().nullable().default(null),
  /** One of the official servers (OFFICIAL_CATALOG). */
  official: z.boolean().default(false),
  /** One of Fibteq's own presets. */
  featured: z.boolean().default(false),
});
export type ConnectorOffer = z.infer<typeof ConnectorOffer>;

/** open: waiting for the person. connected: one of its offers was connected. dismissed: not now. */
export const ConnectorSuggestionState = z.enum(["open", "connected", "dismissed"]);
export type ConnectorSuggestionState = z.infer<typeof ConnectorSuggestionState>;

export const ConnectorSuggestion = z.object({
  id: z.string(),
  /** Why the agent needs it, in the person's language. */
  reason: z.string().min(1).max(400),
  offers: z.array(ConnectorOffer).min(1).max(3),
  state: ConnectorSuggestionState.default("open"),
  /** The offer that was connected. */
  connected: z.string().optional(),
});
export type ConnectorSuggestion = z.infer<typeof ConnectorSuggestion>;
export type ConnectorSuggestionInput = z.input<typeof ConnectorSuggestion>;

export const CONNECTORS_LANG = "connectors";

/** The message body for a connector suggestion card. */
export function formatConnectorSuggestion(suggestion: ConnectorSuggestionInput): string {
  return "```" + CONNECTORS_LANG + "\n" + JSON.stringify(ConnectorSuggestion.parse(suggestion), null, 2) + "\n```";
}

/** The suggestion a card's body carries, or null when the body is not one. */
export function parseConnectorSuggestion(body: string): ConnectorSuggestion | null {
  const m = /^```connectors\n([\s\S]*)\n```$/.exec(body.trim());
  if (!m) return null;
  try {
    const result = ConnectorSuggestion.safeParse(JSON.parse(m[1]!));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Connecting one of a card's offers. `headers` answers an offer that needs a key. */
export const ConnectSuggestionInput = z.object({
  offerId: z.string().min(1).max(200),
  headers: z.record(z.string().regex(/^[A-Za-z_][\w-]{0,99}$/), z.string().min(1).max(4000)).optional(),
});
export type ConnectSuggestionInput = z.infer<typeof ConnectSuggestionInput>;

/** authorizeUrl: open it to sign in; the sign-in comes back to the thread. Otherwise it is connected. */
export const ConnectSuggestionResult = z.object({ authorizeUrl: z.string().optional(), connected: z.boolean() });
export type ConnectSuggestionResult = z.infer<typeof ConnectSuggestionResult>;
