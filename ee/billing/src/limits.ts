import type { Extensions, LimitCheck } from "../../../apps/api/src/extensions";
import { freeBudgetMicros, freeSpendMicros, projectOwner, standingOf, usageOf } from "./store";

const OK: LimitCheck = { ok: true };
const refuse = (reason: string): LimitCheck => ({ ok: false, reason });

const UPGRADE = "Upgrade your plan in Settings > Plan and billing";
const KEY_HINT = "add your own model key in the project's settings";

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

  async canUseSandbox(env, projectId) {
    const project = await projectOwner(env.DB, projectId);
    if (!project) return OK;
    const standing = await standingOf(env, project.owner);
    if (standing.plan === "admin") return OK;
    const usage = await usageOf(env, standing, project.owner);
    const { modelMicros, sandboxSeconds } = standing.limits;
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
    if (standing.plan === "free" && (await freeSpendMicros(env)) >= freeBudgetMicros(env)) {
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
    const usage = await usageOf(env, standing, project.owner);
    const max = standing.limits.modelMicros;
    if (max !== null && usage.modelMicros >= max) {
      return refuse(`This project's plan has used its included model usage this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    if (standing.plan === "free" && (await freeSpendMicros(env)) >= freeBudgetMicros(env)) {
      return refuse(`Free model usage is used up for this month. ${UPGRADE}, or ${KEY_HINT}.`);
    }
    return OK;
  },
};
