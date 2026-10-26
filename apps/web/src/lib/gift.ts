/**
 * A gift link's token, kept on this device from opening /gift/<token> until the plan page has used
 * it, so it survives signing up, signing in and the email verification link.
 */
const KEY = "myrel.gift";

export function pendingGift(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setPendingGift(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage off: the link still works when opened while signed in.
  }
}
