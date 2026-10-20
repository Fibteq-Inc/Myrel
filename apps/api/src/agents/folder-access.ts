import { type DecisionInput, formatDecision } from "@myrel/protocol";

/**
 * A local agent works in the project's folders on the person's computer. When Claude Code wants to
 * touch anything outside them, it asks through the thread's approve_access tool (its permission
 * prompt tool), and Myrel puts the question to the person as a card in the thread.
 */

/** once: for the rest of this turn. always: the folder is added to the project. */
export type AccessAnswer = "once" | "always" | "deny";

/** One question to the person about one folder, while the turn waits for the answer. */
export type AccessRequest = { id: string; folder: string; answer?: AccessAnswer };

/** How long the agent waits for the person before carrying on without the folder. */
export const ACCESS_WAIT_MS = 10 * 60 * 1000;

const LABELS: Record<"en" | "tr", Record<AccessAnswer, { label: string; consequence: string }>> = {
  en: {
    once: { label: "Allow once", consequence: "The agent can use this folder until it finishes this turn." },
    always: { label: "Add to project", consequence: "The folder joins the project's folders in settings; the agent uses it without asking." },
    deny: { label: "Don't allow", consequence: "The agent leaves this folder alone and carries on without it." },
  },
  tr: {
    once: { label: "Bu sefer izin ver", consequence: "Ajan bu klasörü yalnızca bu çalışması bitene kadar kullanabilir." },
    always: { label: "Projeye ekle", consequence: "Klasör proje ayarlarındaki klasörlere eklenir; ajan bundan sonra sormadan kullanır." },
    deny: { label: "İzin verme", consequence: "Ajan bu klasöre dokunmaz ve işine onsuz devam eder." },
  },
};

/** The message carrying the card: what the agent tried, then the question with its three options. */
export function accessMessage(folder: string, what: string, language: string): string {
  const lang = language === "tr" ? "tr" : "en";
  const labels = LABELS[lang];
  const short = folder.length > 200 ? `…${folder.slice(-199)}` : folder;
  const decision: DecisionInput = {
    question: lang === "tr" ? `Ajan şu klasöre erişebilsin mi? ${short}` : `Can the agent use this folder? ${short}`,
    options: (["once", "always", "deny"] as const).map((a) => labels[a]),
    recommended: 0,
  };
  const intro =
    lang === "tr"
      ? `Ajan, projenin klasörleri dışında bir yere erişmek istiyor (${what}). Yanıtını bekliyor.`
      : `The agent wants to reach outside the project's folders (${what}). It is waiting for your answer.`;
  return `${intro}\n\n${formatDecision(decision)}`;
}

/** Which answer a person's message gives, matched on the card's labels in either language. */
export function accessAnswer(body: string): AccessAnswer | null {
  const text = body.trim().toLocaleLowerCase("tr");
  for (const lang of Object.values(LABELS)) {
    for (const [answer, { label }] of Object.entries(lang)) {
      if (label.toLocaleLowerCase("tr") === text) return answer as AccessAnswer;
    }
  }
  return null;
}

/** A path the agent wants to use, and the folder the person is asked about for it. */
export type AccessTarget = { path: string; folder: string };

/** Tools whose path is a file: the person is asked about the folder it is in. */
const FILE_KEYS = ["file_path", "notebook_path"];

/**
 * The paths a Claude Code permission request touches (Read, Write, Edit, Glob, Grep, LS, ...),
 * resolved against `cwd`. Empty when it names no path, e.g. a shell command.
 */
export function accessTargets(input: Record<string, unknown>, cwd: string | undefined): AccessTarget[] {
  const targets: AccessTarget[] = [];
  const add = (raw: unknown, isFile: boolean) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const path = normalizePath(raw.trim(), cwd);
    if (!path) return;
    targets.push({ path, folder: isFile ? parentOf(path) : path });
  };
  for (const key of FILE_KEYS) add(input[key], true);
  add(input.path, false);
  // An absolute glob pattern points at the folder before its first wildcard.
  if (typeof input.pattern === "string" && isAbsolute(input.pattern) && /[*?[{]/.test(input.pattern)) {
    const head = input.pattern.slice(0, input.pattern.search(/[*?[{]/));
    add(head.replace(/[\\/][^\\/]*$/, "") || "/", false);
  }
  return targets;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * An absolute path with `.` and `..` resolved and forward slashes, so paths from macOS, Linux and
 * Windows compare the same way. Null for a relative path with nothing to resolve it against.
 */
export function normalizePath(raw: string, cwd?: string): string | null {
  let path = raw.replace(/\\/g, "/");
  if (!isAbsolute(raw)) {
    if (!cwd) return null;
    path = `${cwd.replace(/\\/g, "/")}/${path}`;
  }
  const drive = /^[A-Za-z]:/.exec(path)?.[0].toUpperCase() ?? "";
  const unc = !drive && path.startsWith("//");
  const parts: string[] = [];
  for (const part of path.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${unc ? "//" : drive}/${parts.join("/")}`;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut) || "/";
}

/** Whether `path` is one of `folders` or inside one. Windows paths compare without case. */
export function insideAny(path: string, folders: string[]): boolean {
  const windows = /^[A-Z]:\//.test(path);
  const key = (p: string) => (windows ? p.toLowerCase() : p);
  const target = key(path);
  return folders.some((f) => {
    const folder = normalizePath(f);
    if (!folder) return false;
    const k = key(folder);
    return target === k || target.startsWith(k.endsWith("/") ? k : `${k}/`);
  });
}

/** What Claude Code reads from the permission prompt tool's answer. */
export function allowAnswer(input: Record<string, unknown>): string {
  return JSON.stringify({ behavior: "allow", updatedInput: input });
}

export function denyAnswer(message: string): string {
  return JSON.stringify({ behavior: "deny", message });
}

/** Why a request inside the project's folders still is not allowed: the runner's access level. */
export const ACCESS_LEVEL_DENIED =
  "myrel-runner's access level on this computer does not let you do this on your own. If the work needs it, say so in a reply; the person can change it with `myrel-runner start --access full`.";

/** A short description of the request for the card, e.g. "Read /Users/a/notes/todo.md". */
export function describeRequest(toolName: string, target: AccessTarget): string {
  const name = toolName.replace(/^mcp__/, "").slice(0, 40);
  return `${name} ${target.path.length > 160 ? `…${target.path.slice(-159)}` : target.path}`;
}
