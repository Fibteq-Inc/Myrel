import { describe, expect, it } from "vitest";
import { secretScrubber } from "../src/sandbox/sandbox";

describe("sandbox output", () => {
  it("hides the run's secret values", () => {
    const scrub = secretScrubber({
      FIRST: "placeholder-one-xxxx",
      SECOND: "placeholder-two-xxxx",
      SHORT: "yes",
      MYREL_FILES: JSON.stringify([{ path: "a.txt", url: "https://x.test/f?sig=1" }]),
    });
    const line = JSON.stringify({ type: "text", text: "FIRST=placeholder-one-xxxx SECOND=placeholder-two-xxxx yes" });
    expect(JSON.parse(scrub(line))).toEqual({ type: "text", text: "FIRST=[hidden] SECOND=[hidden] yes" });
    expect(secretScrubber({})("plain")).toBe("plain");
  });
});
