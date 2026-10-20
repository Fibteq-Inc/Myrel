import type { Extensions, LimitCheck } from "../../../apps/api/src/extensions";
import { freeBudgetMicros, freeSpendMicros, projectOwner, standingOf, usageOf } from "./store";

const OK: LimitCheck = { ok: true };
const refuse = (reason: string): LimitCheck => ({ ok: false, reason });

const UPGRADE = "Upgrade your plan in Settings > Plan and billing";
const KEY_HINT = "add your own model key in the project's settings";

/** The hosted service's plan limits, plugged into the core (see apps/api/src/extensions.ts). */
export const billingExtensions: Extensions = {
  billing: true,

  async canCreateProject(env, userId) {
    const standing = await standingOf(env.DB, userId);
    const max = standing.limits.projects;
    if (max === null) return OK;
    const usage = await usageOf(env, standing, userId);
    return usage.projects < max
      ? OK
      : refuse(`Your plan includes ${max} projects. ${UPGRADE}, or delete a project you no longer need.`);
  },

  async canUseSandbox(env, projectId) {
    const project = await projectOwner(env.DB, projectId);
    if (!project) return OK;
    const standing = await standingOf(env.DB, project.owner);
    const usage = await usageOf(env, standing, project.owner);
    // The cloud agent runs on the service's model key unless the project has its own.
    if (!project.ownKey && usage.modelMicros >= standing.limits.modelMicros) {
      return refuse(`This project's plan has used its included model usage this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    if (usage.sandboxSeconds >= standing.limits.sandboxSeconds) {
      const hours = Math.round(standing.limits.sandboxSeconds / 360) / 10;
      return refuse(
        `This project's plan has used its ${hours} hours of cloud sandbox time this month. ` +
          `${UPGRADE}, or connect a folder on your computer to keep working there.`,
      );
    }
    if (standing.plan === "free" && (await freeSpendMicros(env)) >= freeBudgetMicros(env)) {
      return refuse(`Free cloud sandbox time is used up for this month. ${UPGRADE}, or connect a folder on your computer.`);
    }
    return OK;
  },

  async canUseCoordinator(env, projectId) {
    const project = await projectOwner(env.DB, projectId);
    // A project with its own model key pays for its own coordinator.
    if (!project || project.ownKey) return OK;
    const standing = await standingOf(env.DB, project.owner);
    const usage = await usageOf(env, standing, project.owner);
    if (usage.modelMicros >= standing.limits.modelMicros) {
      return refuse(`This project's plan has used its included model usage this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    if (standing.plan === "free" && (await freeSpendMicros(env)) >= freeBudgetMicros(env)) {
      return refuse(`Free model usage is used up for this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    return OK;
  },
};
