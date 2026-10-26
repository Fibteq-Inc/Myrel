import { describe, expect, it } from "vitest";
import { createId, formatPlan, summarizeThread } from "../src";

const message = (body: string, authorKind: "agent" | "user" = "agent") => ({ id: createId("message"), authorKind, body });

describe("summarizeThread", () => {
  it("counts replies without plan cards and notes, and points at the newest plan card", () => {
    const first = message(formatPlan("Work\n✱ one"));
    const second = message(formatPlan("Work again\n✱ two"));
    const summary = summarizeThread([first, message("hi", "user"), message("done"), second]);
    expect(summary).toEqual({ replies: 2, usage: null, planMessageId: second.id });
  });

  it("leaves a plan-looking message from a person out of the plan card", () => {
    const fromPerson = message(formatPlan("Work\n✱ one"), "user");
    expect(summarizeThread([fromPerson]).planMessageId).toBeNull();
  });
});
