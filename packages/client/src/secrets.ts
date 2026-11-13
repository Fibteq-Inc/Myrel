import type { KeyValueStore } from "./platform";

/**
 * Credentials kept in an OS keychain, with the app's own storage as the fallback (the desktop app's
 * sign-in token).
 *
 * - Each value is read once and then kept in memory. Every API request asks for the token, and a
 *   keychain that fails for a moment must not sign the person out in the middle of their work.
 * - When the keychain fails, the value goes to `fallback`, and a read looks there whenever the
 *   keychain has nothing, so a sign-in made while it failed still holds after a restart.
 * - Once the keychain takes a value again, the copy in `fallback` is removed.
 *
 * `onError` hears every keychain failure; the value is still read or kept through `fallback`.
 */
export function keychainStore(
  keychain: KeyValueStore,
  fallback: KeyValueStore,
  onError: (err: unknown) => void = () => {},
): KeyValueStore {
  const known = new Map<string, Promise<string | null>>();

  async function read(key: string): Promise<string | null> {
    let value: string | null = null;
    try {
      value = await keychain.get(key);
    } catch (err) {
      onError(err);
    }
    return value ?? (await fallback.get(key));
  }

  return {
    get(key) {
      const cached = known.get(key);
      if (cached) return cached;
      const value = read(key);
      known.set(key, value);
      // A read that failed altogether (the fallback too) is tried again next time.
      value.catch(() => {
        if (known.get(key) === value) known.delete(key);
      });
      return value;
    },
    async set(key, value) {
      known.set(key, Promise.resolve(value));
      try {
        await keychain.set(key, value);
      } catch (err) {
        onError(err);
        await fallback.set(key, value);
        return;
      }
      if ((await fallback.get(key)) !== null) await fallback.set(key, null);
    },
  };
}
