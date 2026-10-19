/**
 * Origins the Altair desktop app (Tauri 2) serves its UI from. Web pages
 * cannot claim these, so they are always trusted alongside TRUSTED_ORIGINS.
 */
export const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export function trustedOrigins(env: Pick<Env, "TRUSTED_ORIGINS">): string[] {
  const extra = env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()) : [];
  return [...DESKTOP_ORIGINS, ...extra.filter(Boolean)];
}
