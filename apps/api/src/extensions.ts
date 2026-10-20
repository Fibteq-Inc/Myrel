/**
 * Hooks a deployment can plug into the core, such as the hosted service's plans and billing
 * (in ee/). The core never imports an extension: a deployment's own entry module calls
 * `setExtensions` before it re-exports this Worker. Without one, nothing is limited.
 */

/** Whether something may happen now, and if not, the reason to show the person. */
export type LimitCheck = { ok: true } | { ok: false; reason: string };

export type Extensions = {
  /** Before a person creates a project. */
  canCreateProject?: (env: Env, userId: string) => Promise<LimitCheck>;
  /** Before a project's agent turn starts in a cloud sandbox. Local turns are never limited. */
  canUseSandbox?: (env: Env, projectId: string) => Promise<LimitCheck>;
};

const ALLOWED: LimitCheck = { ok: true };
let current: Extensions = {};

export function setExtensions(extensions: Extensions) {
  current = extensions;
}

export async function canCreateProject(env: Env, userId: string): Promise<LimitCheck> {
  return current.canCreateProject ? current.canCreateProject(env, userId) : ALLOWED;
}

export async function canUseSandbox(env: Env, projectId: string): Promise<LimitCheck> {
  return current.canUseSandbox ? current.canUseSandbox(env, projectId) : ALLOWED;
}
