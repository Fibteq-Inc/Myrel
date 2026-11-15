import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { RunnerBrowser } from "@myrel/protocol";

const run = promisify(execFile);

/**
 * The shared libraries headless Chromium needs on Linux (what `playwright install-deps chromium`
 * installs), by the name the dynamic linker knows them. macOS and Windows need nothing: Playwright
 * downloads its own Chromium there on first use.
 */
const CHROMIUM_LIBS = [
  "libnss3.so",
  "libnspr4.so",
  "libatk-1.0.so.0",
  "libatk-bridge-2.0.so.0",
  "libcups.so.2",
  "libdrm.so.2",
  "libxkbcommon.so.0",
  "libXcomposite.so.1",
  "libXdamage.so.1",
  "libXfixes.so.3",
  "libXrandr.so.2",
  "libgbm.so.1",
  "libpango-1.0.so.0",
  "libcairo.so.2",
  "libasound.so.2",
];

/**
 * Whether a visual check's browser can start on this computer, so the web app can say what to run
 * once instead of a check failing later. Only Linux can lack something; "unknown" when the linker
 * cache cannot be read.
 */
export async function detectBrowser(): Promise<RunnerBrowser> {
  if (platform() !== "linux") return { status: "ok" };
  let cache: string;
  try {
    cache = (await run("ldconfig", ["-p"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    try {
      cache = (await run("/sbin/ldconfig", ["-p"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch {
      return { status: "unknown" };
    }
  }
  const missing = CHROMIUM_LIBS.filter((lib) => !cache.includes(lib));
  return missing.length ? { status: "missing-libs", missing } : { status: "ok" };
}
