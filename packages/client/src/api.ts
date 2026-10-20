import type {
  AddProjectRepoInput,
  Artifact,
  ArtifactVersion,
  ArtifactView,
  AdminSettings,
  ApiKey,
  CreateApiKeyInput,
  CreateInviteInput,
  CreateProjectInput,
  Instructions,
  GithubRepo,
  GithubStatus,
  Invite,
  Me,
  Member,
  MemoryEntry,
  Message,
  Project,
  ProjectFile,
  ProjectRepo,
  ProjectRole,
  ProjectSettings,
  ProjectWorkspace,
  ProviderId,
  ProviderInfo,
  PullRequest,
  PutMemoryInput,
  Runner,
  RunnerDirListing,
  RunnerFolder,
  RunnerPairingCode,
  SetWorkspaceInput,
  Task,
  ThreadFiles,
  TerminalLine,
  UpdateAdminSettingsInput,
  UpdateProjectSettingsInput,
  CreateRoutineInputRaw,
  Notification,
  NotificationConfig,
  NotificationSettings,
  PushSubscriptionInput,
  Routine,
  UpdateRoutineInputRaw,
  UsageSummary,
} from "@myrel/protocol";
import type { TokenStore } from "./token-store";

export type ApiClientOptions = {
  /** Origin of the API, e.g. "https://myrel.example.com". Empty string = same origin (web). */
  baseUrl: string;
  /** Bearer token storage. Omit to use cookies only (same-origin web). */
  tokens?: TokenStore;
  fetch?: typeof fetch;
  /** Sent with every request, e.g. the mobile app's `origin: myrel://`. */
  headers?: Record<string, string>;
  /** Native apps use "omit": they authenticate with the bearer token, never with cookies. */
  credentials?: RequestCredentials;
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
  private readonly headers: Record<string, string>;
  private readonly credentials: RequestCredentials;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.headers = options.headers ?? {};
    this.credentials = options.credentials ?? "include";
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.send(path, {
      method: init.method,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      contentType: init.body === undefined ? undefined : "application/json",
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  /** Raw fetch with auth applied. Use `request` for JSON endpoints. */
  async send(path: string, init: { method?: string; body?: BodyInit; contentType?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers, accept: "application/json" };
    if (init.contentType) headers["content-type"] = init.contentType;
    const token = await this.tokens?.get();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      credentials: this.credentials,
    });
    // Better Auth's bearer plugin returns the session token in this header.
    const issued = res.headers.get("set-auth-token");
    if (issued) await this.tokens?.set(issued);
    return res;
  }

  private async sendJson<T>(path: string, init: { method: string; body: BodyInit; contentType: string }): Promise<T> {
    const res = await this.send(path, init);
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

  /** Deletes the project and all its data for everyone. Owners only. */
  async deleteProject(projectId: string) {
    await this.request(projectPath(projectId), { method: "DELETE" });
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

  /** Deletes the signed-in account for good; projects only this person owns go with it. */
  async deleteAccount() {
    await this.request("/api/account", { method: "DELETE" });
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

  // --- GitHub ---

  getGithubStatus() {
    return this.request<GithubStatus>("/api/github");
  }

  async listGithubRepos() {
    return (await this.request<{ repos: GithubRepo[] }>("/api/github/repos")).repos;
  }

  /**
   * Where the browser goes to connect GitHub: `install` adds the app to an
   * account, `authorize` only signs in to pick up existing installations.
   * It needs the cookie session, so it works from the web app, not a native shell.
   */
  githubConnectUrl(mode: "install" | "authorize", returnTo: string) {
    return `${this.baseUrl}/api/github/connect?mode=${mode}&returnTo=${encodeURIComponent(returnTo)}`;
  }

  async listProjectRepos(projectId: string) {
    return (await this.request<{ repos: ProjectRepo[] }>(`/api/projects/${encodeURIComponent(projectId)}/repos`)).repos;
  }

  async addProjectRepo(projectId: string, input: AddProjectRepoInput) {
    return (
      await this.request<{ repo: ProjectRepo }>(`/api/projects/${encodeURIComponent(projectId)}/repos`, {
        method: "POST",
        body: input,
      })
    ).repo;
  }

  async removeProjectRepo(projectId: string, repoId: number) {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/repos/${repoId}`, { method: "DELETE" });
  }

  getMessages(projectId: string, afterSeq = 0) {
    return this.request<{ messages: Message[]; hasMore: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/messages?after=${afterSeq}`,
    );
  }

  // --- project knowledge: instructions, memory, files ---

  async getInstructions(projectId: string) {
    return (await this.request<{ instructions: Instructions }>(`${projectPath(projectId)}/instructions`)).instructions;
  }

  async setInstructions(projectId: string, text: string) {
    const path = `${projectPath(projectId)}/instructions`;
    return (await this.request<{ instructions: Instructions }>(path, { method: "PUT", body: { text } })).instructions;
  }

  async listMemory(projectId: string) {
    return (await this.request<{ memory: MemoryEntry[] }>(`${projectPath(projectId)}/memory`)).memory;
  }

  async putMemory(projectId: string, name: string, input: PutMemoryInput) {
    const path = `${projectPath(projectId)}/memory/${encodeURIComponent(name)}`;
    return (await this.request<{ memory: MemoryEntry }>(path, { method: "PUT", body: input })).memory;
  }

  async deleteMemory(projectId: string, name: string) {
    await this.request(`${projectPath(projectId)}/memory/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async listFiles(projectId: string, prefix = "") {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    return (await this.request<{ files: ProjectFile[] }>(`${projectPath(projectId)}/files${query}`)).files;
  }

  /** A file's bytes. Fetched (not linked) so bearer-token apps can preview too. */
  async getFile(projectId: string, path: string): Promise<Blob> {
    const res = await this.send(`${projectPath(projectId)}/files/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.blob();
  }

  async putFile(projectId: string, path: string, body: Blob) {
    const url = `${projectPath(projectId)}/files/content?path=${encodeURIComponent(path)}`;
    const init = { method: "PUT", body, contentType: body.type || "application/octet-stream" };
    return (await this.sendJson<{ file: ProjectFile }>(url, init)).file;
  }

  async deleteFile(projectId: string, path: string) {
    await this.request(`${projectPath(projectId)}/files/content?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  }

  /** Uploads a file to attach to a message; send its `path` in `message.send`'s attachments. */
  async upload(projectId: string, name: string, body: Blob) {
    const url = `${projectPath(projectId)}/uploads?name=${encodeURIComponent(name)}`;
    const init = { method: "POST", body, contentType: body.type || "application/octet-stream" };
    return (await this.sendJson<{ file: ProjectFile }>(url, init)).file;
  }

  // --- tasks (run_task) ---

  /** A thread's tasks with their recent terminal output. */
  async listTasks(projectId: string, threadId: string) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/tasks`;
    return (await this.request<{ tasks: (Task & { log: TerminalLine[] })[] }>(path)).tasks;
  }

  /** Pull requests the thread's tasks opened, with their live state. */
  async listPullRequests(projectId: string, threadId: string) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/pull-requests`;
    return (await this.request<{ pullRequests: PullRequest[] }>(path)).pullRequests;
  }

  /** What the thread's cloud tasks saved: history and the folder or file at `path`. Null when nothing was saved. */
  async threadFiles(projectId: string, threadId: string, path = "") {
    const base = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/files`;
    return (await this.request<{ workspace: ThreadFiles | null }>(`${base}?path=${encodeURIComponent(path)}`)).workspace;
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

  // --- local computers (myrel-runner) ---

  async listRunners() {
    return (await this.request<{ runners: Runner[] }>("/api/runners")).runners;
  }

  /** A short-lived code for `myrel-runner pair`. */
  createPairingCode() {
    return this.request<RunnerPairingCode>("/api/runners/pairing", { method: "POST", body: {} });
  }

  removeRunner(id: string) {
    return this.request<{ ok: true }>(`/api/runners/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Folders inside `path` on one of your computers (its home folder when absent). */
  listRunnerDirs(id: string, path?: string) {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<RunnerDirListing>(`/api/runners/${encodeURIComponent(id)}/dirs${query}`);
  }

  /** Shares a folder on one of your computers, so projects can work in it. */
  async shareRunnerFolder(id: string, path: string) {
    return (
      await this.request<{ folders: RunnerFolder[] }>(`/api/runners/${encodeURIComponent(id)}/folders`, {
        method: "POST",
        body: { path },
      })
    ).folders;
  }

  async unshareRunnerFolder(id: string, path: string) {
    const url = `/api/runners/${encodeURIComponent(id)}/folders?path=${encodeURIComponent(path)}`;
    return (await this.request<{ folders: RunnerFolder[] }>(url, { method: "DELETE" })).folders;
  }

  async getWorkspace(projectId: string) {
    return (
      await this.request<{ workspace: ProjectWorkspace | null }>(`/api/projects/${encodeURIComponent(projectId)}/workspace`)
    ).workspace;
  }

  async setWorkspace(projectId: string, input: SetWorkspaceInput) {
    return (
      await this.request<{ workspace: ProjectWorkspace }>(`/api/projects/${encodeURIComponent(projectId)}/workspace`, {
        method: "PUT",
        body: input,
      })
    ).workspace;
  }

  async clearWorkspace(projectId: string) {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/workspace`, { method: "DELETE" });
  }

  // --- artifacts ---

  private artifactsPath(projectId: string, artifactId?: string) {
    const base = `/api/projects/${encodeURIComponent(projectId)}/artifacts`;
    return artifactId ? `${base}/${encodeURIComponent(artifactId)}` : base;
  }

  async listArtifacts(projectId: string) {
    return (await this.request<{ artifacts: Artifact[] }>(this.artifactsPath(projectId))).artifacts;
  }

  getArtifact(projectId: string, artifactId: string) {
    return this.request<{ artifact: Artifact; versions: ArtifactVersion[] }>(this.artifactsPath(projectId, artifactId));
  }

  /** A signed, short-lived link to frame one version (default: latest) from the artifact origin. */
  artifactView(projectId: string, artifactId: string, version?: number) {
    const query = version ? `?version=${version}` : "";
    return this.request<ArtifactView>(`${this.artifactsPath(projectId, artifactId)}/view${query}`);
  }

  /** One version's HTML source, as text. */
  async artifactSource(projectId: string, artifactId: string, version: number): Promise<string> {
    const headers: Record<string, string> = { ...this.headers };
    const token = await this.tokens?.get();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${this.artifactsPath(projectId, artifactId)}/versions/${version}/source`, {
      headers,
      credentials: this.credentials,
    });
    if (!res.ok) throw new ApiError(res.status, null);
    return res.text();
  }

  // --- routines ---

  private routinesPath(projectId: string, routineId?: string) {
    const base = `/api/projects/${encodeURIComponent(projectId)}/routines`;
    return routineId ? `${base}/${encodeURIComponent(routineId)}` : base;
  }

  async listRoutines(projectId: string) {
    return (await this.request<{ routines: Routine[] }>(this.routinesPath(projectId))).routines;
  }

  async createRoutine(projectId: string, input: CreateRoutineInputRaw) {
    return (await this.request<{ routine: Routine }>(this.routinesPath(projectId), { method: "POST", body: input }))
      .routine;
  }

  async updateRoutine(projectId: string, routineId: string, patch: UpdateRoutineInputRaw) {
    const path = this.routinesPath(projectId, routineId);
    return (await this.request<{ routine: Routine }>(path, { method: "PATCH", body: patch })).routine;
  }

  async runRoutine(projectId: string, routineId: string) {
    const path = `${this.routinesPath(projectId, routineId)}/run`;
    return (await this.request<{ routine: Routine }>(path, { method: "POST", body: {} })).routine;
  }

  async deleteRoutine(projectId: string, routineId: string) {
    await this.request(this.routinesPath(projectId, routineId), { method: "DELETE" });
  }

  // --- notifications ---

  listNotifications(limit = 50) {
    return this.request<{ notifications: Notification[]; unread: number }>(`/api/notifications?limit=${limit}`);
  }

  async markNotificationsRead(ids: string[] | "all") {
    await this.request("/api/notifications/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
  }

  notificationConfig() {
    return this.request<NotificationConfig>("/api/notifications/config");
  }

  notificationSettings() {
    return this.request<NotificationSettings>("/api/notifications/settings");
  }

  updateNotificationSettings(patch: Partial<NotificationSettings>) {
    return this.request<NotificationSettings>("/api/notifications/settings", { method: "PUT", body: patch });
  }

  /** Registers this device for push: a browser's Web Push subscription or the mobile app's Expo token. */
  async registerPush(input: PushSubscriptionInput) {
    await this.request("/api/notifications/subscriptions", { method: "POST", body: input });
  }

  async unregisterPush(endpoint: string) {
    await this.request("/api/notifications/subscriptions", { method: "DELETE", body: { endpoint } });
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
