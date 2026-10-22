import { createDb, schema } from "@myrel/db";
import type { GithubInstallation, ProjectRepo } from "@myrel/protocol";
import { and, eq } from "drizzle-orm";
import { type GithubEnv, installationToken, type RepoPermissions, type UserInstallation } from "./app";

const { githubAccounts, githubInstallations, githubInstallationUsers, projectRepos } = schema;

/** Installations the user proved access to with their GitHub sign-in. */
export async function listUserInstallations(db: D1Database, userId: string): Promise<GithubInstallation[]> {
  return createDb(db)
    .select({
      id: githubInstallations.id,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      accountAvatarUrl: githubInstallations.accountAvatarUrl,
    })
    .from(githubInstallationUsers)
    .innerJoin(githubInstallations, eq(githubInstallations.id, githubInstallationUsers.installationId))
    .where(eq(githubInstallationUsers.userId, userId))
    .orderBy(githubInstallations.accountLogin);
}

/**
 * How long what GitHub reported at the person's last sign-in is trusted for picking repositories.
 * Myrel keeps no GitHub token of theirs, so access they lost on GitHub (left the organization, say)
 * shows only at the next sign-in; after this long they sign in again, which GitHub does without a
 * prompt for an app they already authorized.
 */
export const GITHUB_GRANT_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Whether the person may pick repositories of the installation: "ok", "stale" when their last
 * GitHub sign-in is too old to go by (see GITHUB_GRANT_TTL_MS), or "no".
 */
export async function canUseInstallation(db: D1Database, userId: string, installationId: number, now = Date.now()): Promise<"ok" | "stale" | "no"> {
  const [row] = await createDb(db)
    .select({ at: githubInstallationUsers.createdAt })
    .from(githubInstallationUsers)
    .where(and(eq(githubInstallationUsers.userId, userId), eq(githubInstallationUsers.installationId, installationId)))
    .limit(1);
  if (!row) return "no";
  return now - row.at.getTime() > GITHUB_GRANT_TTL_MS ? "stale" : "ok";
}

/** Whether the person's last GitHub sign-in is too old to list repositories by (see GITHUB_GRANT_TTL_MS). */
export async function githubGrantStale(db: D1Database, userId: string, now = Date.now()): Promise<boolean> {
  const [row] = await createDb(db)
    .select({ at: githubInstallationUsers.createdAt })
    .from(githubInstallationUsers)
    .where(eq(githubInstallationUsers.userId, userId))
    .limit(1);
  return Boolean(row && now - row.at.getTime() > GITHUB_GRANT_TTL_MS);
}

/**
 * Replaces the user's installation list with what GitHub just reported for
 * them, so access they lost on GitHub is dropped here too.
 */
export async function syncUserInstallations(db: D1Database, userId: string, installs: UserInstallation[]) {
  const d = createDb(db);
  const now = new Date();
  const writes = installs
    .filter((i) => i.account)
    .flatMap((i) => [
      d
        .insert(githubInstallations)
        .values({
          id: i.id,
          accountLogin: i.account!.login,
          accountType: i.account!.type === "Organization" ? "Organization" : "User",
          accountAvatarUrl: i.account!.avatar_url ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: githubInstallations.id,
          set: { accountLogin: i.account!.login, accountAvatarUrl: i.account!.avatar_url ?? null, updatedAt: now },
        }),
      d.insert(githubInstallationUsers).values({ installationId: i.id, userId, createdAt: now }).onConflictDoNothing(),
    ]);
  await d.batch([d.delete(githubInstallationUsers).where(eq(githubInstallationUsers.userId, userId)), ...writes]);
}

/** Remembers which GitHub account the user connected, so pull requests can credit and assign them. */
export async function saveGithubAccount(db: D1Database, userId: string, account: { id: number; login: string }) {
  const now = new Date();
  await createDb(db)
    .insert(githubAccounts)
    .values({ userId, githubId: account.id, login: account.login, updatedAt: now })
    .onConflictDoUpdate({ target: githubAccounts.userId, set: { githubId: account.id, login: account.login, updatedAt: now } });
}

/** The GitHub login of a Myrel user, when they connected GitHub. */
export async function githubLogin(db: D1Database, userId: string): Promise<string | null> {
  const [row] = await createDb(db).select({ login: githubAccounts.login }).from(githubAccounts).where(eq(githubAccounts.userId, userId));
  return row?.login ?? null;
}

export async function listProjectRepos(db: D1Database, projectId: string): Promise<ProjectRepo[]> {
  const rows = await createDb(db)
    .select({
      repoId: projectRepos.repoId,
      installationId: projectRepos.installationId,
      fullName: projectRepos.fullName,
      defaultBranch: projectRepos.defaultBranch,
      private: projectRepos.private,
      createdAt: projectRepos.createdAt,
    })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .orderBy(projectRepos.fullName);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * A token for one of the project's repositories, limited to that repository
 * and to `permissions`. This is what thread agents (and later the sandbox
 * runners that clone and open pull requests) work through.
 */
export async function projectRepoToken(
  env: GithubEnv & { DB: D1Database },
  projectId: string,
  fullName: string,
  permissions: RepoPermissions = { contents: "read", metadata: "read" },
  minValidMs?: number,
): Promise<{ token: string; repo: ProjectRepo }> {
  const repos = await listProjectRepos(env.DB, projectId);
  const repo = repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repo) {
    const names = repos.map((r) => r.fullName).join(", ") || "none";
    throw new Error(`${fullName} is not connected to this project (connected: ${names})`);
  }
  const { token } = await installationToken(env, repo.installationId, { repositoryIds: [repo.repoId], permissions }, minValidMs);
  return { token, repo };
}
