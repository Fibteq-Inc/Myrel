// Builds packages/altair-runner into one self-contained executable per target with `bun build --compile`
// and puts it where Tauri expects the sidecar: src-tauri/binaries/altair-runner-<target triple>[.exe].
// Tauri runs this before `tauri dev` and `tauri build` (TAURI_ENV_TARGET_TRIPLE names the target).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = `${root}packages/altair-runner/dist/cli.js`;
const outDir = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));

const BUN_TARGETS = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /^host: (\S+)$/m.exec(out)[1];
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const exe = triple.includes("windows") ? ".exe" : "";
const out = `${outDir}altair-runner-${triple}${exe}`;

run("pnpm", ["--filter", "@fibteq/altair-runner", "build"]);

try {
  execFileSync("bun", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
} catch {
  console.error("Building the bundled altair-runner needs Bun (https://bun.sh): npm install -g bun");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const compile = (target, outfile) =>
  run("bun", ["build", "--compile", "--minify", `--target=${target}`, cli, "--outfile", outfile]);

if (triple === "universal-apple-darwin") {
  const parts = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((t) => {
    const part = `${outDir}altair-runner-${t}`;
    compile(BUN_TARGETS[t], part);
    return part;
  });
  run("lipo", ["-create", "-output", out, ...parts]);
} else {
  const target = BUN_TARGETS[triple];
  if (!target) {
    console.error(`No altair-runner build for ${triple}`);
    process.exit(1);
  }
  compile(target, out);
}
