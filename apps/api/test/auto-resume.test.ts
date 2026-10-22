import { describe, expect, it } from "vitest";
import { decideResume, MAX_AUTO_RESUMES } from "../src/agents/auto-resume";

describe("decideResume", () => {
  it("continues with growing waits until the budget is used", () => {
    let state = null;
    const delays: number[] = [];
    for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
      const d = decideResume({ state, progressed: true, flapping: false, agent: true });
      if (!d.resume) throw new Error("expected a continue");
      delays.push(d.delaySec);
      state = d.state;
    }
    expect(delays).toEqual([30, 120, 480]);
    expect(decideResume({ state, progressed: true, flapping: false, agent: true })).toEqual({ resume: false, reason: "limit" });
  });

  it("counts a run without progress twice and never continues a flapping runner or a plain task", () => {
    const once = decideResume({ state: null, progressed: false, flapping: false, agent: true });
    expect(once).toMatchObject({ resume: true, state: { resumes: 1, cost: 2 } });
    if (!once.resume) return;
    expect(decideResume({ state: once.state, progressed: false, flapping: false, agent: true })).toMatchObject({ resume: false, reason: "limit" });
    expect(decideResume({ state: null, progressed: true, flapping: true, agent: true })).toEqual({ resume: false, reason: "flapping" });
    expect(decideResume({ state: null, progressed: true, flapping: false, agent: false })).toEqual({ resume: false, reason: "not-agent" });
  });
});
