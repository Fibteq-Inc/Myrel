import { ApiClient } from "@altair/client";
import { QueryClient, queryOptions } from "@tanstack/react-query";

// Same-origin web app: Better Auth session cookies, no bearer token needed.
export const api = new ApiClient({ baseUrl: "" });

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
});

export const sessionQuery = queryOptions({ queryKey: ["session"], queryFn: () => api.getSession() });
export const projectsQuery = queryOptions({ queryKey: ["projects"], queryFn: () => api.listProjects() });
export const projectQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id], queryFn: () => api.getProject(id) });
