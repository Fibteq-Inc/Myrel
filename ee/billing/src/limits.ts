import type { Extensions, LimitCheck } from "../../../apps/api/src/extensions";
import { DEFAULT_PRICES, parsePrices, priceFor } from "../../../apps/api/src/llm/pricing";
import { userVerified } from "../../../apps/api/src/verification";
import {
  activeSandboxes,
  freeBudgetMicros,
  freeSpendMicros,
  projectOwner,
  SANDBOX_MICROS_PER_SECOND,
  type Standing,
  standingOf,
  unpricedCallMicros,
  usageOf,
} from "./store";

const OK: LimitCheck = { ok: true };
const refuse = (reason: string): LimitCheck => ({ ok: false, reason });

const UPGRADE = "Upgrade your plan in Settings > Plan and billing";
const KEY_HINT = "add your own model key in the project's settings";
/** The service pays for cloud turns and its model keys only on projects whose owner verified their address. */
const UNVERIFIED_OWNER = "The project's owner needs to verify their email address first: open the link Myrel sent them, or send a new one from the banner.";

/**
 * Why a project on the service's key cannot use the model it picked: one with no price would be
 * charged a flat fallback per call, far below what a large model really costs. Null when it can
 * (the server's default model, priced by the model each answer names, or a priced one).
 */
async function unpricedModel(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT llm_model AS model FROM projects WHERE id = ?").bind(projectId).first<{ model: string | null }>();
  if (!row?.model) return null;
  if (priceFor(row.model, { ...DEFAULT_PRICES, ...parsePrices(env.LLM_PRICES) })) return null;
  return `The model ${row.model} has no known price, so it runs only on a model key of the project's own. Pick another model or ${KEY_HINT}.`;
}

/** The hosted service's plan limits, plugged into the core (see apps/api/src/extensions.ts). */
export const billingExtensions: Extensions = {
  billing: true,
  // Fibteq's policies, served by the web app (apps/web/public). Change the version with their effective date.
  legal: { terms: "/terms/", privacy: "/privacy/", version: "2026-10-20" },

  async canCreateProject(env, userId) {
    const standing = await standingOf(env, userId);
    const max = standing.limits.projects;
    if (max === null) return OK;
    const usage = await usageOf(env, standing, userId);
    return usage.projects < max
      ? OK
      : refuse(`Your plan includes ${max} projects. ${UPGRADE}, or delete a project you no longer need.`);
  },

  async canStoreFile(env, projectId, total) {
    const project = await projectOwner(env.DB, projectId);
    if (!project) return OK;
    const standing = await standingOf(env, project.owner);
    const max = standing.limits.storageBytes;
    if (max === null || total <= max) return OK;
    const gb = Math.round(max / 1e8) / 10;
    return refuse(`This project's files can take up to ${gb} GB on its plan. ${UPGRADE}, or delete files it no longer needs.`);
  },

  async canAddConnector(env, owner) {
    const userId = "userId" in owner ? owner.userId : (await projectOwner(env.DB, owner.projectId))?.owner;
    if (!userId) return OK;
    const standing = await standingOf(env, userId);
    const max = standing.limits.connectors;
    if (max === null) return OK;
    const usage = await usageOf(env, standing, userId);
    return usage.connectors < max
      ? OK
      : refuse(`Your plan includes ${max} connectors. ${UPGRADE}, or remove a connector you no longer use.`);
  },

  async canUseSandbox(env, projectId, running) {
    const project = await projectOwner(env.DB, projectId);
    if (!project) return OK;
    const standing = await standingOf(env, project.owner);
    if (standing.plan === "admin") return OK;
    if (!(await userVerified(env, project.owner))) return refuse(UNVERIFIED_OWNER);
    const unpriced = project.ownKey ? null : await unpricedModel(env, projectId);
    if (unpriced) return refuse(unpriced);
    const usage = await usageOf(env, standing, project.owner);
    // A running turn's use is not in the usage tables until it ends.
    const turnMicros = project.ownKey ? 0 : (running?.modelMicros ?? 0) + (running?.unpricedCalls ?? 0) * unpricedCallMicros(env);
    usage.modelMicros += turnMicros;
    usage.sandboxSeconds += running?.seconds ?? 0;
    const { modelMicros, sandboxSeconds, concurrentSandboxes } = standing.limits;
    // Only a new turn waits for the others; a running one is already counted among them.
    if (!running && concurrentSandboxes !== null && (await activeSandboxes(env, standing)) >= concurrentSandboxes) {
      return refuse(
        `Your plan runs ${concurrentSandboxes} cloud ${concurrentSandboxes === 1 ? "turn" : "turns"} at a time and that many are running. ` +
          `Wait for one to finish, upgrade your plan in Settings > Plan and billing, or connect a folder on your computer.`,
      );
    }
    // The cloud agent runs on the service's model key unless the project has its own.
    if (!project.ownKey && modelMicros !== null && usage.modelMicros >= modelMicros) {
      return refuse(`This project's plan has used its included model usage this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    if (sandboxSeconds !== null && usage.sandboxSeconds >= sandboxSeconds) {
      const hours = Math.round(sandboxSeconds / 360) / 10;
      return refuse(
        `This project's plan has used its ${hours} hours of cloud sandbox time this month. ` +
          `${UPGRADE}, or connect a folder on your computer to keep working there.`,
      );
    }
    const turnSpend = turnMicros + (running?.seconds ?? 0) * SANDBOX_MICROS_PER_SECOND;
    if (unpaid(standing) && (await freeSpendMicros(env)) + turnSpend >= freeBudgetMicros(env)) {
      return refuse(`Free cloud sandbox time is used up for this month. ${UPGRADE}, or connect a folder on your computer.`);
    }
    return OK;
  },

  async canUseCoordinator(env, projectId) {
    const project = await projectOwner(env.DB, projectId);
    // A project with its own model key pays for its own coordinator.
    if (!project || project.ownKey) return OK;
    const standing = await standingOf(env, project.owner);
    if (standing.plan === "admin") return OK;
    if (!(await userVerified(env, project.owner))) return refuse(UNVERIFIED_OWNER);
    const unpriced = await unpricedModel(env, projectId);
    if (unpriced) return refuse(unpriced);
    const usage = await usageOf(env, standing, project.owner);
    const max = standing.limits.modelMicros;
    if (max !== null && usage.modelMicros >= max) {
      return refuse(`This project's plan has used its included model usage this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    if (unpaid(standing) && (await freeSpendMicros(env)) >= freeBudgetMicros(env)) {
      return refuse(`Free model usage is used up for this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    return OK;
  },
};

/**
 * Free plans and trials (no card asked) draw on the same monthly budget, so a stream of new
 * accounts trying Pro cannot spend more than free use may.
 */
function unpaid(standing: Standing): boolean {
  return standing.plan === "free" || standing.subscription?.status === "trialing";
}
