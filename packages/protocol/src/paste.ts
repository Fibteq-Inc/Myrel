/** A paste this long goes into the message as a .txt attachment instead of as text (web, desktop and mobile). */
export const LONG_PASTE_CHARS = 4000;
export const LONG_PASTE_LINES = 80;

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split("\n").length > LONG_PASTE_LINES;
}

/**
 * Finds a long paste in a text field's change, for fields that have no paste
 * event (React Native). The new text is the old one with one stretch replaced;
 * when that stretch is a long paste, returns it and the text without it.
 */
export function takeLongPaste(before: string, after: string): { pasted: string; rest: string } | null {
  if (after.length - before.length < 1) return null;
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const pasted = after.slice(start, after.length - end);
  if (!isLongPaste(pasted)) return null;
  return { pasted, rest: after.slice(0, start) + after.slice(after.length - end) };
}
