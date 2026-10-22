// Builds the sandbox image from sandbox/Dockerfile, pushes it to Cloudflare's registry and pins its
// digest in wrangler.jsonc. Deploys and preview uploads then use that image as is instead of
// building it (Workers Builds starts with no Docker cache, so each build took the whole image again).
// Run it after changing the Dockerfile, with Docker running and wrangler logged in, and commit the
// wrangler.jsonc change:
//   pnpm --filter @myrel/api sandbox:image
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = `${root}wrangler.jsonc`;
const tag = `myrel-sandbox:${Date.now().toString(36)}`;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["inherit", "pipe", "inherit"] }).toString();

console.log(`Building ${tag}`);
execFileSync("docker", ["build", "--platform", "linux/amd64", "--provenance=false", "-t", tag, "sandbox"], {
  cwd: root,
  stdio: "inherit",
});
const pushed = run("pnpm", ["exec", "wrangler", "containers", "push", tag]);
process.stdout.write(pushed);
const remote = pushed.match(/Pushed image: (\S+)/)?.[1];
if (!remote) throw new Error("wrangler did not print the pushed image");
const digests = JSON.parse(run("docker", ["image", "inspect", remote, "--format", "{{json .RepoDigests}}"]));
const image = digests.find((d) => d.startsWith(remote.split(":")[0] + "@sha256:"));
if (!image) throw new Error(`no registry digest for ${remote}`);

const text = readFileSync(config, "utf8");
const pinned = text.replace(/"base": \{ "(?:dockerfile|image)": "[^"]*" \}/, `"base": { "image": "${image}" }`);
if (pinned === text && !text.includes(image)) throw new Error(`could not find images.base in ${config}`);
writeFileSync(config, pinned);
console.log(`Pinned ${image} in wrangler.jsonc`);
