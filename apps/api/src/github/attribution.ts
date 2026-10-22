/**
 * The block Myrel puts at the top of a pull request a thread opened: who asked for the work and a
 * link back to the thread, so reviewers on GitHub can find the conversation behind it.
 */

/** Who a thread's pull request is for and where it came from. */
export type PullCredit = {
  /** The Myrel name of the person the thread works for. */
  name: string | null;
  /** Their GitHub login, when they connected GitHub: assigned and asked for a review. */
  login: string | null;
  /** The thread on Myrel, e.g. https://myrel.fibteq.io/projects/p/threads/t. */
  threadUrl: string | null;
};

const MARKER = "<!-- myrel-attribution";

/** Whether a pull request body already starts with (or carries) Myrel's block. */
export function hasAttribution(body: string | null | undefined): boolean {
  return (body ?? "").includes(MARKER);
}

/** Markdown that shows a name as written, never as formatting or HTML. */
function plain(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => `\\${c}`)
    .trim()
    .slice(0, 80);
}

/** The two lines that open the body. Null when there is nothing to credit or link. */
export function attributionBlock(credit: PullCredit): string | null {
  if (!credit.name && !credit.threadUrl) return null;
  const meta: Record<string, string> = {};
  if (credit.login) meta.github_login = credit.login;
  // The marker is an HTML comment, so a value must not be able to close it.
  const json = JSON.stringify(meta).replace(/--/g, "");
  const who = credit.name ? `Requested by **${plain(credit.name)}**` : "Opened by Myrel";
  const link = credit.threadUrl ? ` · [Myrel thread](${credit.threadUrl})` : "";
  return `${MARKER}: ${json} -->\n_${who}${link}_`;
}

/** The body with Myrel's block on top, unless it has one already. */
export function withAttribution(body: string | null | undefined, credit: PullCredit): string {
  const text = body ?? "";
  const block = attributionBlock(credit);
  if (!block || hasAttribution(text)) return text;
  return text.trim() ? `${block}\n\n${text}` : block;
}
