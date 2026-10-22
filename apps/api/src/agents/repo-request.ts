import { type DecisionInput, formatDecision } from "@myrel/protocol";
import type { ConnectRepoResult } from "../github/store";

/**
 * When the work needs a GitHub repository the project has not connected, the agent asks for it
 * with a card instead of a paragraph of steps: one tap by a project owner or admin connects it
 * (connectRepoByName), and the agent carries on in a new turn with the repository connected.
 */

/** The open question, kept on the thread until someone answers it. */
export type RepoRequest = { repo: string; messageId: string };

export type RepoAnswer = "connect" | "skip";

const LABELS: Record<"en" | "tr", Record<RepoAnswer, { label: string; consequence: string }>> = {
  en: {
    connect: { label: "Connect the repository", consequence: "Myrel connects it to this project through its GitHub App, and the agent carries on." },
    skip: { label: "Not now", consequence: "The agent carries on without it." },
  },
  tr: {
    connect: { label: "Repoyu bağla", consequence: "Myrel repoyu GitHub uygulaması üzerinden bu projeye bağlar, ajan işine devam eder." },
    skip: { label: "Şimdi değil", consequence: "Ajan repo olmadan devam eder." },
  },
};

function lang(language: string): "en" | "tr" {
  return language === "tr" ? "tr" : "en";
}

function decision(repo: string, l: "en" | "tr"): DecisionInput {
  return {
    question: l === "tr" ? `${repo} bu projeye bağlı değil. Bağlayayım mı?` : `${repo} is not connected to this project. Connect it?`,
    options: (["connect", "skip"] as const).map((a) => LABELS[l][a]),
    recommended: 0,
  };
}

/** The card, after one line on what the agent needs the repository for. */
export function repoRequestMessage(repo: string, reason: string, language: string): string {
  const l = lang(language);
  const why = reason.trim().replace(/\s+/g, " ").slice(0, 300);
  return `${why}\n\n${formatDecision(decision(repo, l))}`;
}

/** Which answer a person's message gives to the card, matched on its labels in either language. */
export function repoAnswer(body: string): RepoAnswer | null {
  const text = body.trim().toLocaleLowerCase("tr");
  for (const labels of Object.values(LABELS)) {
    for (const [answer, { label }] of Object.entries(labels)) {
      if (label.toLocaleLowerCase("tr") === text) return answer as RepoAnswer;
    }
  }
  return null;
}

/**
 * Why connecting did not work and what the person does about it, with a fresh card to try again
 * once they did. `connectUrl`: Myrel's GitHub connect round trip, which comes back to the thread.
 */
export function repoFailureMessage(
  repo: string,
  reason: Exclude<ConnectRepoResult, { ok: true }>["reason"],
  links: { connectUrl: string | null; settingsUrl: string | null },
  language: string,
): string {
  const l = lang(language);
  const tr = l === "tr";
  const github = links.connectUrl
    ? tr
      ? `[GitHub'da izin ver](${links.connectUrl})`
      : `[give access on GitHub](${links.connectUrl})`
    : tr
      ? "GitHub'ı proje ayarlarından bağla"
      : "connect GitHub in the project's settings";
  const settings = links.settingsUrl ? (tr ? ` ([proje ayarları](${links.settingsUrl}))` : ` ([project settings](${links.settingsUrl}))`) : "";
  const text = {
    not_configured: tr
      ? `Bu sunucuda GitHub uygulaması kurulmamış, bu yüzden ${repo} bağlanamıyor. Sunucunun yöneticisi kurmalı.`
      : `This server has no GitHub App set up, so ${repo} cannot be connected. The server's admin needs to set it up.`,
    forbidden: tr
      ? `Repoları yalnızca projenin sahibi ya da bir yöneticisi bağlayabilir. Onlardan biri karttaki "${LABELS.tr.connect.label}" seçeneğine dokunabilir${settings}.`
      : `Only the project's owner or an admin can connect repositories. One of them can pick "${LABELS.en.connect.label}" on the card${settings}.`,
    github_reauth: tr
      ? `${repo} reposunu bağlamak için önce ${github}; GitHub seni buraya geri getirir. Sonra karttan tekrar dene.`
      : `To connect ${repo}, first ${github}; GitHub brings you back here. Then try again from the card.`,
    not_installed: tr
      ? `Myrel'in GitHub uygulaması ${repo} reposuna erişemiyor. ${github} ve kurulumda bu repoyu seç; GitHub seni buraya geri getirir. Sonra karttan tekrar dene.`
      : `Myrel's GitHub App cannot reach ${repo}. ${github[0]!.toUpperCase()}${github.slice(1)} and pick this repository in the installation; GitHub brings you back here. Then try again from the card.`,
  }[reason];
  // Nothing the person can do from the thread: no card to try again.
  if (reason === "not_configured") return text;
  return `${text}\n\n${formatDecision(decision(repo, l))}`;
}

/** What the person sees once the repository is connected. */
export function repoConnectedMessage(repo: string, language: string): string {
  return lang(language) === "tr" ? `${repo} projeye bağlandı.` : `${repo} is now connected to the project.`;
}
