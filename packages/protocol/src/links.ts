import { idPattern } from "./ids";

const THREAD_ID = new RegExp(idPattern("thread").source.slice(1, -1));
const THREAD_HREF = new RegExp(`^#(${THREAD_ID.source})$`);

/**
 * A Markdown link to a thread, as agents write it in messages: `[Title](#thr_…)`.
 * Clients draw it as a link that opens the thread.
 */
export function threadLink(thread: { id: string; title: string }): string {
  return `[${thread.title.replace(/[[\]]/g, "")}](#${thread.id})`;
}

/** The thread id a message link points at, or null when it is not a thread link. */
export function threadIdFromHref(href: string | undefined): string | null {
  return (href && THREAD_HREF.exec(href)?.[1]) || null;
}
