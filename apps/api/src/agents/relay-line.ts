import type { RelayKind } from "@myrel/protocol";

/**
 * The one line a thread shows where a coordinator note arrived; people open the note under it.
 * Written in the note's language, since the coordinator writes notes in the person's.
 */
export function relayLine(kind: RelayKind, note: string, fromTitle?: string): string {
  const tr = /[çğıöşüÇĞİÖŞÜ]/.test(note);
  switch (kind) {
    case "brief":
      return tr ? "Koordinatör görev tanımını iletti." : "The coordinator handed over the brief.";
    case "follow_up":
      return tr ? "Koordinatör takip mesajını iletti." : "The coordinator forwarded a follow-up.";
    case "reply":
      return tr ? "Koordinatör yanıtladı." : "The coordinator answered.";
    case "relay":
      return tr ? `"${fromTitle}" thread'inden bir not geldi.` : `A note came from the "${fromTitle}" thread.`;
  }
}
