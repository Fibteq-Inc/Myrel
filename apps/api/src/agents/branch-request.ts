import { type DecisionInput, formatDecision } from "@myrel/protocol";
import type { BranchBlock, PullBranch } from "../github/pulls";

/**
 * An agent closes the pull requests its thread opened on its own (close_pull_request), but the
 * branch is deleted only when a person says so: the tool puts this card to them, and a tap on
 * "Delete the branch" by the person the thread worked for, or a project owner or admin, deletes it
 * (deletePullBranch) without starting a turn.
 */

/** The open question, kept on the thread until someone answers it. `requester`: who may answer besides owners and admins. */
export type BranchRequest = { repo: string; number: number; branch: string; requester: string | null; messageId: string };

export type BranchAnswer = "delete" | "keep";

const LABELS: Record<"en" | "tr", Record<BranchAnswer, { label: string; consequence: string }>> = {
  en: {
    delete: { label: "Delete the branch", consequence: "Myrel deletes it on GitHub. It can be restored from the pull request's page." },
    keep: { label: "Keep the branch", consequence: "The branch stays, so the pull request can be reopened as it was." },
  },
  tr: {
    delete: { label: "Dalı sil", consequence: "Myrel dalı GitHub'da siler. PR sayfasından geri getirilebilir." },
    keep: { label: "Dalı bırak", consequence: "Dal kalır, PR olduğu gibi yeniden açılabilir." },
  },
};

function lang(language: string): "en" | "tr" {
  return language === "tr" ? "tr" : "en";
}

function decision(b: Pick<PullBranch, "repo" | "number" | "branch">, l: "en" | "tr"): DecisionInput {
  return {
    question:
      l === "tr"
        ? `${b.repo}#${b.number} kapatıldı. \`${b.branch}\` dalı da silinsin mi?`
        : `${b.repo}#${b.number} is closed. Delete its branch \`${b.branch}\` too?`,
    options: (["delete", "keep"] as const).map((a) => LABELS[l][a]),
    recommended: 1,
  };
}

/** The card, after one line on why the agent closed the pull request. */
export function branchRequestMessage(b: Pick<PullBranch, "repo" | "number" | "branch">, reason: string, language: string): string {
  const why = reason.trim().replace(/\s+/g, " ").slice(0, 300);
  return `${why}\n\n${formatDecision(decision(b, lang(language)))}`;
}

/** Which answer a person's message gives to the card, matched on its labels in either language. */
export function branchAnswer(body: string): BranchAnswer | null {
  const text = body.trim().toLocaleLowerCase("tr");
  for (const labels of Object.values(LABELS)) {
    for (const [answer, { label }] of Object.entries(labels)) {
      if (label.toLocaleLowerCase("tr") === text) return answer as BranchAnswer;
    }
  }
  return null;
}

const BLOCKS: Record<"en" | "tr", Record<BranchBlock["kind"], (pr?: number) => string>> = {
  en: {
    fork: () => "it is in another repository (a fork)",
    default: () => "it is the default branch",
    protected: () => "it is a protected branch",
    gone: () => "it no longer exists",
    in_use: (pr) => `the open pull request #${pr} uses it`,
    reopened: (pr) => `#${pr} is open again`,
  },
  tr: {
    fork: () => "dal başka bir depoda (fork)",
    default: () => "varsayılan dal",
    protected: () => "korumalı bir dal",
    gone: () => "dal artık yok",
    in_use: (pr) => `açık #${pr} PR'ı bu dalı kullanıyor`,
    reopened: (pr) => `#${pr} yeniden açılmış`,
  },
};

/** Why the branch stays, in the given language ("en" for the agent). */
export function branchBlockText(block: BranchBlock, language: string): string {
  return BLOCKS[lang(language)][block.kind](block.pr);
}

/** What the person sees once the card is answered: deleted, kept for a reason, or not theirs to answer. */
export function branchResultMessage(b: PullBranch | { branch: string; forbidden: true }, language: string): string {
  const tr = lang(language) === "tr";
  if ("forbidden" in b) {
    return tr
      ? `\`${b.branch}\` dalını yalnızca thread'i isteyen kişi ya da projenin sahibi veya bir yöneticisi silebilir.`
      : `Only the person this thread works for, or the project's owner or an admin, can delete \`${b.branch}\`.`;
  }
  if (b.blocked) {
    const why = branchBlockText(b.blocked, language);
    return tr ? `\`${b.branch}\` dalı silinmedi: ${why}.` : `\`${b.branch}\` was not deleted: ${why}.`;
  }
  return tr ? `\`${b.branch}\` dalı GitHub'da silindi.` : `\`${b.branch}\` was deleted on GitHub.`;
}
