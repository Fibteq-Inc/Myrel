import { describe, expect, it } from "vitest";
import { exitMessage } from "../src/tasks";

describe("exitMessage", () => {
  it("names running out of memory for a SIGKILL, without the CLI's output", () => {
    const text = exitMessage("claude", null, "SIGKILL", '{"type":"system","subtype":"init"}');
    expect(text).toContain("ran out of memory");
    expect(text).not.toContain("subtype");
  });

  it("keeps the exit code or signal and the detail otherwise", () => {
    expect(exitMessage("codex", 1, null, "boom")).toBe("codex exited with code 1.\nboom");
    expect(exitMessage("codex", null, "SIGTERM", "")).toBe("codex exited with SIGTERM.\n");
  });
});
