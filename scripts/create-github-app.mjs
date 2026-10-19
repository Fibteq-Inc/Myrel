#!/usr/bin/env node
// Creates the GitHub App an Altair server needs (GitHub's manifest flow) from your own browser.
//
//   node scripts/create-github-app.mjs [--origin https://altair.example.com] [--org my-org] [--port 8765]
//
// It serves a page on http://localhost:<port>. You click "Create on GitHub", confirm on GitHub,
// and GitHub sends you back here; the page then shows the six Worker secrets to add
// (see apps/api/src/github/README.md). No dependencies; Node 18+.
import { createServer } from "node:http";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const port = Number(args.port ?? 8765);
const local = `http://localhost:${port}`;
const defaults = { origin: args.origin ?? "https://altair.fibteq.io", org: args.org ?? "Fibteq-Inc", name: args.name ?? "Fibteq Altair" };

// Must match apps/api/src/github/README.md and src/routes/github.ts.
function manifest(origin, name, isPublic) {
  return {
    name,
    url: origin,
    hook_attributes: { url: `${origin}/api/github/webhook`, active: true },
    redirect_url: `${local}/callback`,
    callback_urls: [`${origin}/api/github/callback`],
    request_oauth_on_install: true,
    setup_on_update: true,
    public: isPublic,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" },
    default_events: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "push", "check_run", "repository"],
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Altair GitHub App</title><style>
:root{--bg:#f6f7fb;--panel:#fff;--fg:#17181f;--muted:#5d6070;--line:#dfe1ea;--accent:#3b4fd8;--accent-fg:#fff;--ok:#137a4b;--bad:#b42318;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--panel:#15161a;--fg:#ececee;--muted:#a1a1aa;--line:#2a2a30;--accent:#8b9bff;--accent-fg:#0e0e10;--ok:#4fcb8d;--bad:#ff7b72;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:40px 16px}
main{max-width:680px;margin:0 auto;display:grid;gap:18px}h1{font-size:22px;margin:0}p{margin:0}.muted{color:var(--muted);font-size:13.5px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px}
label{display:grid;gap:5px;font-size:13.5px;font-weight:600}label span{font-weight:400;color:var(--muted)}
input[type=text],input[type=url]{width:100%;height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button{height:38px;padding:0 14px;border-radius:8px;border:0;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;justify-self:start}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);height:30px;font-size:13px;font-weight:500}
.ok{color:var(--ok);font-weight:600}.err{color:var(--bad)}table{width:100%;border-collapse:collapse;font-size:13px}
td{border-top:1px solid var(--line);padding:8px 6px}td.v{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}pre{margin:0;overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12.5px}
</style></head><body><main><div><h1>Altair GitHub App</h1><p class="muted">Creates the GitHub App your Altair server needs, with every address, permission and event filled in.</p></div>${body}</main></body></html>`;

function formPage() {
  return page(`<section><form id="f" style="display:grid;gap:12px">
<label>Altair address <span>The public address of your Altair server.</span><input id="origin" type="url" required value="${esc(defaults.origin)}"></label>
<label>GitHub organization <span>Empty = your personal account.</span><input id="org" type="text" value="${esc(defaults.org)}"></label>
<label>App name <span>Must be unique on GitHub.</span><input id="name" type="text" required value="${esc(defaults.name)}"></label>
<label style="display:flex;gap:8px;font-weight:400"><input id="pub" type="checkbox"> Anyone can install it (people outside this account will connect repositories)</label>
<button type="submit">Create on GitHub</button></form>
<p class="muted">GitHub asks you to confirm, creates the app and sends you back to this page with its keys.</p></section>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value.trim();
  const q = new URLSearchParams({ origin: v("origin"), name: v("name"), public: String(document.getElementById("pub").checked) });
  const m = await (await fetch("/manifest?" + q)).json();
  const form = document.createElement("form");
  form.method = "post";
  form.action = v("org") ? "https://github.com/organizations/" + encodeURIComponent(v("org")) + "/settings/apps/new" : "https://github.com/settings/apps/new";
  const input = document.createElement("input");
  input.type = "hidden"; input.name = "manifest"; input.value = JSON.stringify(m);
  form.append(input); document.body.append(form); form.submit();
});
</script>`);
}

function secretsPage(app) {
  const secrets = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_SLUG: app.slug,
    GITHUB_CLIENT_ID: app.client_id,
    GITHUB_CLIENT_SECRET: app.client_secret,
    GITHUB_WEBHOOK_SECRET: app.webhook_secret ?? "",
    GITHUB_APP_PRIVATE_KEY: app.pem,
  };
  const rows = Object.entries(secrets)
    .map(
      ([k, v]) =>
        `<tr><td><code>${k}</code></td><td class="v">${esc(k === "GITHUB_APP_PRIVATE_KEY" ? "-----BEGIN RSA PRIVATE KEY----- …" : v)}</td>` +
        `<td><button class="ghost" data-v="${esc(v)}">Copy</button></td></tr>`,
    )
    .join("");
  return page(`<section><p class="ok">The app ${esc(app.slug)} was created. These keys are shown only now.</p>
<p class="muted">Add each one in Cloudflare as a secret: Workers &amp; Pages → altair → Settings → Variables and Secrets → Add, type <b>Secret</b>. Then redeploy.</p>
<div style="overflow-x:auto"><table>${rows}</table></div>
<p class="muted">Then connect repositories from a project's settings in Altair. <a href="${esc(app.html_url)}" target="_blank" rel="noreferrer">Open the app on GitHub</a></p></section>
<script>
for (const b of document.querySelectorAll("button[data-v]")) b.addEventListener("click", () =>
  navigator.clipboard.writeText(b.dataset.v).then(() => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); }, () => (b.textContent = "Copy failed")));
</script>`);
}

createServer(async (req, res) => {
  const url = new URL(req.url, local);
  const send = (status, body, type = "text/html; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  if (url.pathname === "/") return send(200, formPage());
  if (url.pathname === "/manifest") {
    let origin;
    try {
      origin = new URL(url.searchParams.get("origin")).origin;
    } catch {
      return send(400, "{}", "application/json");
    }
    return send(200, JSON.stringify(manifest(origin, url.searchParams.get("name") || "Altair", url.searchParams.get("public") === "true")), "application/json");
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code") ?? "";
    if (!/^[\w-]{1,100}$/.test(code)) return send(400, page(`<section><p class="err">GitHub did not send a code. Start again from <a href="/">the first page</a>.</p></section>`));
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "altair-setup" },
    });
    if (!r.ok) return send(400, page(`<section><p class="err">GitHub did not accept the code (${r.status}). It works once and expires after an hour. <a href="/">Start again</a>.</p></section>`));
    const app = await r.json();
    console.log(`Created the GitHub App ${app.slug}. Its keys are on the page; this script can be stopped once you have copied them.`);
    return send(200, secretsPage(app));
  }
  send(404, "Not found", "text/plain");
}).listen(port, "127.0.0.1", () => {
  console.log(`Open ${local} in your browser to create the Altair GitHub App.`);
});
