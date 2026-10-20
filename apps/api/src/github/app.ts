/**
 * GitHub App plumbing: the app's JWT, installation access tokens and a small
 * REST helper. Everything runs on WebCrypto, so no Octokit in the Worker.
 */

const API = "https://api.github.com";

export type GithubEnv = Pick<
  Env,
  "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_CLIENT_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_CLIENT_SECRET"
>;

/** True when every setting the GitHub integration needs is present. The slug is read from GitHub (appSlug). */
export function githubConfigured(env: GithubEnv): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_CLIENT_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_CLIENT_SECRET);
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** Calls the GitHub REST API with a bearer token (app JWT, installation or user token). */
export async function githubFetch<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "myrel",
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubError(`GitHub ${init.method ?? "GET"} ${path} failed (${res.status}): ${detail.slice(0, 300)}`, res.status);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// --- App JWT ---

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function signingKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

/** A short-lived JWT that authenticates as the GitHub App itself. */
export async function appJwt(env: GithubEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GithubError("GitHub App is not configured", 503);
  const now = Math.floor(Date.now() / 1000);
  // Backdated a minute for clock drift; GitHub allows at most 10 minutes.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID };
  const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}`;
  const key = await signingKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(sig))}`;
}

let cachedSlug: { appId: string; slug: string; at: number } | null = null;

/**
 * The app's URL name (github.com/apps/<slug>). Read from GitHub, so renaming the app
 * on GitHub needs no setting here; GITHUB_APP_SLUG only covers GitHub being unreachable.
 */
export async function appSlug(env: GithubEnv): Promise<string> {
  const cached = cachedSlug;
  if (cached && cached.appId === env.GITHUB_APP_ID && Date.now() - cached.at < 10 * 60_000) return cached.slug;
  try {
    const app = await githubFetch<{ slug: string }>(await appJwt(env), "/app");
    cachedSlug = { appId: env.GITHUB_APP_ID!, slug: app.slug, at: Date.now() };
    return app.slug;
  } catch (err) {
    if (env.GITHUB_APP_SLUG) return env.GITHUB_APP_SLUG;
    throw err;
  }
}

// --- Installation tokens ---

export type RepoPermissions = Partial<
  Record<"contents" | "pull_requests" | "issues" | "metadata" | "checks" | "statuses", "read" | "write">
>;

type AccessToken = { token: string; expires_at: string; repositories?: GithubApiRepo[] };

/** The subset of GitHub's repository object Myrel uses. */
export type GithubApiRepo = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
};

const tokenCache = new Map<string, AccessToken>();

/**
 * An installation access token, optionally narrowed to some repositories and
 * permissions. GitHub answers 422 when a repository is not in the installation,
 * which makes this the check that a repo id really belongs to it.
 */
export async function installationToken(
  env: GithubEnv,
  installationId: number,
  scope: { repositoryIds?: number[]; permissions?: RepoPermissions } = {},
  /** How long the token must stay valid; tokens last an hour. */
  minValidMs = 5 * 60_000,
): Promise<AccessToken> {
  const cacheKey = JSON.stringify([installationId, scope]);
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.parse(cached.expires_at) - Date.now() > minValidMs) return cached;
  const body: Record<string, unknown> = {};
  if (scope.repositoryIds) body.repository_ids = scope.repositoryIds;
  if (scope.permissions) body.permissions = scope.permissions;
  const res = await githubFetch<AccessToken>(await appJwt(env), `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    body,
  });
  tokenCache.set(cacheKey, res);
  return res;
}

/** Every repository an installation can reach (GitHub caps a page at 100). */
export async function installationRepos(env: GithubEnv, installationId: number): Promise<GithubApiRepo[]> {
  const { token } = await installationToken(env, installationId);
  const repos: GithubApiRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await githubFetch<{ total_count: number; repositories: GithubApiRepo[] }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
    );
    repos.push(...res.repositories);
    if (repos.length >= res.total_count || res.repositories.length === 0) break;
  }
  return repos;
}

// --- User sign-in (OAuth), used to prove which installations a person can reach ---

export type UserInstallation = {
  id: number;
  account: { login: string; type: string; avatar_url?: string } | null;
};

/** Trades the OAuth `code` from the callback for a user token. */
export async function exchangeCode(env: GithubEnv, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "myrel" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new GithubError(`GitHub sign-in failed: ${data.error_description ?? res.status}`, 400);
  }
  return data.access_token;
}

/** Installations of this app the signed-in GitHub user has access to. */
export async function userInstallations(userToken: string): Promise<UserInstallation[]> {
  const all: UserInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await githubFetch<{ total_count: number; installations: UserInstallation[] }>(
      userToken,
      `/user/installations?per_page=100&page=${page}`,
    );
    all.push(...res.installations);
    if (all.length >= res.total_count || res.installations.length === 0) break;
  }
  return all;
}

// --- Encoding helpers ---

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only
 * imports PKCS#8, so a PKCS#1 key is wrapped in the PKCS#8 envelope here.
 * Secrets pasted with literal "\n" are accepted too.
 */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const text = pem.replace(/\\n/g, "\n");
  const isPkcs1 = text.includes("BEGIN RSA PRIVATE KEY");
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der.buffer;
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...rsaAlgorithm, 0x04, ...derLength(der.length), ...der];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]).buffer;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
