import { createDb, schema } from "@myrel/db";
import {
  CliId,
  type CliUsage,
  COORDINATOR_CLIS,
  type CoordinatorSettings,
  type MessageStats,
  type ProjectWorkspace,
  RunnerId,
  type TaskModel,
} from "@myrel/protocol";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getWorkspace, runnerHasFeature, workspaceClis } from "./runners";
import { resolveTaskModel } from "./task-model";

/** What projects.coordinator holds when the coordinator works with a CLI (CoordinatorSettings without the computer's name). */
export const StoredCoordinator = z.object({
  mode: z.literal("cli"),
  runnerId: RunnerId,
  cli: CliId,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** The computer's owner, who turned it on. */
  by: z.string(),
});
export type StoredCoordinator = z.infer<typeof StoredCoordinator>;

/** The coordinator's CLI setting from its JSON column; anything unreadable counts as none (the server's model). */
export function parseCoordinator(raw: string | null | undefined): StoredCoordinator | null {
  if (!raw) return null;
  try {
    return StoredCoordinator.nullable().catch(null).parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The project's coordinator CLI setting, if it has one. */
export async function projectCoordinator(env: Env, projectId: string): Promise<StoredCoordinator | null> {
  const [row] = await createDb(env.DB)
    .select({ coordinator: schema.projects.coordinator })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return parseCoordinator(row?.coordinator);
}

/**
 * The setting as the apps get it, with the computer's name. A computer that is gone, or no longer has the
 * project's folder, reads as the server's model, which is what the coordinator then works with.
 */
export async function coordinatorSettings(env: Env, projectId: string, raw: string | null | undefined): Promise<CoordinatorSettings> {
  const stored = parseCoordinator(raw);
  if (!stored) return { mode: "model" };
  const { runners, projectWorkspaces } = schema;
  const [runner] = await createDb(env.DB)
    .select({ name: runners.name })
    .from(projectWorkspaces)
    .innerJoin(runners, eq(runners.id, projectWorkspaces.runnerId))
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.runnerId, stored.runnerId)));
  if (!runner) return { mode: "model" };
  const { mode, runnerId, cli, model, effort, by } = stored;
  return { mode, runnerId, computer: runner.name, by, cli, model, effort };
}

/** Where a coordinator turn runs with its CLI: the computer's project folder (only to show it is shared), the CLI, its model. */
export type CoordinatorTarget = { workspace: ProjectWorkspace; cli: CliId; model?: TaskModel; by: string };

/**
 * Where the project's coordinator works this turn: null with the server's model (the setting), or its
 * CLI when that can run now; otherwise why not, and the server's model answers. The computer must still
 * be the project's and belong to the member who turned it on, be online, and have a runner and CLI that
 * can run the coordinator without the CLI's own tools.
 */
export async function coordinatorTarget(env: Env, projectId: string): Promise<{ ok: true; target: CoordinatorTarget } | { ok: false; reason: string } | null> {
  const stored = await projectCoordinator(env, projectId);
  if (!stored) return null;
  const { runnerId, cli, by } = stored;
  if (!(COORDINATOR_CLIS as readonly string[]).includes(cli)) return { ok: false, reason: `${cli} cannot work as the coordinator` };
  const db = createDb(env.DB);
  const [owner] = await db
    .select({ userId: schema.runners.userId })
    .from(schema.runners)
    .innerJoin(schema.projectMembers, and(eq(schema.projectMembers.userId, schema.runners.userId), eq(schema.projectMembers.projectId, projectId)))
    .where(eq(schema.runners.id, runnerId));
  if (owner?.userId !== by) return { ok: false, reason: "the computer is no longer the member's who set it" };
  const workspace = await getWorkspace(env, projectId, { runnerId });
  if (!workspace) return { ok: false, reason: "the project has no folder on the computer any more" };
  if (!workspace.online) return { ok: false, reason: `${workspace.runnerName} is offline` };
  if (!(await runnerHasFeature(env, runnerId, "coordinator"))) return { ok: false, reason: `myrel-runner on ${workspace.runnerName} is too old` };
  const installed = (await workspaceClis(env, projectId, { runnerId }))?.clis.find((c) => c.id === cli);
  if (!installed) return { ok: false, reason: `${cli} is not on ${workspace.runnerName} any more` };
  const model = resolveTaskModel(cli, null, { [cli]: { model: stored.model, effort: stored.effort } }, installed);
  return { ok: true, target: { workspace, cli, by, ...(model && { model }) } };
}

/**
 * A coordinator CLI turn's usage between the coordinator's messages, as its CLI reports it (running
 * totals). It costs the computer owner's subscription, so no cost.
 */
export class CliMeter {
  private since = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private takenInput = 0;
  private takenOutput = 0;
  private model = "";

  constructor(
    private readonly cli: CliId,
    private readonly computer: string,
  ) {}

  update(usage: CliUsage) {
    this.inputTokens = Math.max(this.inputTokens, usage.inputTokens);
    this.outputTokens = Math.max(this.outputTokens, usage.outputTokens);
    if (usage.model) this.model = usage.model;
  }

  /** Stats since the previous take, then starts counting afresh. */
  take(): MessageStats {
    const stats: MessageStats = {
      model: this.model,
      durationMs: Date.now() - this.since,
      calls: 0,
      inputTokens: this.inputTokens - this.takenInput,
      cachedInputTokens: 0,
      outputTokens: this.outputTokens - this.takenOutput,
      costMicros: null,
      runtime: "local",
      computer: this.computer,
      harness: this.cli,
    };
    this.since = Date.now();
    this.takenInput = this.inputTokens;
    this.takenOutput = this.outputTokens;
    return stats;
  }
}
