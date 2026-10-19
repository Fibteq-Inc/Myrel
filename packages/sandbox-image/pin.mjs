// Points apps/api/wrangler.jsonc at a sandbox image already in Cloudflare's registry, so deploys
// stop rebuilding it. Run by .github/workflows/sandbox-image.yml after a push:
//   node packages/sandbox-image/pin.mjs registry.cloudflare.com/<account>/altair-sandbox@sha256:<digest>
import { readFileSync, writeFileSync } from "node:fs";

const ref = process.argv[2] ?? "";
if (!/^registry\.cloudflare\.com\/[a-z0-9]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(ref)) {
  console.error(`Expected registry.cloudflare.com/<account>/<repository>@sha256:<digest>, got "${ref}"`);
  process.exit(1);
}
const path = new URL("../../apps/api/wrangler.jsonc", import.meta.url);
const config = readFileSync(path, "utf8");
const runner = /"runner": \{ "(?:dockerfile|image)": "[^"]*" \}/;
if (!runner.test(config)) {
  console.error('apps/api/wrangler.jsonc has no single-line "runner" image entry to replace');
  process.exit(1);
}
writeFileSync(path, config.replace(runner, `"runner": { "image": "${ref}" }`));
console.log(`Pinned the sandbox image to ${ref}`);
