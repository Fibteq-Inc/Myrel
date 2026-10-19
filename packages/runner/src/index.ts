import type { Harness } from "./harness";
import { claudeCode } from "./harnesses/claude-code";
import { opencode } from "./harnesses/opencode";
import { shell } from "./harnesses/shell";
import type { HarnessId } from "./spec";

export * from "./backend";
export * from "./harness";
export * from "./lines";
export * from "./script";
export * from "./spec";
export * from "./state";
export { claudeCode, opencode, shell };
export { opencodeConfig, opencodeModel } from "./harnesses/opencode";

export const HARNESSES: Record<HarnessId, Harness> = {
  opencode,
  "claude-code": claudeCode,
  shell,
};
