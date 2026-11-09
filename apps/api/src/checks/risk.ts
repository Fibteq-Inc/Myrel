/**
 * Which checks a change calls for, read from the files its pull requests change (the coordinator
 * control over the visual check): files people see call for a visual check, and files on a flow
 * people go through (sign-in, payment, sign-up, forms) also call for walking that flow. Paths only,
 * no diff: cheap enough to ask at every resolve, and wrong only in the safe direction (a reminder
 * the agent can answer in one line).
 */

/** Tests, stories, fixtures and type declarations: nobody sees them. */
const UNSEEN = /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|e2e|spec|fixtures?|mocks?|\.storybook|\.github)\/|\.(test|spec|stories|story)\.[cm]?[jt]sx?$|\.d\.ts$/i;

/** Files that are what people see, wherever they are: markup, components, styles, images, game scenes. */
const SEEN_FILE =
  /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|mdx|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|tscn|tres|gd|unity|prefab|uxml|uss|xaml|storyboard|xib)$/i;

/** Script files count where a front end keeps its screens; a backend's routes/ do not. */
const SEEN_SCRIPT = /(^|\/)(components?|pages|views|screens|layouts|ui|widgets|styles|theme|themes)\/.*\.[cm]?[jt]s$/i;

/** Words people read: translation files. A change there is visible but rarely breaks a layout. */
const COPY = /(^|\/)(locales?|i18n|lang|translations?)\/.+\.(json|ya?ml|[cm]?[jt]s|po|arb|strings|xml)$/i;

/** Flows people go through whose breakage costs most: worth walking step by step. By whole words of the path, so an AuthorCard is not sign-in. */
const FLOW_WORDS = new Set(["auth", "login", "signin", "signup", "checkout", "payment", "payments", "billing", "subscription", "subscriptions", "cart", "onboarding", "register", "password", "invite"]);
const onFlow = (path: string) => {
  const words = path.split(/[/._-]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase());
  return words.some((w, i) => FLOW_WORDS.has(w) || ((w === "sign" || w === "log") && (words[i + 1] === "in" || words[i + 1] === "up")));
};

export type ChangeRisk = {
  /** Files people see (markup, styles, components, images, game scenes). */
  seen: string[];
  /** Translation files. */
  copy: string[];
  /** Seen files on a flow worth walking (sign-in, payment…). */
  flows: string[];
};

export function changeRisk(paths: string[]): ChangeRisk {
  const seen: string[] = [];
  const copy: string[] = [];
  for (const p of paths) {
    if (UNSEEN.test(p)) continue;
    if (COPY.test(p)) copy.push(p);
    else if (SEEN_FILE.test(p) || SEEN_SCRIPT.test(p)) seen.push(p);
  }
  return { seen, copy, flows: seen.filter(onFlow) };
}

/** A few paths and how many more, for a one-line message. */
export function someFiles(paths: string[], n = 4): string {
  return paths.length > n ? `${paths.slice(0, n).join(", ")} and ${paths.length - n} more` : paths.join(", ");
}

/**
 * What resolve answers, once, when a thread's pull requests change what people see and no visual
 * check ran on the work: ask for one, or say in a line why nobody sees the change. Null when the
 * change calls for none.
 */
export function uncheckedNote(prs: { pr: string; risk: ChangeRisk }[]): string | null {
  const seen = prs.flatMap((p) => p.risk.seen);
  const copy = prs.flatMap((p) => p.risk.copy);
  if (!seen.length && !copy.length) return null;
  const flows = prs.flatMap((p) => p.risk.flows);
  const names = prs.filter((p) => p.risk.seen.length || p.risk.copy.length).map((p) => p.pr).join(", ");
  const what = seen.length ? `changes what people see (${someFiles(seen)})` : `changes only the words people read (${someFiles(copy)})`;
  return [
    `Not resolved yet: ${names} ${what}, this project has the visual check on, and no check ran on this work.`,
    "Call request_visual_check with the branch, then end your turn.",
    flows.length
      ? `It touches a flow people go through (${someFiles(flows, 3)}): in what, list that flow's steps and what must be true after each, so the evaluator walks it.`
      : "",
    seen.length
      ? "If nobody sees the change (the screens look exactly as before), say why in one line in your reply and resolve again."
      : "Longer or shorter words can break a layout; if they cannot here, say so in one line in your reply and resolve again.",
  ]
    .filter(Boolean)
    .join(" ");
}
