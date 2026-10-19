/** Where the bearer token lives. Web can skip it and rely on cookies; native uses SecureStore etc. */
export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string | null): void | Promise<void>;
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return {
    get: () => token,
    set: (t) => {
      token = t;
    },
  };
}
