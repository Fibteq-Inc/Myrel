import {
  ApiClient,
  currentServer,
  type Platform,
  probeServer,
  saveServer,
  tokenStoreFor,
  webPlatform,
} from "@altair/client";
import { QueryClient, queryOptions } from "@tanstack/react-query";

// The desktop shell can inject its own platform (keychain, native dialogs) before the app boots.
export const platform: Platform =
  (globalThis as { __ALTAIR_PLATFORM__?: Platform }).__ALTAIR_PLATFORM__ ?? webPlatform();

/**
 * Server origin: the user's saved choice (desktop/mobile can point at any
 * self-hosted Altair), else VITE_API_URL, else same origin ("").
 */
export const server = await currentServer(platform.storage, (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, ""));

/** Apps that are not served by an Altair server let the user pick one. */
export const canChooseServer = platform.name !== "web";

export const api = new ApiClient({ baseUrl: server, tokens: tokenStoreFor(platform, server) });

/** Switches to another server. The page reloads so every client and cache starts fresh. */
export async function switchServer(origin: string) {
  await saveServer(platform.storage, origin);
  location.reload();
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
});

export const sessionQuery = queryOptions({ queryKey: ["session"], queryFn: () => api.getSession() });
export const projectsQuery = queryOptions({ queryKey: ["projects"], queryFn: () => api.listProjects() });
export const projectQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id], queryFn: () => api.getProject(id) });
export const membersQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "members"], queryFn: () => api.listMembers(id) });
/** What the current server allows (e.g. whether new accounts can be created). */
export const serverInfoQuery = queryOptions({
  queryKey: ["server-info", server],
  queryFn: () => probeServer(server || location.origin),
  staleTime: Infinity,
});
