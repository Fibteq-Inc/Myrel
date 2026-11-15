/**
 * Whether text is surely past `lines` lines on a phone: it counts about 45
 * characters to a line (narrow phones fit fewer) and asks for twice as many,
 * so it says yes only where measuring would too.
 */
export function surelyLong(text: string, lines: number): boolean {
  let total = 0;
  for (const paragraph of text.split("\n")) total += Math.max(1, Math.ceil(paragraph.length / 45));
  return total > lines * 2;
}

/**
 * The start of a text that is surelyLong: whole lines, counted the same way, until it is surely past
 * `lines` lines too, with a code block left open closed again. A folded message draws only this, so a
 * long report is not laid out in full behind its "Show more".
 */
export function foldedStart(text: string, lines: number): string {
  const paragraphs = text.split("\n");
  let total = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    total += Math.max(1, Math.ceil(paragraphs[i]!.length / 45));
    if (total <= lines * 2) continue;
    const start = paragraphs.slice(0, i + 1).join("\n");
    return (start.match(/^\s*```/gm)?.length ?? 0) % 2 === 1 ? `${start}\n\`\`\`` : start;
  }
  return text;
}
