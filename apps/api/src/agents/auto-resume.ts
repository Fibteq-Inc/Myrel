/**
 * When a turn on the person's computer stops because the runner went away (it restarted for an
 * update, the computer disconnected), or a cloud turn because its sandbox was lost, the thread
 * continues it on its own, a bounded number of times.
 */

/** Where the cut-off turn ran: on the person's computer, or in the cloud sandbox. */
export type ResumeWhere = "runner" | "sandbox";

/** At most this many continues in a row; a run that made no progress counts twice. */
export const MAX_AUTO_RESUMES = 3;
/** Wait before each continue (by its number), so a runner that keeps going down is not hammered. */
export const RESUME_DELAYS_SEC = [30, 120, 480];
/** A runner that connected more than FLAP_MAX_CONNECTS times in FLAP_WINDOW_MS is flapping: no continues. */
export const FLAP_WINDOW_MS = 10 * 60 * 1000;
export const FLAP_MAX_CONNECTS = 5;

/** Continues so far in this chain of turns, and the budget they used. Reset when a turn ends on its own. */
export type ResumeState = { resumes: number; cost: number };

export type ResumeDecision =
  | { resume: true; state: ResumeState; delaySec: number }
  | { resume: false; reason: "limit" | "flapping" | "not-agent" };

export function decideResume(input: { state: ResumeState | null; progressed: boolean; flapping: boolean; agent: boolean }): ResumeDecision {
  if (!input.agent) return { resume: false, reason: "not-agent" };
  if (input.flapping) return { resume: false, reason: "flapping" };
  const prev = input.state ?? { resumes: 0, cost: 0 };
  const state = { resumes: prev.resumes + 1, cost: prev.cost + (input.progressed ? 1 : 2) };
  if (state.cost > MAX_AUTO_RESUMES) return { resume: false, reason: "limit" };
  return { resume: true, state, delaySec: RESUME_DELAYS_SEC[Math.min(state.resumes, RESUME_DELAYS_SEC.length) - 1]! };
}

/** Why the run ended, as its terminal and report say it. */
export function interruptedReason(restarted: boolean): string {
  return restarted
    ? "The task stopped when myrel-runner restarted (an update, say)."
    : "The task stopped when the computer disconnected.";
}

/** The line in the thread while it waits to continue. */
export function resumingMessage(tr: boolean, resumes: number, delaySec: number, where: ResumeWhere = "runner"): string {
  const wait = delaySec >= 60 ? (tr ? `${Math.round(delaySec / 60)} dk` : `${Math.round(delaySec / 60)} min`) : tr ? `${delaySec} sn` : `${delaySec}s`;
  if (where === "sandbox") {
    return tr
      ? `Bulut sandbox'ı durduğu için görev kesildi; ${wait} içinde kaldığı yerden devam ediyor (${resumes}/${MAX_AUTO_RESUMES}).`
      : `The task was interrupted when its cloud sandbox stopped; it continues where it left off in ${wait} (${resumes}/${MAX_AUTO_RESUMES}).`;
  }
  return tr
    ? `Runner yeniden başladığı için görev kesildi; ${wait} içinde kaldığı yerden devam ediyor (${resumes}/${MAX_AUTO_RESUMES}).`
    : `The task was interrupted when the runner went away; it continues where it left off in ${wait} (${resumes}/${MAX_AUTO_RESUMES}).`;
}

/** The line in the thread when it stops continuing on its own. */
export function gaveUpMessage(tr: boolean, reason: "limit" | "flapping"): string {
  if (reason === "flapping") {
    return tr
      ? "Bilgisayarın bağlantısı çok sık kopup geliyor, bu yüzden görev otomatik olarak sürdürülmedi. Bağlantı düzelince devam etmek için buraya yazın."
      : "The computer keeps disconnecting, so the task was not continued on its own. Write here to continue once its connection is steady.";
  }
  return tr
    ? `Görev art arda kesildi, ${MAX_AUTO_RESUMES} otomatik devamdan sonra durduruldu. Devam etmek için buraya yazın.`
    : `The task kept being interrupted, so it stopped continuing on its own. Write here to continue.`;
}

/** What the continuing turn's agent is told, so it checks what the cut-off run left before going on. */
export function resumeNote(input: { resumes: number; lastStep: string | null; where?: ResumeWhere }): string {
  const why =
    input.where === "sandbox"
      ? "Your cloud sandbox stopped mid-run (Myrel was updated, or the container was replaced), which stopped your harness. Files you had not saved or pushed may be gone."
      : "The runner on the person's computer went away mid-run (it restarted for an update, or the computer disconnected), which stopped your CLI.";
  return [
    `## Your last run was interrupted (automatic continue ${input.resumes} of ${MAX_AUTO_RESUMES})`,
    `${why} Nobody wrote anything new for this: pick the work up where it stopped.`,
    input.lastStep ? `Your last step before it stopped: ${input.lastStep}` : "",
    "A command that was running may not have finished: check the state (git status, the files you were changing, your plan) before going on, and do not redo what is already done or send a reply you already sent.",
  ]
    .filter(Boolean)
    .join("\n");
}
