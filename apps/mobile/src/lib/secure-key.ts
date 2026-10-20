/**
 * SecureStore keys may only contain letters, digits, ".", "-" and "_".
 * Encodes any other character (and "_" itself) as "_" plus four hex digits,
 * so distinct keys such as per-server token keys never collide.
 */
export function secureKey(key: string): string {
  let out = "";
  for (const ch of key) {
    out += /[A-Za-z0-9.-]/.test(ch) ? ch : `_${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  }
  return out;
}
