import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The runner looks for CLIs under the home folder too (see unixBins): an empty one keeps the CLIs
// installed on the computer that runs the tests out of them.
const saved = { HOME: process.env.HOME, PNPM_HOME: process.env.PNPM_HOME };
const home = mkdtempSync(join(tmpdir(), "myrel-test-home-"));
process.env.HOME = home;
delete process.env.PNPM_HOME;

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
