import { ulid } from "ulid";

export const ID_PREFIXES = {
  message: "cmsg",
  thread: "thr",
  project: "proj",
  usage: "use",
  apiKey: "key",
  invite: "inv",
  runner: "rnr",
  task: "task",
  artifact: "art",
  routine: "rtn",
  notification: "ntf",
  connector: "mcp",
  skill: "skl",
  suggestion: "sug",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function createId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

/** Prefixed ULID: `<prefix>_` followed by 26 Crockford base32 characters. */
export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`);
}
