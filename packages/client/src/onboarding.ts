/** The user guide; pages under it explain what the apps cannot do in place (e.g. pairing a computer from a phone). */
export const DOCS_URL = "https://docs.myrel.fibteq.io";

/** The example tasks an empty project chat offers; each has title, body, result and prompt messages under `starter.<id>`. */
export const STARTER_EXAMPLES = ["page", "research", "routine"] as const;
export type StarterExample = (typeof STARTER_EXAMPLES)[number];

export type StarterStepId = "project" | "task" | "computer" | "github";
export type StarterStep = { id: StarterStepId; done: boolean; optional: boolean };

/**
 * The owner's "Get started" list, read from what already exists: the project
 * (always there), a first message in its chat, a paired computer and a
 * repository connected to the project. `github` is null when the server has
 * no GitHub App, which drops that step.
 */
export function starterSteps(input: { asked: boolean; computers: number; github: boolean | null }): StarterStep[] {
  const steps: StarterStep[] = [
    { id: "project", done: true, optional: false },
    { id: "task", done: input.asked, optional: false },
    { id: "computer", done: input.computers > 0, optional: true },
  ];
  if (input.github !== null) steps.push({ id: "github", done: input.github, optional: true });
  return steps;
}

/**
 * An example's prompt as it goes into the message box, with the range of its
 * first `[placeholder]` to select so the person types over it.
 */
export function starterDraft(prompt: string): { text: string; select: [number, number] } {
  const start = prompt.indexOf("[");
  const end = start < 0 ? -1 : prompt.indexOf("]", start);
  return { text: prompt, select: start < 0 || end < 0 ? [prompt.length, prompt.length] : [start, end + 1] };
}
