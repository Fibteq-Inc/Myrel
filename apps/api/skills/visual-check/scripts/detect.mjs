// Works out how to start a web app with no config: finds the package with a known framework (the
// repository root or, in a monorepo, a workspace package such as apps/web) and the command that
// starts its dev server on a given port. Falls back to a built or plain static folder.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Framework → how to start its dev server; {port} is replaced with a free port. */
const FRAMEWORKS = [
  { dep: "next", name: "Next.js", start: "npx --no-install next dev -p {port}" },
  { dep: "nuxt", name: "Nuxt", start: "npx --no-install nuxt dev --port {port}" },
  { dep: "astro", name: "Astro", start: "npx --no-install astro dev --port {port}" },
  { dep: "@remix-run/dev", name: "Remix", start: "npx --no-install remix vite:dev --port {port} --strictPort" },
  { dep: "@angular/cli", name: "Angular", start: "npx --no-install ng serve --port {port}" },
  // Expo's web build (react-native-web); CI keeps its dev server from asking questions.
  {
    dep: "expo",
    name: "Expo (web)",
    start: "npx --no-install expo start --web --port {port}",
    env: { CI: "1" },
    needs: ["react-native-web", "react-dom"],
    missing: "This Expo app has no web build to check (react-native-web and react-dom are not its dependencies). Add them with `npx expo install react-native-web react-dom @expo/metro-runtime`, or check it on a device or emulator, which this check does not do yet.",
  },
  { dep: "react-scripts", name: "Create React App", start: "npx --no-install react-scripts start" },
  { dep: "vite", name: "Vite", start: "npx --no-install vite --port {port} --strictPort" },
  { dep: "@rsbuild/core", name: "Rsbuild", start: "npx --no-install rsbuild dev --port {port}" },
  { dep: "parcel", name: "Parcel", start: "npx --no-install parcel index.html --port {port}" },
];

/** An Electron app: launched with its own Electron through Playwright, not served to a browser. */
const ELECTRON = { dep: "electron", name: "Electron" };

/** Folders a monorepo usually keeps its apps in, searched in this order. */
const PLACES = ["", "apps", "packages", "web", "frontend", "client", "site", "app", "src"];
const STATIC = ["dist", "build", "out", "public", "."];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function packageDirs(root) {
  const dirs = [];
  for (const place of PLACES) {
    const base = join(root, place);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    if (existsSync(join(base, "package.json"))) dirs.push(base);
    if (place === "") continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && existsSync(join(base, entry.name, "package.json"))) dirs.push(join(base, entry.name));
    }
  }
  return [...new Set(dirs)];
}

/**
 * The best guess at how to start the app in `root`, or null. Prefers a package whose name or folder
 * says web/site/app/frontend when several match, and says what it found so the report can show it.
 */
export function detectApp(root) {
  const found = [];
  for (const dir of packageDirs(root)) {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // An Electron app is opened as the desktop app it is, even when a bundler builds its pages.
    const fw = deps.electron ? ELECTRON : FRAMEWORKS.find((f) => deps[f.dep]);
    if (!fw) continue;
    const tauri = !!(deps["@tauri-apps/api"] || deps["@tauri-apps/cli"]);
    const label = `${relative(root, dir) || "."} (${fw.name}${tauri ? ", a Tauri app's pages in the browser" : ""})`;
    const score = (/(^|[/-])(web|site|app|frontend|client|www)([/-]|$)/i.test(`${relative(root, dir)} ${pkg.name ?? ""}`) ? 2 : 0) + (dir === root ? 1 : 0);
    const installed = existsSync(join(dir, "node_modules")) || existsSync(join(root, "node_modules"));
    const lacking = (fw.needs ?? []).filter((d) => !deps[d]);
    const main = fw === ELECTRON ? join(dir, pkg.main ?? "index.js") : null;
    const warning = !installed
      ? "Dependencies are not installed: run the project's install command first."
      : lacking.length
        ? fw.missing
        : main && !existsSync(main)
          ? `Its main file ${relative(root, main)} does not exist yet: build the app first (its build script), or set electron.main in .myrel/checks.json.`
          : undefined;
    found.push({ dir, fw, label, score, warning, tauri });
  }
  found.sort((a, b) => b.score - a.score);
  const best = found[0];
  if (best) {
    const detected = `${best.label}${found.length > 1 ? `; also found ${found.slice(1).map((f) => f.label).join(", ")}` : ""}`;
    const warning = best.warning && { warning: best.warning };
    if (best.fw === ELECTRON) return { target: "electron", electron: { main: "." }, cwd: best.dir, detected, ...warning };
    return {
      start: best.fw.start,
      ...(best.fw.env && { startEnv: best.fw.env }),
      cwd: best.dir,
      ready: "/",
      detected,
      ...(best.tauri && { note: "Tauri calls (invoke) fail in a plain browser: mock them in init (window.__TAURI_INTERNALS__) or expect errors from them." }),
      ...warning,
    };
  }
  for (const place of STATIC) {
    const dir = join(root, place);
    if (existsSync(join(dir, "index.html"))) return { serve: dir, detected: `static files in ${relative(root, dir) || "."}` };
  }
  return null;
}
