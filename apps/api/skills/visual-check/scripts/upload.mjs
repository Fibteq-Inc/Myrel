#!/usr/bin/env node
// Uploads a check's results to the project files in one go, through the folder link Myrel gives the
// evaluator (visual_check_links): report.json, verdict.json, summary.md, the screenshots, contact
// sheets, marked screenshots and diffs. Frames and the server log stay on the computer.
//
//   node upload.mjs <out> "<upload link>"

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const [dir, link] = process.argv.slice(2);
if (!dir || !link) {
  console.error('Usage: node upload.mjs <out> "<upload link from visual_check_links>"');
  process.exit(1);
}
const TYPES = { ".json": "application/json", ".md": "text/markdown", ".png": "image/png" };
const top = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && TYPES[extname(e.name)] && e.name !== "probe.png").map((e) => e.name);
const marked = await readdir(join(dir, "annotated")).then((names) => names.filter((n) => n.endsWith(".png")).map((n) => `annotated/${n}`), () => []);
const files = [...top, ...marked];

let failed = 0;
const queue = [...files];
async function worker() {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const url = `${link}${link.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { method: "PUT", body: await readFile(join(dir, name)), headers: { "content-type": TYPES[extname(name)] } }).catch((err) => ({ ok: false, status: err.message }));
    if (!res.ok) {
      failed++;
      console.error(`failed ${name}: ${res.status}`);
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`Uploaded ${files.length - failed} of ${files.length} file(s).`);
process.exit(failed ? 1 : 0);
