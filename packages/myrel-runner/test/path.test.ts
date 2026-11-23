import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "../src/config";
import { detectClis, type MissingCli, missingReason } from "../src/clis";
import { expandWindowsVars, mergePath, parseRegPath, refreshPath, unixBins } from "../src/path";
import { sameClis } from "../src/runner";

const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myrel-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
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
    // Tasks start the CLI (codex exec or codex app-server alike) with childEnv, so they find it the same way.
    expect(childEnv().PATH).toBe(process.env.PATH);
  });

  it("finds a CLI in its installer's folder that is not on the runner's PATH", async () => {
    const bin = join(home, ".opencode", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 'opencode v2.4.0'\n");
    chmodSync(join(bin, "opencode"), 0o755);
    process.env.PATH = "/usr/bin:/bin";
    expect((await detectClis()).find((c) => c.id === "opencode")).toEqual({ id: "opencode", version: "opencode v2.4.0" });
    // At the end, so what the person put on PATH wins.
    expect(process.env.PATH!.startsWith("/usr/bin:/bin:")).toBe(true);
    expect(unixBins(home)).toContain(bin);
  });

  it("leaves out install folders that do not exist", () => {
    expect(unixBins(home).filter((p) => p.startsWith(home))).toEqual([]);
  });

  it("says why a CLI was not found", async () => {
    process.env.PATH = "/nowhere";
    const missing: MissingCli[] = [];
    await detectClis(missing);
    // Only the runner's Node folder is on PATH now, which has none of the CLIs, and the home folder is empty.
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
