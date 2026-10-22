/**
 * Hooks a deployment can plug into the core, such as the hosted service's plans and billing
 * (in ee/). The core never imports an extension: a deployment's own entry module calls
 * `setExtensions` before it re-exports this Worker. Without one, nothing is limited.
 */

/** Whether something may happen now, and if not, the reason to show the person. */
export type LimitCheck = { ok: true } | { ok: false; reason: string };

/**
 * What a cloud turn still running has used: its priced model spend (millionths of a dollar), its
 * model calls that could not be priced, and its time so far.
 */
export type RunningTurn = { modelMicros: number; seconds: number; unpricedCalls?: number };

export type LegalLinks = { terms: string; privacy: string; version: string };

export type Extensions = {
  /** Whether this server sells plans, so clients show a billing page. */
  billing?: boolean;
  /** Before a person creates a project. */
  canCreateProject?: (env: Env, userId: string) => Promise<LimitCheck>;
  /**
   * Before a project's agent turn starts in a cloud sandbox, and again while it runs, with `running`:
   * what the turn has used so far (not yet in the usage tables). Local turns are never limited.
   */
  canUseSandbox?: (env: Env, projectId: string, running?: RunningTurn) => Promise<LimitCheck>;
  /** Before a coordinator turn. A project with its own model key is the extension's to exempt. */
  canUseCoordinator?: (env: Env, projectId: string) => Promise<LimitCheck>;
  /**
   * The terms and privacy policy people accept when they sign up: URLs, or paths on this server, and
   * a version (such as their effective date) recorded with each acceptance.
   */
  legal?: LegalLinks;
  /** Before a connector (MCP server) is added: a person's own, or a project's. */
  canAddConnector?: (env: Env, owner: { userId: string } | { projectId: string }) => Promise<LimitCheck>;
  /** Before a project file is stored: `bytes` would make the project's files take `total` bytes. */
  canStoreFile?: (env: Env, projectId: string, total: number) => Promise<LimitCheck>;
  /** Before a skill is added: a person's own, or a project's. */
  canAddSkill?: (env: Env, owner: { userId: string } | { projectId: string }) => Promise<LimitCheck>;
};

const ALLOWED: LimitCheck = { ok: true };
let current: Extensions = {};

export function setExtensions(extensions: Extensions) {
  current = extensions;
}

export async function canCreateProject(env: Env, userId: string): Promise<LimitCheck> {
  return current.canCreateProject ? current.canCreateProject(env, userId) : ALLOWED;
}

export async function canUseSandbox(env: Env, projectId: string, running?: RunningTurn): Promise<LimitCheck> {
  return current.canUseSandbox ? current.canUseSandbox(env, projectId, running) : ALLOWED;
}

export async function canUseCoordinator(env: Env, projectId: string): Promise<LimitCheck> {
  return current.canUseCoordinator ? current.canUseCoordinator(env, projectId) : ALLOWED;
}

export function sellsPlans(): boolean {
  return current.billing ?? false;
}

/**
 * The terms and privacy policy new accounts must accept, as absolute URLs, or null when this
 * server has none. TERMS_URL and PRIVACY_URL (both, with LEGAL_VERSION) take precedence over an extension's.
 */
export function legalLinks(env: Env, origin: string): LegalLinks | null {
  const links =
    env.TERMS_URL && env.PRIVACY_URL
      ? { terms: env.TERMS_URL, privacy: env.PRIVACY_URL, version: env.LEGAL_VERSION || "1" }
      : current.legal;
  if (!links) return null;
  return { terms: new URL(links.terms, origin).href, privacy: new URL(links.privacy, origin).href, version: links.version };
}

export async function canAddConnector(env: Env, owner: { userId: string } | { projectId: string }): Promise<LimitCheck> {
  return current.canAddConnector ? current.canAddConnector(env, owner) : ALLOWED;
}

export async function canAddSkill(env: Env, owner: { userId: string } | { projectId: string }): Promise<LimitCheck> {
  return current.canAddSkill ? current.canAddSkill(env, owner) : ALLOWED;
}

export async function canStoreFile(env: Env, projectId: string, total: number): Promise<LimitCheck> {
  return current.canStoreFile ? current.canStoreFile(env, projectId, total) : ALLOWED;
}
