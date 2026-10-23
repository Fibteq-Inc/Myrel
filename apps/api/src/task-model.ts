import { createDb, schema } from "@myrel/db";
import { type CliId, CliModelDefaults, effortsFor, type RunnerCli, type TaskModel, type ThreadModel } from "@myrel/protocol";
import { eq } from "drizzle-orm";

/** A project's per-CLI defaults from their JSON column; anything unreadable counts as none. */
export function parseCliModels(raw: string | null | undefined): CliModelDefaults {
  if (!raw) return {};
  try {
    return CliModelDefaults.catch({}).parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function projectCliModels(env: Env, projectId: string): Promise<CliModelDefaults> {
  const [row] = await createDb(env.DB)
    .select({ cliModels: schema.projects.cliModels })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return parseCliModels(row?.cliModels);
}

/**
 * The model and effort a turn runs `cli` with: the thread's pick for that CLI, else the project's
 * default for it, else the CLI's own. Each part falls back on its own, so a thread that only picked
 * an effort keeps the project's model. Only what the CLI lists goes out: a model it no longer has
 * is left to the CLI, and an effort the model does not take is dropped. A CLI that lists no models
 * (or a runner too old to say) gets neither.
 */
export function resolveTaskModel(
  cli: CliId,
  thread: ThreadModel | null | undefined,
  defaults: CliModelDefaults,
  installed: RunnerCli | undefined,
): TaskModel | undefined {
  const models = installed?.models;
  if (!models?.length) return undefined;
  const own = thread?.cli === cli ? thread : null;
  const project = defaults[cli];
  const id = own?.model ?? project?.model ?? null;
  const model = id ? models.find((m) => m.id === id) : undefined;
  const effort = own?.effort ?? project?.effort ?? null;
  const efforts = effortsFor(models, model?.id ?? null);
  const out: TaskModel = {
    ...(model && { model: model.id }),
    ...(effort && efforts.includes(effort) && { effort }),
  };
  return out.model || out.effort ? out : undefined;
}

