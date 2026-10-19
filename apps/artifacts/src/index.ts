import { artifactObjectKey } from "@altair/protocol";
import { verifyArtifact } from "@altair/protocol/artifact-signature";

/** Origins the Altair desktop app serves its UI from (see apps/api/src/origins.ts). */
const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/** CDNs an artifact may load scripts, styles and data from. Everything else is inline. */
const CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://esm.sh"];

const PATH = /^\/(art_[0-9A-HJKMNP-TV-Z]{26})\/v([1-9][0-9]{0,8})\/?$/;

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("Method not allowed", 405, { allow: "GET, HEAD" });
    }
    const url = new URL(request.url);
    if (url.pathname === "/") return text("Altair artifacts", 200);

    const match = PATH.exec(url.pathname);
    if (!match) return text("Not found", 404);
    const [, artifactId, v] = match as unknown as [string, string, string];
    const version = Number(v);

    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!env.ARTIFACT_SIGNING_SECRET || !(await verifyArtifact(env.ARTIFACT_SIGNING_SECRET, artifactId, version, exp, sig))) {
      return text("This link has expired. Open the artifact again from Altair.", 403);
    }

    const object = await env.ARTIFACTS.get(artifactObjectKey(artifactId, version));
    if (!object) return text("Not found", 404);

    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": contentSecurityPolicy(env),
        "x-content-type-options": "nosniff",
        // The signature is in the URL; never leak it to the pages an artifact links to.
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "cross-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), display-capture=()",
        // A version never changes, but the link expires; keep it out of shared caches.
        "cache-control": "private, max-age=300",
        etag: object.httpEtag,
      },
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Artifacts are untrusted HTML. `sandbox` without allow-same-origin gives the page an
 * opaque origin even when opened in its own tab, so it cannot keep cookies or storage
 * on this domain; the app frames it with the same sandbox flags.
 */
export function contentSecurityPolicy(env: Pick<Env, "APP_ORIGINS">): string {
  const app = env.APP_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const ancestors = app.length ? [...app, ...DESKTOP_ORIGINS].join(" ") : "*";
  const cdns = CDNS.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${cdns} https://cdn.tailwindcss.com https://code.jquery.com`,
    `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
    `font-src data: ${cdns} https://fonts.gstatic.com`,
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    `connect-src ${cdns}`,
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  ].join("; ");
}

function text(body: string, status: number, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  });
}
