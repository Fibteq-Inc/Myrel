import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectClis, type MissingCli, missingReason } from "../src/clis";
import { expandWindowsVars, mergePath, parseRegPath, refreshPath } from "../src/path";
import { sameClis } from "../src/runner";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

describe("mergePath", () => {
  it("adds only the missing folders, after the ones already there", () => {
    expect(mergePath("/usr/bin:/bin", ["/bin", "/opt/node/bin", " ", "/opt/node/bin"], ":")).toBe("/usr/bin:/bin:/opt/node/bin");
  });

  it("compares Windows folders without case or a trailing slash", () => {
    const current = "C:\\Windows\\system32;C:\\Users\\i\\AppData\\Roaming\\npm\\";
    const merged = mergePath(current, ["c:\\users\\I\\appdata\\roaming\\npm", "C:\\Users\\i\\.local\\bin"], ";", true);
    expect(merged).toBe(`${current};C:\\Users\\i\\.local\\bin`);
  });
});

describe("Windows registry PATH", () => {
  it("reads the Path value from reg query", () => {
    const out = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs\\",
      "",
    ].join("\r\n");
    expect(parseRegPath(out)).toBe("%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs\\");
    expect(parseRegPath("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
  });

  it("expands %NAME% without case and leaves unknown names", () => {
    expect(expandWindowsVars("%UserProfile%\\bin;%NOPE%\\x", { USERPROFILE: "C:\\Users\\i" })).toBe("C:\\Users\\i\\bin;%NOPE%\\x");
  });
});

describe("CLI detection", () => {
  it("puts the runner's own Node folder on PATH, where npm's global CLIs live under fnm and nvm", async () => {
    process.env.PATH = "/nowhere";
    await refreshPath();
    expect(process.env.PATH.split(":")).toContain(dirname(process.execPath));
  });

  it("says why a CLI was not found", async () => {
    process.env.PATH = "/nowhere";
    const missing: MissingCli[] = [];
    await detectClis(missing);
    // Only the runner's Node folder is on PATH now, which has none of the CLIs.
    expect(missing.find((m) => m.id === "codex")?.reason).toBe("not on PATH");
    expect(missingReason(Object.assign(new Error("Command failed"), { killed: true }))).toMatch(/^no answer in \d+s$/);
    expect(missingReason(new Error("Command failed: codex --version"), "'codex' is not recognized as an internal or external command,\r\n")).toBe(
      "'codex' is not recognized as an internal or external command,",
    );
  });

  it("notices when the CLIs or their versions changed", () => {
    const codex = { id: "codex" as const, version: "codex-cli 0.50.0" };
    expect(sameClis([codex], [{ ...codex, models: [] }])).toBe(true);
    expect(sameClis([codex], [{ ...codex, version: "codex-cli 0.51.0" }])).toBe(false);
    expect(sameClis([], [codex])).toBe(false);
  });
});
