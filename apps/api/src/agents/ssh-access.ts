import { type DecisionInput, formatDecision, type SshResult } from "@myrel/protocol";
import type { AccessAnswer } from "./folder-access";

/**
 * The card for one SSH command an agent asked for with ssh_run. It goes straight to the person, not
 * the coordinator, and only the owner of the computer holding the server's key can answer it.
 * "always" allows that server for the rest of the turn; it never covers a destructive command, whose
 * card is red, recommends not running it, and offers no turn-wide allow.
 */

type Lang = "en" | "tr";
const lang = (language: string): Lang => (language === "tr" ? "tr" : "en");

const LABELS: Record<Lang, Record<AccessAnswer, { label: string; consequence: string }>> = {
  en: {
    once: { label: "Run it", consequence: "Only this command. The agent asks again for the next one." },
    always: { label: "Allow this server this turn", consequence: "No more questions on this server until the agent finishes this turn (destructive commands still ask)." },
    deny: { label: "Don't run", consequence: "The agent carries on without this command." },
  },
  tr: {
    once: { label: "Çalıştır", consequence: "Yalnızca bu komut. Ajan bir sonrakinde yine sorar." },
    always: { label: "Bu çalışmada bu sunucuya izin ver", consequence: "Ajan bu turu bitirene kadar bu sunucuda sormaz (yıkıcı komutlar yine sorulur)." },
    deny: { label: "Çalıştırma", consequence: "Ajan bu komut olmadan devam eder." },
  },
};

const DANGER_LABELS: Record<Lang, Partial<Record<AccessAnswer, { label: string; consequence: string }>>> = {
  en: {
    deny: { label: "Don't run", consequence: "The agent carries on without it and suggests another way." },
    once: { label: "Run it anyway", consequence: "Only this command. The history shows you allowed it." },
  },
  tr: {
    deny: { label: "Çalıştırma", consequence: "Ajan bu komut olmadan devam eder ve başka bir yol önerir." },
    once: { label: "Yine de çalıştır", consequence: "Yalnızca bu komut. Geçmişte onaylayan olarak sen görünürsün." },
  },
};

export type SshCard = {
  alias: string;
  user: string;
  host: string;
  port: number;
  computer: string;
  hostFingerprint: string | null;
  command: string;
  reason: string;
  danger: boolean;
};

function decision(card: Pick<SshCard, "alias" | "danger">, l: Lang): DecisionInput {
  if (card.danger) {
    const labels = DANGER_LABELS[l];
    return {
      question: l === "tr" ? `${card.alias} üzerinde bu komut çalışsın mı? Geri alınamayabilir.` : `Run this on ${card.alias}? It may not be undoable.`,
      options: [labels.deny!, labels.once!],
      recommended: 0,
      danger: true,
    };
  }
  return {
    question: l === "tr" ? `Ajan bu komutu ${card.alias} üzerinde çalıştırabilsin mi?` : `Can the agent run this command on ${card.alias}?`,
    options: (["once", "always", "deny"] as const).map((a) => LABELS[l][a]),
    recommended: 0,
  };
}

const fence = "```";
const block = (command: string) => `${fence}sh\n${command.replaceAll(fence, "` ` `")}\n${fence}`;

/** The message carrying the card while it waits: where, which server key, the whole command and why. */
export function sshMessage(card: SshCard, language: string): string {
  const l = lang(language);
  const where = `\`${card.user}@${card.host}:${card.port}\``;
  const lines =
    l === "tr"
      ? [
          `**SSH komutu için izin**${card.danger ? " · dikkat" : ""}`,
          `Bilgisayar: ${card.computer}`,
          `Sunucu: **${card.alias}** · ${where}`,
          ...(card.hostFingerprint ? [`Sunucu kimliği: \`${card.hostFingerprint}\` (onayladığın anahtar; değişmişse komut çalışmaz)`] : []),
        ]
      : [
          `**Permission for an SSH command**${card.danger ? " · careful" : ""}`,
          `Computer: ${card.computer}`,
          `Server: **${card.alias}** · ${where}`,
          ...(card.hostFingerprint ? [`Server identity: \`${card.hostFingerprint}\` (the key you confirmed; if it changed, nothing runs)`] : []),
        ];
  const warning = card.danger
    ? l === "tr"
      ? "\n\n⚠️ Bu komut silme, durdurma ya da üzerine yazma içeriyor olabilir. Geri alınamayabilir; bu çalışmaya verilen sunucu izni bunu kapsamaz."
      : "\n\n⚠️ This command may delete, stop or overwrite something. It may not be undoable, and allowing the server for this turn does not cover it."
    : "";
  const why = card.reason.trim() ? `\n\n${l === "tr" ? "Neden" : "Why"}: ${card.reason.trim().replace(/\s+/g, " ").slice(0, 500)}` : "";
  const who =
    l === "tr"
      ? "\n\nYalnızca bu bilgisayarın sahibi yanıtlayabilir. 10 dakika içinde yanıt gelmezse komut çalışmaz."
      : "\n\nOnly this computer's owner can answer. If nobody answers within 10 minutes, it does not run.";
  return `${lines.join("\n")}\n\n${block(card.command)}${why}${warning}${who}\n\n${formatDecision(decision(card, l))}`;
}

/** The answered card: the server, the command and the card, which clients show as one line with the pick. */
export function answeredSshMessage(card: Pick<SshCard, "alias" | "command" | "danger">, language: string): string {
  const l = lang(language);
  const command = card.command.replace(/\s+/g, " ").replaceAll("`", "'");
  const short = command.length > 160 ? `${command.slice(0, 159)}…` : command;
  return `SSH ${card.alias}: \`${short}\`\n\n${formatDecision(decision(card, l))}`;
}

/** Which answer a person's message gives to an SSH card, matched on its labels in either language. */
export function sshAnswer(body: string, danger: boolean): AccessAnswer | null {
  const text = body.trim().toLocaleLowerCase("tr");
  for (const labels of Object.values(danger ? DANGER_LABELS : LABELS)) {
    for (const [answer, option] of Object.entries(labels)) {
      if (option && option.label.toLocaleLowerCase("tr") === text) return answer as AccessAnswer;
    }
  }
  return null;
}

/** What the agent gets back: ssh's output as JSON, which the run's `ssh` turns back into output and an exit code. */
export function sshToolOutput(result: SshResult): string {
  return JSON.stringify({
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.truncated && { truncated: true }),
    ...(result.error && { error: SSH_ERRORS[result.error] }),
    ms: result.ms,
  });
}

const SSH_ERRORS: Record<NonNullable<SshResult["error"]>, string> = {
  hostkey: "The server's key is not the one confirmed in the project's SSH settings, so nothing ran. Tell the person: it may have been reinstalled, or someone may be in between. Do not try again until they confirm the key again in the settings.",
  auth: "The server refused Myrel's key. The person may need to add it to ~/.ssh/authorized_keys on the server (the SSH settings show the line).",
  connect: "Could not connect to the server from the computer.",
  timeout: "The command took longer than 5 minutes and was stopped.",
  nokey: "The computer has no key for this server any more. The person can set it up again in the project's SSH settings.",
  other: "ssh failed; see stderr.",
};
