import type {
  CreateProjectInput,
  Instructions,
  Member,
  MemoryEntry,
  Message,
  Project,
  ProjectFile,
  PutMemoryInput,
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
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.contentType) headers["content-type"] = init.contentType;
    const token = await this.tokens?.get();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      credentials: "include",
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

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
