import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { createErrorReporter, isReportable } from "../src/error-report";

describe("app error reports", () => {
  it("leave out lost connections, stopped requests and the server's own answers", () => {
    expect(isReportable(new TypeError("Failed to fetch"))).toBe(false);
    expect(isReportable(new TypeError("Network request failed"))).toBe(false);
    expect(isReportable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isReportable(new ApiError(500, {}))).toBe(false);
    expect(isReportable(new TypeError("x is undefined"))).toBe(true);
    expect(isReportable("boom")).toBe(true);
  });

  it("sends each kind once and at most 20 a session", () => {
    const sent: unknown[] = [];
    const report = createErrorReporter({ platform: "web", send: async (i) => sent.push(i) });
    report(new Error("same"), "/a");
    report(new Error("same"), "/a");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ platform: "web", where: "/a", name: "Error", message: "same" });
    for (let i = 0; i < 30; i++) report(new Error(`e${i}`), "/b");
    expect(sent).toHaveLength(20);
  });
});
