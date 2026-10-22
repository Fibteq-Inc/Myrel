import type {
  AddProjectRepoInput,
  Artifact,
  ArtifactVersion,
  ArtifactView,
  AdminSettings,
  BillingSummary,
  ApiKey,
  CatalogCategory,
  CatalogPage,
  Connector,
  ConnectSuggestionInput,
  ConnectSuggestionResult,
  CreateApiKeyInput,
  CreateConnectorInput,
  CreateSkillInput,
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
  PairRunnerResult,
  Runner,
  RunnerDirListing,
  RunnerFolder,
  RunnerPairingCode,
  SetWorkspaceInput,
  Skill,
  SkillDetail,
  Task,
  ThreadFiles,
  TerminalLine,
  UpdateAdminSettingsInput,
  UpdateConnectorInput,
  UpdateSkillInput,
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

export type SessionUser = { id: string; name: string; email: string; emailVerified?: boolean; image?: string | null };
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
  /** The server's D1 bookmark from the latest answer: lets the next request read from a replica that has it. */
  private bookmark: string | null = null;

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
    if (this.bookmark) headers["x-d1-bookmark"] = this.bookmark;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      credentials: this.credentials,
    });
    // Bookmarks sort by position in the database's history; answers may arrive out of order.
    const bookmark = res.headers.get("x-d1-bookmark");
    if (bookmark && (!this.bookmark || bookmark > this.bookmark)) this.bookmark = bookmark;
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

  /** `acceptTerms` is required when the server's info lists legal documents. */
  signUp(input: { email: string; password: string; name: string; acceptTerms?: boolean }) {
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

  /** Sends the signed-in person a new link to verify their address; it comes back to `callbackURL`. */
  async sendVerificationEmail(email: string, callbackURL = "/") {
    await this.request("/api/auth/send-verification-email", { method: "POST", body: { email, callbackURL } });
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

  // --- connectors (MCP servers) ---

  /** A person's own connectors, or a project's when `projectId` is given. */
  private connectorsPath(projectId?: string) {
    return projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : "/api/account/connectors";
  }

  /** Searches the connector catalog (remote servers from the official MCP Registry). */
  searchConnectorCatalog(q = "", offset = 0, category?: CatalogCategory) {
    const params = new URLSearchParams({ q, offset: String(offset), ...(category && { category }) });
    return this.request<CatalogPage>(`/api/connectors/catalog?${params}`);
  }

  async listConnectors(projectId?: string) {
    return (await this.request<{ connectors: Connector[] }>(this.connectorsPath(projectId))).connectors;
  }

  /** Adds a connector. An OAuth one answers with `authorizeUrl`: open it so the person signs in. */
  createConnector(input: CreateConnectorInput, projectId?: string) {
    return this.request<{ connector: Connector; authorizeUrl?: string }>(this.connectorsPath(projectId), {
      method: "POST",
      body: input,
    });
  }

  async updateConnector(id: string, input: UpdateConnectorInput, projectId?: string) {
    return (
      await this.request<{ connector: Connector }>(`${this.connectorsPath(projectId)}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      })
    ).connector;
  }

  async deleteConnector(id: string, projectId?: string) {
    await this.request(`${this.connectorsPath(projectId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Reconnects and refreshes the tool list. */
  async checkConnector(id: string, projectId?: string) {
    return (
      await this.request<{ connector: Connector }>(`${this.connectorsPath(projectId)}/${encodeURIComponent(id)}/check`, {
        method: "POST",
        body: {},
      })
    ).connector;
  }

  // --- personal skills and connectors in a project ---

  /** The caller's own skills and connectors, each saying whether it is on in this project (they start off). */
  getPersonalInProject(projectId: string) {
    return this.request<{ skills: (Skill & { inProject: boolean })[]; connectors: (Connector & { inProject: boolean })[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/personal`,
    );
  }

  async setPersonalInProject(projectId: string, kind: "skills" | "connectors", id: string, on: boolean) {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/personal/${kind}/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { on },
    });
  }

  // --- connector suggestions in a thread ---

  private suggestionPath(projectId: string, threadId: string, suggestionId: string) {
    return `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/connector-suggestions/${encodeURIComponent(suggestionId)}`;
  }

  /**
   * Connects one of a suggestion card's offers as the caller's own connector, on in this project.
   * An answer with `authorizeUrl` needs a sign-in, which comes back to the thread. A Free plan at
   * its limit fails with 402 (`error: "limit_reached"`).
   */
  connectSuggestion(projectId: string, threadId: string, suggestionId: string, input: ConnectSuggestionInput) {
    return this.request<ConnectSuggestionResult>(`${this.suggestionPath(projectId, threadId, suggestionId)}/connect`, { method: "POST", body: input });
  }

  /** Not now: the card closes and the agent does not offer these connectors again in this thread. */
  async dismissSuggestion(projectId: string, threadId: string, suggestionId: string) {
    await this.request(`${this.suggestionPath(projectId, threadId, suggestionId)}/dismiss`, { method: "POST", body: {} });
  }

  // --- skills ---

  /** A person's own skills, or a project's when `projectId` is given. */
  private skillsPath(projectId?: string) {
    return projectId ? `/api/projects/${encodeURIComponent(projectId)}/skills` : "/api/account/skills";
  }

  async listSkills(projectId?: string) {
    return (await this.request<{ skills: Skill[] }>(this.skillsPath(projectId))).skills;
  }

  /** One skill with its SKILL.md. */
  async getSkill(id: string, projectId?: string) {
    return (await this.request<{ skill: SkillDetail }>(`${this.skillsPath(projectId)}/${encodeURIComponent(id)}`)).skill;
  }

  /**
   * Adds a skill. A GitHub source with several skills fails with 409 and a SkillChoices body
   * (`error: "choose_skill"`): add again with `skill` set to one of them.
   */
  async createSkill(input: CreateSkillInput, projectId?: string) {
    return (await this.request<{ skill: Skill }>(this.skillsPath(projectId), { method: "POST", body: input })).skill;
  }

  async updateSkill(id: string, input: UpdateSkillInput, projectId?: string) {
    return (
      await this.request<{ skill: Skill }>(`${this.skillsPath(projectId)}/${encodeURIComponent(id)}`, { method: "PATCH", body: input })
    ).skill;
  }

  /** Takes a GitHub skill again from its branch as it is now. `changed` is false when nothing moved. */
  updateSkillFromSource(id: string, projectId?: string) {
    return this.request<{ skill: Skill; changed: boolean }>(`${this.skillsPath(projectId)}/${encodeURIComponent(id)}/update`, {
      method: "POST",
      body: {},
    });
  }

  async deleteSkill(id: string, projectId?: string) {
    await this.request(`${this.skillsPath(projectId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** A sign-in link for an OAuth connector. */
  async authorizeConnector(id: string, projectId?: string) {
    return (
      await this.request<{ authorizeUrl: string }>(`${this.connectorsPath(projectId)}/${encodeURIComponent(id)}/authorize`, {
        method: "POST",
        body: {},
      })
    ).authorizeUrl;
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

  /** A file in the project's local folders, read from the computer (only its owner can). */
  async getLocalFile(projectId: string, path: string, threadId?: string): Promise<Blob> {
    const thread = threadId ? `&thread=${encodeURIComponent(threadId)}` : "";
    const res = await this.send(`${projectPath(projectId)}/workspace/file?path=${encodeURIComponent(path)}${thread}`);
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

  // --- plans and billing (hosted service only; see ServerInfo.billing) ---

  getBilling() {
    return this.request<BillingSummary>("/api/billing");
  }

  /** A Stripe Checkout URL for Pro or Team. */
  startCheckout(input: { plan: "pro" | "team"; interval: "month" | "year"; seats?: number }) {
    return this.request<{ url: string }>("/api/billing/checkout", { method: "POST", body: input });
  }

  /** A Stripe billing portal URL: change plan or card, cancel, invoices. */
  openBillingPortal() {
    return this.request<{ url: string }>("/api/billing/portal", { method: "POST", body: {} });
  }

  /** Reads the caller's App Store / Google Play subscriptions again, right after a purchase in the mobile app. */
  syncStorePurchases() {
    return this.request<null>("/api/billing/store/sync", { method: "POST", body: {} });
  }

  addTeamMember(email: string) {
    return this.request<null>("/api/billing/team/members", { method: "POST", body: { email } });
  }

  removeTeamMember(userId: string) {
    return this.request<null>(`/api/billing/team/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  /** Leaves the Team plan someone added this person to. */
  leaveTeam() {
    return this.request<null>("/api/billing/team/membership", { method: "DELETE" });
  }

  // --- local computers (myrel-runner) ---

  async listRunners() {
    return (await this.request<{ runners: Runner[] }>("/api/runners")).runners;
  }

  /** A short-lived code for `myrel-runner pair`. */
  createPairingCode() {
    return this.request<RunnerPairingCode>("/api/runners/pairing", { method: "POST", body: {} });
  }

  /** Trades a pairing code for a runner login, as `myrel-runner pair` does (the desktop app pairs itself). */
  pairRunner(input: { code: string; name: string; hostname?: string; platform?: string }) {
    return this.request<PairRunnerResult>("/api/runner/pair", { method: "POST", body: input });
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

  /** Adds one of the computer's shared folders to the project's other folders. */
  async addWorkspaceFolder(projectId: string, path: string) {
    return (
      await this.request<{ workspace: ProjectWorkspace }>(`/api/projects/${encodeURIComponent(projectId)}/workspace/folders`, {
        method: "POST",
        body: { path },
      })
    ).workspace;
  }

  async removeWorkspaceFolder(projectId: string, path: string) {
    const url = `/api/projects/${encodeURIComponent(projectId)}/workspace/folders?path=${encodeURIComponent(path)}`;
    return (await this.request<{ workspace: ProjectWorkspace }>(url, { method: "DELETE" })).workspace;
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
