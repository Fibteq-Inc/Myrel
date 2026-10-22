import { afterEach, describe, expect, it } from "vitest";
import { childEnv } from "../src/config";

const saved = process.env.MYREL_RUNNER_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.MYREL_RUNNER_TOKEN;
  else process.env.MYREL_RUNNER_TOKEN = saved;
});

describe("childEnv", () => {
  it("keeps the runner's device token out of the processes it starts", () => {
    process.env.MYREL_RUNNER_TOKEN = "sentinel-device-token";
    const env = childEnv({ MCP_TIMEOUT: "10000", MYREL_RUNNER_TOKEN: "from-agent" });
    expect(env.MYREL_RUNNER_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain("sentinel-device-token");
    // Everything else the CLIs need still comes through.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.MCP_TIMEOUT).toBe("10000");
    // The runner keeps its own.
    expect(process.env.MYREL_RUNNER_TOKEN).toBe("sentinel-device-token");
  });
});
