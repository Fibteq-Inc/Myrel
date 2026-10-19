import { createDb, schema } from "@altair/db";
import type { GithubInstallation, ProjectRepo } from "@altair/protocol";
import { and, eq } from "drizzle-orm";
import { type GithubEnv, installationToken, type RepoPermissions, type UserInstallation } from "./app";

const { githubInstallations, githubInstallationUsers, projectRepos } = schema;

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

export async function canUseInstallation(db: D1Database, userId: string, installationId: number): Promise<boolean> {
  const [row] = await createDb(db)
    .select({ id: githubInstallationUsers.installationId })
    .from(githubInstallationUsers)
    .where(and(eq(githubInstallationUsers.userId, userId), eq(githubInstallationUsers.installationId, installationId)))
    .limit(1);
  return !!row;
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
): Promise<{ token: string; repo: ProjectRepo }> {
  const repos = await listProjectRepos(env.DB, projectId);
  const repo = repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repo) {
    const names = repos.map((r) => r.fullName).join(", ") || "none";
    throw new Error(`${fullName} is not connected to this project (connected: ${names})`);
  }
  const { token } = await installationToken(env, repo.installationId, { repositoryIds: [repo.repoId], permissions });
  return { token, repo };
}
