import {
  ApiClient,
  currentServer,
  type Platform,
  probeServer,
  saveServer,
  tokenStoreFor,
  webPlatform,
} from "@myrel/client";
import { QueryClient, queryOptions } from "@tanstack/react-query";

// The desktop shell can inject its own platform (keychain, native dialogs) before the app boots.
export const platform: Platform =
  (globalThis as { __MYREL_PLATFORM__?: Platform }).__MYREL_PLATFORM__ ?? webPlatform();

/**
 * Server origin: the user's saved choice (desktop/mobile can point at any
 * self-hosted Myrel), else VITE_API_URL, else same origin ("").
 */
export const server = await currentServer(platform.storage, (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, ""));

/** Apps that are not served by a Myrel server let the user pick one. */
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

// Asks even when the system says it is offline (it can be wrong, and a paused query would leave the
// app blank at start); without a connection the route's error page retries until it is back.
export const sessionQuery = queryOptions({ queryKey: ["session"], queryFn: () => api.getSession(), networkMode: "always" });
export const projectsQuery = queryOptions({ queryKey: ["projects"], queryFn: () => api.listProjects() });
export const projectQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id], queryFn: () => api.getProject(id) });
export const membersQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "members"], queryFn: () => api.listMembers(id) });
export const filesQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "files"], queryFn: () => api.listFiles(id) });
export const memoryQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "memory"], queryFn: () => api.listMemory(id) });
/** Under "memory" so a knowledge.changed event for memory refetches it too. */
export const memoryUpkeepQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "memory", "upkeep"], queryFn: () => api.memoryUpkeep(id) });
export const instructionsQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "instructions"], queryFn: () => api.getInstructions(id) });
export const githubStatusQuery = queryOptions({ queryKey: ["github"], queryFn: () => api.getGithubStatus() });
export const githubReposQuery = queryOptions({ queryKey: ["github", "repos"], queryFn: () => api.listGithubRepos() });
export const projectReposQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "repos"], queryFn: () => api.listProjectRepos(id) });
export const runnersQuery = queryOptions({ queryKey: ["runners"], queryFn: () => api.listRunners() });
/** The Devices page's list: the computers and the newest myrel-runner. Refreshed with runnersQuery. */
export const runnerListQuery = queryOptions({ queryKey: ["runners", "list"], queryFn: () => api.runnerList() });
export const workspaceQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "workspace"], queryFn: () => api.getWorkspace(id) });
/** Every local folder of the project, one per computer, the default first. Refreshed with workspaceQuery. */
export const workspacesQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "workspace", "all"], queryFn: () => api.getWorkspaces(id) });
/** What the current server allows (e.g. whether new accounts can be created). */
export const serverInfoQuery = queryOptions({
  queryKey: ["server-info", server],
  queryFn: () => probeServer(server || location.origin),
  staleTime: Infinity,
});

// --- settings ---

export const billingQuery = queryOptions({ queryKey: ["billing"], queryFn: () => api.getBilling() });
export const meQuery = queryOptions({ queryKey: ["me"], queryFn: () => api.getMe() });
export const providersQuery = queryOptions({ queryKey: ["providers"], queryFn: () => api.listProviders() });
export const keysQuery = queryOptions({ queryKey: ["keys"], queryFn: () => api.listKeys() });
export const myInvitesQuery = queryOptions({ queryKey: ["invites"], queryFn: () => api.listMyInvites() });
export const adminSettingsQuery = queryOptions({ queryKey: ["admin-settings"], queryFn: () => api.getAdminSettings() });
export const projectSettingsQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "settings"], queryFn: () => api.getProjectSettings(id) });
export const projectInvitesQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id, "invites"], queryFn: () => api.listProjectInvites(id) });

/** A person's own connectors, or a project's. */
export const connectorsQuery = (projectId?: string) =>
  queryOptions({
    queryKey: projectId ? ["projects", projectId, "connectors"] : ["connectors"],
    queryFn: () => api.listConnectors(projectId),
  });

/** The caller's own skills and connectors, and which are on in this project. */
export const personalInProjectQuery = (projectId: string) =>
  queryOptions({ queryKey: ["projects", projectId, "personal"], queryFn: () => api.getPersonalInProject(projectId) });

/** A person's own skills, or a project's. */
export const skillsQuery = (projectId?: string) =>
  queryOptions({
    queryKey: projectId ? ["projects", projectId, "skills"] : ["skills"],
    queryFn: () => api.listSkills(projectId),
  });

/** The signed-in user's notifications. Polled so the bell updates on any page. */
export const notificationsQuery = queryOptions({
  queryKey: ["notifications"],
  queryFn: () => api.listNotifications(),
  refetchInterval: 30_000,
  staleTime: 10_000,
});
export const notificationConfigQuery = queryOptions({
  queryKey: ["notifications", "config"],
  queryFn: () => api.notificationConfig(),
  staleTime: Infinity,
});
export const notificationSettingsQuery = queryOptions({
  queryKey: ["notifications", "settings"],
  queryFn: () => api.notificationSettings(),
});
