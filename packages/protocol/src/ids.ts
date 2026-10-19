import { ulid } from "ulid";

export const ID_PREFIXES = {
  message: "cmsg",
  thread: "thr",
  project: "proj",
  task: "task",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function createId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

/** Prefixed ULID: `<prefix>_` followed by 26 Crockford base32 characters. */
export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`);
}
