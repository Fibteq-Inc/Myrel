import { describe, expect, it } from "vitest";
import { parseReviewModels, resolveReviewModel } from "../src/task-model";

describe("the model that judges a CLI's commands", () => {
  const installed = { id: "opencode" as const, version: "2.4.0", models: [{ id: "zai/big", name: "Big", efforts: [] }, { id: "zai/fast", name: "Fast", efforts: [] }] };
  const project = (reviewModel: string | null) => ({ opencode: { model: null, effort: null, reviewModel } });

  it("is the project's pick, else the person's, else none, and only one the CLI lists", () => {
    expect(resolveReviewModel("opencode", project("zai/big"), { opencode: "zai/fast" }, installed)).toBe("zai/big");
    expect(resolveReviewModel("opencode", project(null), { opencode: "zai/fast" }, installed)).toBe("zai/fast");
    expect(resolveReviewModel("opencode", project("gone/model"), { opencode: "zai/fast" }, installed)).toBe("zai/fast");
    expect(resolveReviewModel("opencode", {}, {}, installed)).toBeUndefined();
    expect(resolveReviewModel("opencode", {}, { opencode: "gone/model" }, installed)).toBeUndefined();
    expect(resolveReviewModel("opencode", {}, { opencode: "zai/fast" }, undefined)).toBeUndefined();
  });

  it("is only for CLIs that have no reviewer of their own", () => {
    expect(resolveReviewModel("codex", {}, { codex: "zai/fast" }, { ...installed, id: "codex" })).toBeUndefined();
  });

  it("reads anything unreadable as none", () => {
    expect(parseReviewModels("{")).toEqual({});
    expect(parseReviewModels('{"opencode":""}')).toEqual({});
    expect(parseReviewModels('{"opencode":"zai/fast"}')).toEqual({ opencode: "zai/fast" });
  });
});
