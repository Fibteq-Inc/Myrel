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
