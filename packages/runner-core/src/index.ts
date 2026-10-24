import type { Harness } from "./harness";
import { claudeCode } from "./harnesses/claude-code";
import { codex } from "./harnesses/codex";
import { opencode } from "./harnesses/opencode";
import { shell } from "./harnesses/shell";
import type { HarnessId } from "./spec";

export * from "./backend";
export * from "./harness";
export * from "./lines";
export * from "./script";
export * from "./spec";
export * from "./state";
export { claudeCode, codex, opencode, shell };
export { claudeMcpConfig, claudeModel } from "./harnesses/claude-code";
export { codexArgs } from "./harnesses/codex";
export { opencodeConfig, opencodeModel, PLAN_PLUGIN } from "./harnesses/opencode";

export const HARNESSES: Record<HarnessId, Harness> = {
  opencode,
  "claude-code": claudeCode,
  codex,
  shell,
};
