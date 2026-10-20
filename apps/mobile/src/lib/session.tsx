import {
  ApiClient,
  ApiError,
  currentServer,
  normalizeServerUrl,
  probeServer,
  type SessionUser,
  saveServer,
  tokenStoreFor,
} from "@altair/client";
import type { ServerInfo } from "@altair/protocol";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useState } from "react";
import { platform } from "./platform";

/** Server a fresh install points at; empty means the user picks one first. */
const DEFAULT_SERVER = (process.env.EXPO_PUBLIC_ALTAIR_SERVER ?? "").replace(/\/$/, "");

/** Native requests carry the app's own origin (trusted by the API) and never use cookies. */
export function createApi(server: string) {
  return new ApiClient({
    baseUrl: server,
    tokens: tokenStoreFor(platform, server),
    headers: { origin: "altair://" },
    credentials: "omit",
  });
}

type SessionValue = {
  /** False until the saved server and session are read. */
  ready: boolean;
  /** Origin of the chosen server, "" when none is chosen yet. */
  server: string;
  info: ServerInfo | null;
  api: ApiClient;
  user: SessionUser | null;
  /** Set when the server could not be reached at start-up. */
  offline: boolean;
  retry(): void;
  chooseServer(input: string): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  signUp(input: { email: string; password: string; name: string }): Promise<void>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

/** The signed-in API client; only for screens behind the sign-in guard. */
export function useApi() {
  return useSession().api;
}

export function SessionProvider({ children, onSignOut }: { children: ReactNode; onSignOut?: (api: ApiClient) => Promise<void> }) {
  const [ready, setReady] = useState(false);
  const [server, setServer] = useState("");
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const api = useMemo(() => createApi(server), [server]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await currentServer(platform.storage, DEFAULT_SERVER);
      if (cancelled) return;
      setServer(saved);
      if (!saved) return setReady(true);
      try {
        const client = createApi(saved);
        const [serverInfo, session] = await Promise.all([probeServer(saved), client.getSession()]);
        if (cancelled) return;
        setInfo(serverInfo);
        setUser(session?.user ?? null);
        setOffline(false);
      } catch (err) {
        if (cancelled) return;
        // An expired token is a normal sign-out; anything else means we could not check.
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setOffline(true);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const chooseServer = useCallback(async (input: string) => {
    const origin = normalizeServerUrl(input);
    const serverInfo = await probeServer(origin);
    await saveServer(platform.storage, origin);
    setInfo(serverInfo);
    setServer(origin);
    setOffline(false);
    // Tokens are per server: a saved session for this server signs straight in.
    const session = await createApi(origin).getSession().catch(() => null);
    setUser(session?.user ?? null);
  }, []);

  const loadSession = useCallback(async () => {
    const session = await api.getSession();
    setUser(session?.user ?? null);
  }, [api]);

  const value: SessionValue = {
    ready,
    server,
    info,
    api,
    user,
    offline,
    retry: () => {
      setReady(false);
      setAttempt((n) => n + 1);
    },
    chooseServer,
    async signIn(input) {
      await api.signIn(input);
      await loadSession();
    },
    async signUp(input) {
      await api.signUp(input);
      await loadSession();
    },
    async signOut() {
      await onSignOut?.(api).catch(() => {});
      await api.signOut().catch(() => {});
      setUser(null);
    },
  };

  return <SessionContext value={value}>{children}</SessionContext>;
}
