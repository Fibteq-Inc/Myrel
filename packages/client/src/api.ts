import type {
  AdminSettings,
  ApiKey,
  CreateApiKeyInput,
  CreateInviteInput,
  CreateProjectInput,
  Invite,
  Me,
  Member,
  Message,
  Project,
  ProjectRole,
  ProjectSettings,
  ProviderId,
  ProviderInfo,
  Task,
  TerminalLine,
  UpdateAdminSettingsInput,
  UpdateProjectSettingsInput,
  UsageSummary,
} from "@altair/protocol";
import type { TokenStore } from "./token-store";

export type ApiClientOptions = {
  /** Origin of the API, e.g. "https://altair.example.com". Empty string = same origin (web). */
  baseUrl: string;
  /** Bearer token storage. Omit to use cookies only (same-origin web). */
  tokens?: TokenStore;
  fetch?: typeof fetch;
};

export type SessionUser = { id: string; name: string; email: string; image?: string | null };
export type Session = { user: SessionUser; session: { id: string; expiresAt: string } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body && "message" in body ? String(body.message) : `Request failed (${status})`,
    );
  }
}

export class ApiClient {
  readonly baseUrl: string;
  readonly tokens?: TokenStore;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const token = await this.tokens?.get();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "include",
    });
    // Better Auth's bearer plugin returns the session token in this header.
    const issued = res.headers.get("set-auth-token");
    if (issued) await this.tokens?.set(issued);

    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  // --- auth (Better Auth endpoints) ---

  signUp(input: { email: string; password: string; name: string }) {
    return this.request<{ user: SessionUser }>("/api/auth/sign-up/email", { method: "POST", body: input });
  }

  signIn(input: { email: string; password: string }) {
    return this.request<{ user: SessionUser }>("/api/auth/sign-in/email", { method: "POST", body: input });
  }

  async signOut() {
    try {
      await this.request("/api/auth/sign-out", { method: "POST", body: {} });
    } finally {
      await this.tokens?.set(null);
    }
  }

  getSession() {
    return this.request<Session | null>("/api/auth/get-session");
  }

  // --- projects ---

  async listProjects() {
    return (await this.request<{ projects: Project[] }>("/api/projects")).projects;
  }

  async createProject(input: CreateProjectInput) {
    return (await this.request<{ project: Project }>("/api/projects", { method: "POST", body: input })).project;
  }

  async getProject(id: string) {
    return (await this.request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`)).project;
  }

  async listMembers(projectId: string) {
    return (await this.request<{ members: Member[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`)).members;
  }

  async getProjectSettings(projectId: string) {
    return (await this.request<{ settings: ProjectSettings }>(`${projectPath(projectId)}/settings`)).settings;
  }

  async updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput) {
    return (
      await this.request<{ settings: ProjectSettings }>(`${projectPath(projectId)}/settings`, {
        method: "PATCH",
        body: input,
      })
    ).settings;
  }

  async updateMemberRole(projectId: string, userId: string, role: ProjectRole) {
    await this.request(`${projectPath(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: { role },
    });
  }

  /** Removes a member; pass your own id to leave the project. */
  async removeMember(projectId: string, userId: string) {
    await this.request(`${projectPath(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  async listProjectInvites(projectId: string) {
    return (await this.request<{ invites: Invite[] }>(`${projectPath(projectId)}/invites`)).invites;
  }

  async invite(projectId: string, input: CreateInviteInput) {
    return (await this.request<{ invite: Invite }>(`${projectPath(projectId)}/invites`, { method: "POST", body: input }))
      .invite;
  }

  async revokeInvite(projectId: string, inviteId: string) {
    await this.request(`${projectPath(projectId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
  }

  // --- account ---

  async getMe() {
    return (await this.request<{ user: Me }>("/api/account")).user;
  }

  /** Better Auth endpoint. */
  async updateProfile(input: { name: string }) {
    await this.request("/api/auth/update-user", { method: "POST", body: input });
  }

  /** Better Auth endpoint. */
  async changePassword(input: { currentPassword: string; newPassword: string }) {
    await this.request("/api/auth/change-password", { method: "POST", body: { ...input, revokeOtherSessions: true } });
  }

  listProviders() {
    return this.request<{ providers: ProviderInfo[]; serverDefault: ProviderId }>("/api/account/providers");
  }

  async listKeys() {
    return (await this.request<{ keys: ApiKey[] }>("/api/account/keys")).keys;
  }

  async addKey(input: CreateApiKeyInput) {
    return (await this.request<{ key: ApiKey }>("/api/account/keys", { method: "POST", body: input })).key;
  }

  async deleteKey(id: string) {
    await this.request(`/api/account/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listMyInvites() {
    return (await this.request<{ invites: Invite[] }>("/api/account/invites")).invites;
  }

  async acceptInvite(id: string) {
    return this.request<{ projectId: string }>(`/api/account/invites/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: {},
    });
  }

  async declineInvite(id: string) {
    await this.request(`/api/account/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // --- server administration ---

  async getAdminSettings() {
    return (await this.request<{ settings: AdminSettings }>("/api/admin/settings")).settings;
  }

  async updateAdminSettings(input: UpdateAdminSettingsInput) {
    return (await this.request<{ settings: AdminSettings }>("/api/admin/settings", { method: "PATCH", body: input }))
      .settings;
  }

  getMessages(projectId: string, afterSeq = 0) {
    return this.request<{ messages: Message[]; hasMore: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/messages?after=${afterSeq}`,
    );
  }

  // --- tasks (run_task) ---

  /** A thread's tasks with their recent terminal output. */
  async listTasks(projectId: string, threadId: string) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/tasks`;
    return (await this.request<{ tasks: (Task & { log: TerminalLine[] })[] }>(path)).tasks;
  }

  cancelTask(projectId: string, threadId: string, taskId: string) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(taskId)}/cancel`;
    return this.request<{ ok: true }>(path, { method: "POST", body: {} });
  }

  // --- usage ---

  /** Model usage across the caller's projects, bucketed by day in the caller's time zone. */
  getUsage(input: { days: number; projectId?: string | null; tzOffset?: number }) {
    const query = new URLSearchParams({ days: String(input.days), tzOffset: String(input.tzOffset ?? 0) });
    if (input.projectId) query.set("projectId", input.projectId);
    return this.request<UsageSummary>(`/api/usage?${query}`);
  }

  /** WebSocket URL for a project's live channel, with the bearer token in the query if present. */
  async projectSocketUrl(projectId: string): Promise<string> {
    // String ops instead of URL setters: React Native's URL polyfill doesn't implement them.
    const origin = (this.baseUrl || globalThis.location?.origin || "").replace(/^http/, "ws");
    const token = await this.tokens?.get();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${origin}/api/projects/${encodeURIComponent(projectId)}/ws${query}`;
  }
}

function projectPath(id: string) {
  return `/api/projects/${encodeURIComponent(id)}`;
}
