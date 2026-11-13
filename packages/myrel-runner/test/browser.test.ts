import { RunnerBrowser } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { detectBrowser } from "../src/browser";

describe("detectBrowser", () => {
  it("says whether a visual check's browser can start here, in the shape the hello carries", async () => {
    const browser = await detectBrowser();
    expect(RunnerBrowser.safeParse(browser).success).toBe(true);
    if (process.platform !== "linux") expect(browser.status).toBe("ok");
    if (browser.status === "missing-libs") expect(browser.missing?.length).toBeGreaterThan(0);
  });
});
