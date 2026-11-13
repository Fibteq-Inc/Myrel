#!/usr/bin/env node
// Downloads the project's approved screenshots (the baseline a person approved from a check's card)
// into a folder, for capture.mjs --baseline. The link comes from visual_check_links.
//
//   node baseline.mjs "<baseline link>" <dir>

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [link, dir] = process.argv.slice(2);
if (!link || !dir) {
  console.error('Usage: node baseline.mjs "<baseline link from visual_check_links>" <dir>');
  process.exit(1);
}
const res = await fetch(link);
if (!res.ok) {
  console.error(`The baseline list could not be read: HTTP ${res.status}`);
  process.exit(1);
}
const { files } = await res.json();
await mkdir(dir, { recursive: true });
let got = 0;
for (const f of files) {
  const file = await fetch(f.url);
  if (!file.ok) continue;
  await writeFile(join(dir, basename(f.name)), Buffer.from(await file.arrayBuffer()));
  got++;
}
console.log(`${got} approved screenshot(s) in ${dir}${files.length ? "" : " (none approved yet: every screen counts as new)"}.`);
